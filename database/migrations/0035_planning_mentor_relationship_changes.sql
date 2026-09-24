-- GAP-005-B3: ordinary-week self-service planning-mentor relationship changes.
-- This is intentionally separate from the group-leader transition ledger: the
-- actor, eligibility, relationship direction, and allocation key are different.

ALTER TABLE person_relationship
  ADD COLUMN superseded_by_planning_mentor_change_id uuid;

ALTER TABLE person_relationship
  DROP CONSTRAINT person_relationship_supersession_pair;
ALTER TABLE person_relationship
  ADD CONSTRAINT person_relationship_supersession_pair CHECK (
    (superseded_at IS NULL
      AND superseded_by_change_id IS NULL
      AND superseded_by_planning_mentor_change_id IS NULL)
    OR
    (superseded_at IS NOT NULL
      AND ((superseded_by_change_id IS NOT NULL)::integer
           + (superseded_by_planning_mentor_change_id IS NOT NULL)::integer = 1))
  );

CREATE TABLE planning_mentor_relationship_change_preview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('ADD','REMOVE')),
  mentor_person_id uuid NOT NULL REFERENCES person(id),
  planner_person_id uuid NOT NULL REFERENCES person(id),
  source_relationship_id uuid REFERENCES person_relationship(id),
  result_relationship_id uuid,
  actor_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  effective_teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  effective_at timestamptz NOT NULL,
  next_boundary_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  base_hash text NOT NULL CHECK (base_hash ~ '^[0-9a-f]{64}$'),
  impact_json jsonb NOT NULL CHECK (jsonb_typeof(impact_json) = 'object'),
  created_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code = 'PLANNING_MENTOR'),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'SELF'),
  created_at timestamptz NOT NULL,
  CHECK (mentor_person_id <> planner_person_id),
  CHECK ((action = 'ADD' AND source_relationship_id IS NULL AND result_relationship_id IS NOT NULL)
      OR (action = 'REMOVE' AND source_relationship_id IS NOT NULL AND result_relationship_id IS NULL)),
  CHECK (next_boundary_at IS NULL OR next_boundary_at > effective_at)
);

CREATE TABLE planning_mentor_relationship_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id uuid NOT NULL UNIQUE REFERENCES planning_mentor_relationship_change_preview(id),
  action text NOT NULL CHECK (action IN ('ADD','REMOVE')),
  mentor_person_id uuid NOT NULL REFERENCES person(id),
  planner_person_id uuid NOT NULL REFERENCES person(id),
  relationship_version bigint NOT NULL CHECK (relationship_version > 0),
  source_relationship_id uuid REFERENCES person_relationship(id),
  result_relationship_id uuid UNIQUE REFERENCES person_relationship(id),
  actor_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  effective_teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  effective_at timestamptz NOT NULL,
  next_boundary_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  base_hash text NOT NULL CHECK (base_hash ~ '^[0-9a-f]{64}$'),
  posting_status text NOT NULL CHECK (posting_status IN ('POSTED','NO_BALANCE_CHANGE')),
  settlement_calculation_run_id uuid UNIQUE REFERENCES settlement_calculation_run(id),
  ledger_event_id uuid UNIQUE REFERENCES ledger_event(id),
  considered_fee_count integer NOT NULL CHECK (considered_fee_count >= 0),
  changed_fee_count integer NOT NULL CHECK (changed_fee_count >= 0 AND changed_fee_count <= considered_fee_count),
  excluded_refund_count integer NOT NULL CHECK (excluded_refund_count >= 0),
  planner_delta_cents bigint NOT NULL,
  mentor_delta_cents bigint NOT NULL,
  before_json jsonb CHECK (before_json IS NULL OR jsonb_typeof(before_json) = 'object'),
  after_json jsonb CHECK (after_json IS NULL OR jsonb_typeof(after_json) = 'object'),
  published_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code = 'PLANNING_MENTOR'),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'SELF'),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (planner_person_id, relationship_version),
  UNIQUE (published_by_person_id, idempotency_key),
  CHECK ((action = 'ADD' AND source_relationship_id IS NULL AND result_relationship_id IS NOT NULL)
      OR (action = 'REMOVE' AND source_relationship_id IS NOT NULL AND result_relationship_id IS NULL)),
  CHECK ((action = 'ADD' AND before_json IS NULL AND after_json IS NOT NULL)
      OR (action = 'REMOVE' AND before_json IS NOT NULL AND after_json IS NULL)),
  CHECK (next_boundary_at IS NULL OR next_boundary_at > effective_at),
  CHECK (published_at = created_at),
  CHECK ((posting_status = 'POSTED' AND settlement_calculation_run_id IS NOT NULL AND ledger_event_id IS NOT NULL)
      OR (posting_status = 'NO_BALANCE_CHANGE' AND settlement_calculation_run_id IS NULL AND ledger_event_id IS NULL))
);

ALTER TABLE person_relationship
  ADD CONSTRAINT person_relationship_superseded_planning_mentor_change_fk
  FOREIGN KEY (superseded_by_planning_mentor_change_id)
  REFERENCES planning_mentor_relationship_change(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE planning_mentor_relationship_change_effect (
  change_id uuid NOT NULL REFERENCES planning_mentor_relationship_change(id),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  source_weekly_fee_version bigint NOT NULL CHECK (source_weekly_fee_version > 0),
  teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  settlement_month date NOT NULL,
  previous_snapshot_id uuid NOT NULL REFERENCES weekly_fee_allocation_snapshot(id),
  result_snapshot_id uuid NOT NULL UNIQUE REFERENCES weekly_fee_allocation_snapshot(id),
  settlement_calculation_run_id uuid NOT NULL REFERENCES settlement_calculation_run(id),
  planner_before_cents bigint NOT NULL,
  planner_after_cents bigint NOT NULL,
  mentor_before_cents bigint NOT NULL,
  mentor_after_cents bigint NOT NULL,
  delta_json jsonb NOT NULL CHECK (jsonb_typeof(delta_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (change_id, weekly_fee_entry_id),
  FOREIGN KEY (weekly_fee_entry_id, source_weekly_fee_version)
    REFERENCES weekly_fee_entry_version(weekly_fee_entry_id, version)
);

CREATE FUNCTION refuse_planning_mentor_relationship_change_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_IMMUTABLE'; END;
$$;

CREATE FUNCTION assert_planning_mentor_preview_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fee_count integer; change_count integer; unchanged_count integer; refunded_count integer;
BEGIN
  IF jsonb_typeof(NEW.impact_json) IS DISTINCT FROM 'object'
     OR NEW.impact_json->>'schemaVersion' IS DISTINCT FROM 'planning-mentor-relationship-preview.v1'
     OR NEW.impact_json->>'action' IS DISTINCT FROM NEW.action
     OR NEW.impact_json->>'mentorPersonId' IS DISTINCT FROM NEW.mentor_person_id::text
     OR NEW.impact_json->>'plannerPersonId' IS DISTINCT FROM NEW.planner_person_id::text
     OR (NEW.action='ADD' AND NEW.impact_json->'resultRelationshipId' IS DISTINCT FROM to_jsonb(NEW.result_relationship_id::text))
     OR (NEW.action='REMOVE' AND NEW.impact_json->'resultRelationshipId' IS DISTINCT FROM 'null'::jsonb)
     OR jsonb_typeof(NEW.impact_json->'fees') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.impact_json->'totals') IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.impact_json->'totals'))<>6
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.impact_json->'totals') total_key
                 WHERE total_key NOT IN ('consideredFeeCount','changedFeeCount','zeroShareFeeCount','excludedRefundCount','plannerDeltaCents','mentorDeltaCents'))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['consideredFeeCount','changedFeeCount','zeroShareFeeCount','excludedRefundCount','plannerDeltaCents','mentorDeltaCents']) total_key
                 WHERE (NEW.impact_json->'totals' ? total_key) IS DISTINCT FROM true)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['consideredFeeCount','changedFeeCount','zeroShareFeeCount','excludedRefundCount']) total_key
                 WHERE NEW.impact_json#>>ARRAY['totals',total_key] IS NULL OR NEW.impact_json#>>ARRAY['totals',total_key] !~ '^[0-9]+$')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['plannerDeltaCents','mentorDeltaCents']) total_key
                 WHERE NEW.impact_json#>>ARRAY['totals',total_key] IS NULL OR NEW.impact_json#>>ARRAY['totals',total_key] !~ '^-?[0-9]+$')
  THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_PREVIEW_INVALID'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.impact_json->'fees') fee
       WHERE jsonb_typeof(fee) IS DISTINCT FROM 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(fee))<>11
          OR NOT (fee ?& ARRAY['feeId','version','teachingWeekId','settlementMonth','refundId','snapshotId','sequenceNo','snapshotHash','policyVersionId','netMonthlyCents','disposition'])
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(fee) fee_key
                      WHERE fee_key NOT IN ('feeId','version','teachingWeekId','settlementMonth','refundId','snapshotId','sequenceNo','snapshotHash','policyVersionId','netMonthlyCents','disposition'))
          OR fee->>'feeId' IS NULL OR fee->>'feeId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR fee->>'version' IS NULL OR fee->>'version' !~ '^[1-9][0-9]*$'
          OR fee->>'disposition' IS NULL OR fee->>'disposition' NOT IN ('CHANGE','UNCHANGED','REFUNDED')
          OR (fee->>'disposition'='REFUNDED' AND (fee->>'refundId' IS NULL OR fee->>'snapshotId' IS NOT NULL OR fee->>'sequenceNo' IS NOT NULL OR fee->>'snapshotHash' IS NOT NULL OR fee->>'policyVersionId' IS NOT NULL OR fee->>'netMonthlyCents' IS NOT NULL))
          OR (fee->>'disposition'='REFUNDED' AND NOT EXISTS (SELECT 1 FROM weekly_fee_refund_effect refund
                WHERE refund.weekly_fee_entry_id=(fee->>'feeId')::uuid AND refund.finance_document_id::text=fee->>'refundId'))
          OR (fee->>'disposition'<>'REFUNDED' AND (fee->>'refundId' IS NOT NULL OR fee->>'snapshotId' IS NULL OR fee->>'sequenceNo' IS NULL OR fee->>'snapshotHash' IS NULL OR fee->>'snapshotHash' !~ '^[0-9a-f]{64}$' OR fee->>'policyVersionId' IS NULL OR fee->>'netMonthlyCents' IS NULL OR fee->>'netMonthlyCents' !~ '^-?[0-9]+$')))
     OR (SELECT count(*) FROM jsonb_array_elements(NEW.impact_json->'fees'))<>(SELECT count(DISTINCT fee->>'feeId') FROM jsonb_array_elements(NEW.impact_json->'fees') fee)
     OR EXISTS (
       SELECT 1 FROM weekly_fee_entry entry
       JOIN referral_case referral ON referral.id=entry.referral_case_id
       JOIN teaching_week fee_week ON fee_week.id=entry.teaching_week_id
        WHERE referral.referrer_person_id=NEW.planner_person_id AND referral.referrer_identity='ACADEMIC_PLANNER'
          AND fee_week.week_kind='REGULAR'
          AND (fee_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=NEW.effective_at
          AND (NEW.next_boundary_at IS NULL OR (fee_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<NEW.next_boundary_at)
          AND COALESCE((SELECT source_subject FROM referral_creation_snapshot source WHERE source.referral_case_id=referral.id),'')<>'PLANNING_MENTOR'
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.impact_json->'fees') fee WHERE fee->>'feeId'=entry.id::text)
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.impact_json->'fees') fee
        WHERE NOT EXISTS (
          SELECT 1 FROM weekly_fee_entry entry
          JOIN referral_case referral ON referral.id=entry.referral_case_id
          JOIN teaching_week fee_week ON fee_week.id=entry.teaching_week_id
           WHERE entry.id::text=fee->>'feeId' AND entry.version::text=fee->>'version'
             AND entry.teaching_week_id::text=fee->>'teachingWeekId' AND entry.settlement_month::text=fee->>'settlementMonth'
             AND referral.referrer_person_id=NEW.planner_person_id AND referral.referrer_identity='ACADEMIC_PLANNER'
             AND fee_week.week_kind='REGULAR'
             AND (fee_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=NEW.effective_at
             AND (NEW.next_boundary_at IS NULL OR (fee_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<NEW.next_boundary_at)
             AND COALESCE((SELECT source_subject FROM referral_creation_snapshot source WHERE source.referral_case_id=referral.id),'')<>'PLANNING_MENTOR')
     )
  THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_PREVIEW_INVALID'; END IF;
  SELECT count(*),count(*) FILTER (WHERE fee->>'disposition'='CHANGE'),count(*) FILTER (WHERE fee->>'disposition'='UNCHANGED'),count(*) FILTER (WHERE fee->>'disposition'='REFUNDED')
    INTO fee_count,change_count,unchanged_count,refunded_count FROM jsonb_array_elements(NEW.impact_json->'fees') fee;
  IF fee_count<>((NEW.impact_json#>>'{totals,consideredFeeCount}')::integer+(NEW.impact_json#>>'{totals,excludedRefundCount}')::integer)
     OR change_count<>(NEW.impact_json#>>'{totals,changedFeeCount}')::integer
     OR unchanged_count<>(NEW.impact_json#>>'{totals,zeroShareFeeCount}')::integer
     OR refunded_count<>(NEW.impact_json#>>'{totals,excludedRefundCount}')::integer
  THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_PREVIEW_INVALID'; END IF;
  IF (SELECT count(*) FROM role_assignment actor_role
       WHERE actor_role.id=NEW.actor_role_assignment_id
         AND actor_role.person_id=NEW.mentor_person_id
         AND actor_role.person_id=NEW.created_by_person_id
         AND actor_role.subject_code='PLANNING_MENTOR'
         AND actor_role.scope_type='SELF'
         AND actor_role.scope_id IS NULL
         AND actor_role.valid_from<=NEW.created_at
         AND (actor_role.valid_to IS NULL OR actor_role.valid_to>NEW.created_at))<>1
  THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_PREVIEW_INVALID'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_planning_mentor_change_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_row planning_mentor_relationship_change%ROWTYPE;
  previous_row weekly_fee_allocation_snapshot%ROWTYPE;
  result_row weekly_fee_allocation_snapshot%ROWTYPE;
  valid_fee boolean;
  expected_account jsonb;
  previous_account jsonb;
  policy_json jsonb;
BEGIN
  SELECT * INTO change_row FROM planning_mentor_relationship_change WHERE id=NEW.change_id;
  SELECT * INTO previous_row FROM weekly_fee_allocation_snapshot WHERE id=NEW.previous_snapshot_id;
  SELECT * INTO result_row FROM weekly_fee_allocation_snapshot WHERE id=NEW.result_snapshot_id;
  SELECT EXISTS (
    SELECT 1 FROM weekly_fee_entry fee
      JOIN referral_case referral ON referral.id=fee.referral_case_id
      JOIN teaching_week week ON week.id=fee.teaching_week_id
     WHERE fee.id=NEW.weekly_fee_entry_id AND fee.version=NEW.source_weekly_fee_version
       AND fee.teaching_week_id=NEW.teaching_week_id AND fee.settlement_month=NEW.settlement_month
       AND referral.referrer_person_id=change_row.planner_person_id
       AND referral.referrer_identity='ACADEMIC_PLANNER'
       AND COALESCE((SELECT source_subject FROM referral_creation_snapshot source
                       WHERE source.referral_case_id=referral.id),'')<>'PLANNING_MENTOR'
       AND week.week_kind='REGULAR'
       AND (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=change_row.effective_at
       AND (change_row.next_boundary_at IS NULL
            OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<change_row.next_boundary_at)
       AND NOT EXISTS (SELECT 1 FROM weekly_fee_refund_effect refund WHERE refund.weekly_fee_entry_id=fee.id)
  ) INTO valid_fee;
  expected_account := result_row.context_json->'accounts'->'planningMentor';
  previous_account := previous_row.context_json->'accounts'->'planningMentor';
  SELECT policy.policy_json INTO policy_json FROM rate_policy_version policy
    WHERE policy.id=previous_row.policy_version_id;
  IF change_row.id IS NULL OR change_row.posting_status <> 'POSTED'
     OR change_row.settlement_calculation_run_id IS DISTINCT FROM NEW.settlement_calculation_run_id
     OR previous_row.id IS NULL OR result_row.id IS NULL OR valid_fee IS DISTINCT FROM true
     OR previous_row.weekly_fee_entry_id IS DISTINCT FROM NEW.weekly_fee_entry_id
     OR result_row.weekly_fee_entry_id IS DISTINCT FROM NEW.weekly_fee_entry_id
     OR previous_row.source_weekly_fee_version IS DISTINCT FROM NEW.source_weekly_fee_version
     OR result_row.source_weekly_fee_version IS DISTINCT FROM NEW.source_weekly_fee_version
     OR previous_row.policy_version_id IS DISTINCT FROM result_row.policy_version_id
     OR previous_row.net_monthly_cents IS DISTINCT FROM result_row.net_monthly_cents
     OR result_row.run_id IS DISTINCT FROM NEW.settlement_calculation_run_id
     OR result_row.created_at IS DISTINCT FROM NEW.created_at
     OR NEW.created_at IS DISTINCT FROM change_row.published_at
     OR result_row.sequence_no<=previous_row.sequence_no
     OR EXISTS (SELECT 1 FROM weekly_fee_allocation_snapshot intervening
                 WHERE intervening.weekly_fee_entry_id=NEW.weekly_fee_entry_id
                   AND intervening.sequence_no>previous_row.sequence_no
                   AND intervening.sequence_no<result_row.sequence_no)
     OR EXISTS (SELECT 1 FROM weekly_fee_allocation_snapshot later
                 WHERE later.weekly_fee_entry_id=NEW.weekly_fee_entry_id
                   AND later.sequence_no>result_row.sequence_no)
     OR (SELECT COALESCE(sum((line->>'cents')::bigint),0)
           FROM jsonb_array_elements(result_row.snapshot_json->'lines') line)
        IS DISTINCT FROM (SELECT gross_amount_cents FROM weekly_fee_entry WHERE id=NEW.weekly_fee_entry_id)
     OR (SELECT COALESCE(sum((line->>'cents')::bigint),0)
           FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line)
        IS DISTINCT FROM (SELECT gross_amount_cents FROM weekly_fee_entry WHERE id=NEW.weekly_fee_entry_id)
     OR jsonb_typeof(previous_row.snapshot_json->'lines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(result_row.snapshot_json->'lines') IS DISTINCT FROM 'array'
     OR (SELECT count(*) FROM jsonb_array_elements(previous_row.snapshot_json->'lines'))<>9
     OR (SELECT count(*) FROM jsonb_array_elements(result_row.snapshot_json->'lines'))<>9
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
                 WHERE jsonb_typeof(line) IS DISTINCT FROM 'object'
                    OR (CASE WHEN jsonb_typeof(line)='object' THEN (SELECT count(*) FROM jsonb_object_keys(line)) ELSE -1 END)<>2 OR (line ? 'key') IS DISTINCT FROM true OR (line ? 'cents') IS DISTINCT FROM true
                    OR line->>'key' NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
                    OR line->>'cents' IS NULL OR line->>'cents' !~ '^[0-9]+$')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
                 WHERE jsonb_typeof(line) IS DISTINCT FROM 'object'
                    OR (CASE WHEN jsonb_typeof(line)='object' THEN (SELECT count(*) FROM jsonb_object_keys(line)) ELSE -1 END)<>2 OR (line ? 'key') IS DISTINCT FROM true OR (line ? 'cents') IS DISTINCT FROM true
                    OR line->>'key' NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
                    OR line->>'cents' IS NULL OR line->>'cents' !~ '^[0-9]+$')
     OR (SELECT count(DISTINCT line->>'key') FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line)<>9
     OR (SELECT count(DISTINCT line->>'key') FROM jsonb_array_elements(result_row.snapshot_json->'lines') line)<>9
     OR jsonb_typeof(previous_row.snapshot_json->'accountByKey') IS DISTINCT FROM 'object'
     OR jsonb_typeof(result_row.snapshot_json->'accountByKey') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(previous_row.snapshot_json->'accountByKey') mapping
                 WHERE mapping.key NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
                    OR jsonb_typeof(mapping.value) IS DISTINCT FROM 'string')
     OR EXISTS (SELECT 1 FROM jsonb_each(result_row.snapshot_json->'accountByKey') mapping
                 WHERE mapping.key NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
                    OR jsonb_typeof(mapping.value) IS DISTINCT FROM 'string')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
                 WHERE (line->>'cents')::bigint<>0 AND previous_row.snapshot_json#>>ARRAY['accountByKey',line->>'key'] IS NULL)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
                 WHERE (line->>'cents')::bigint<>0 AND result_row.snapshot_json#>>ARRAY['accountByKey',line->>'key'] IS NULL)
     OR previous_row.snapshot_json #- '{lines}'::text[] #- '{accountByKey}'::text[]
        IS DISTINCT FROM result_row.snapshot_json #- '{lines}'::text[] #- '{accountByKey}'::text[]
     OR (previous_row.snapshot_json->'accountByKey') - 'planningMentor'
        IS DISTINCT FROM (result_row.snapshot_json->'accountByKey') - 'planningMentor'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
                 WHERE (line->>'cents')::bigint<>0 AND NOT EXISTS (
                   SELECT 1 FROM settlement_account account WHERE account.account_code=previous_row.snapshot_json#>>ARRAY['accountByKey',line->>'key']
                     AND account.status='ACTIVE' AND previous_row.context_json#>>ARRAY['accounts',line->>'key','accountId']=account.id::text
                     AND previous_row.context_json#>>ARRAY['accounts',line->>'key','accountCode']=account.account_code
                     AND previous_row.context_json#>>ARRAY['accounts',line->>'key','ownerType']=account.owner_type
                     AND previous_row.context_json#>>ARRAY['accounts',line->>'key','ownerId']=account.owner_id::text))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
                 WHERE (line->>'cents')::bigint<>0 AND NOT EXISTS (
                   SELECT 1 FROM settlement_account account WHERE account.account_code=result_row.snapshot_json#>>ARRAY['accountByKey',line->>'key']
                     AND account.status='ACTIVE' AND result_row.context_json#>>ARRAY['accounts',line->>'key','accountId']=account.id::text
                     AND result_row.context_json#>>ARRAY['accounts',line->>'key','accountCode']=account.account_code
                     AND result_row.context_json#>>ARRAY['accounts',line->>'key','ownerType']=account.owner_type
                     AND result_row.context_json#>>ARRAY['accounts',line->>'key','ownerId']=account.owner_id::text))
     OR previous_row.context_json->>'sourceSubject'='PLANNING_MENTOR'
     OR policy_json IS NULL
     OR policy_json->>'planningMentorWeightBasisPoints' IS NULL OR policy_json->>'planningMentorWeightBasisPoints' !~ '^[0-9]+$'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['actualIntroPoolBasisPoints','groupLeaderRateBasisPoints','teachingMentorRateBasisPoints','venueRateBasisPoints','campusConsultationRateBasisPoints','platformFinanceRateBasisPoints','regionFinanceRateBasisPoints']) rate_key
                 WHERE previous_row.context_json#>>ARRAY['resolvedRates',rate_key] IS NULL OR previous_row.context_json#>>ARRAY['resolvedRates',rate_key] !~ '^[0-9]+$')
     OR previous_row.context_json#>>'{resolvedRates,planningMentorWeightBasisPoints}' IS DISTINCT FROM
        (CASE WHEN change_row.action='ADD' THEN '0' ELSE policy_json->>'planningMentorWeightBasisPoints' END)
     OR result_row.context_json#>>'{resolvedRates,planningMentorWeightBasisPoints}' IS DISTINCT FROM
        (CASE WHEN change_row.action='ADD' THEN policy_json->>'planningMentorWeightBasisPoints' ELSE '0' END)
     OR (previous_row.context_json #- '{relationships,planningMentor}'::text[] #- '{accounts,planningMentor}'::text[] #- '{resolvedRates,planningMentorWeightBasisPoints}'::text[])
        IS DISTINCT FROM
        (result_row.context_json #- '{relationships,planningMentor}'::text[] #- '{accounts,planningMentor}'::text[] #- '{resolvedRates,planningMentorWeightBasisPoints}'::text[])
     OR NEW.planner_before_cents < 0 OR NEW.planner_after_cents < 0
     OR NEW.mentor_before_cents < 0 OR NEW.mentor_after_cents < 0
     OR NEW.planner_before_cents IS DISTINCT FROM (SELECT (line->>'cents')::bigint FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line WHERE line->>'key'='referrer')
     OR NEW.planner_after_cents IS DISTINCT FROM (SELECT (line->>'cents')::bigint FROM jsonb_array_elements(result_row.snapshot_json->'lines') line WHERE line->>'key'='referrer')
     OR NEW.mentor_before_cents IS DISTINCT FROM (SELECT (line->>'cents')::bigint FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line WHERE line->>'key'='planningMentor')
     OR NEW.mentor_after_cents IS DISTINCT FROM (SELECT (line->>'cents')::bigint FROM jsonb_array_elements(result_row.snapshot_json->'lines') line WHERE line->>'key'='planningMentor')
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.delta_json)) <> 1 OR NEW.delta_json ? 'entries' IS DISTINCT FROM true
     OR jsonb_typeof(NEW.delta_json->'entries') IS DISTINCT FROM 'array'
     OR (SELECT count(*) FROM jsonb_array_elements(NEW.delta_json->'entries'))=0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.delta_json->'entries') item
                 WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
                    OR (CASE WHEN jsonb_typeof(item)='object' THEN (SELECT count(*) FROM jsonb_object_keys(item)) ELSE -1 END)<>3
                    OR (item ? 'accountKey') IS DISTINCT FROM true OR (item ? 'categoryKey') IS DISTINCT FROM true OR (item ? 'amountCents') IS DISTINCT FROM true
                    OR item->>'accountKey' IS NULL OR item->>'categoryKey' NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
                    OR item->>'amountCents' IS NULL OR item->>'amountCents' !~ '^-?[0-9]+$' OR item->>'amountCents'='0')
     OR (SELECT count(*) FROM jsonb_array_elements(NEW.delta_json->'entries'))
        <> (SELECT count(DISTINCT (item->>'accountKey',item->>'categoryKey')) FROM jsonb_array_elements(NEW.delta_json->'entries') item)
     OR EXISTS (
       WITH raw_delta AS (
         SELECT previous_row.snapshot_json#>>ARRAY['accountByKey', line->>'key'] AS account_key,
                line->>'key' AS category_key, -(line->>'cents')::bigint AS amount_cents
           FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
          WHERE (line->>'cents')::bigint<>0
         UNION ALL
         SELECT result_row.snapshot_json#>>ARRAY['accountByKey', line->>'key'] AS account_key,
                line->>'key' AS category_key, (line->>'cents')::bigint AS amount_cents
           FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
          WHERE (line->>'cents')::bigint<>0
       ), expected AS (
         SELECT account_key,category_key,sum(amount_cents) AS amount_cents
           FROM raw_delta GROUP BY account_key,category_key HAVING sum(amount_cents)<>0
       ), actual AS (
         SELECT item->>'accountKey' AS account_key,item->>'categoryKey' AS category_key,
                (item->>'amountCents')::bigint AS amount_cents
           FROM jsonb_array_elements(NEW.delta_json->'entries') item
       ), mismatch AS (
         (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
         UNION ALL
         (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
       ) SELECT 1 FROM mismatch
     )
     OR (change_row.action='ADD' AND (
           (previous_row.context_json->'relationships' ? 'planningMentor') IS DISTINCT FROM true
           OR previous_row.context_json->'relationships'->'planningMentor' IS DISTINCT FROM 'null'::jsonb
           OR (previous_row.context_json->'accounts' ? 'planningMentor')
           OR (result_row.context_json->'relationships' ? 'planningMentor') IS DISTINCT FROM true
           OR result_row.context_json#>>'{relationships,planningMentor,id}' IS DISTINCT FROM change_row.result_relationship_id::text
           OR result_row.context_json#>>'{relationships,planningMentor,personId}' IS DISTINCT FROM change_row.mentor_person_id::text
           OR expected_account#>>'{ownerType}' IS DISTINCT FROM 'PERSON'
           OR expected_account#>>'{ownerId}' IS DISTINCT FROM change_row.mentor_person_id::text
           OR result_row.snapshot_json#>>'{accountByKey,planningMentor}' IS DISTINCT FROM expected_account#>>'{accountCode}'
           OR NOT EXISTS (SELECT 1 FROM settlement_account account WHERE account.id::text=expected_account#>>'{accountId}'
                          AND account.account_code=expected_account#>>'{accountCode}' AND account.owner_type='PERSON'
                          AND account.owner_id=change_row.mentor_person_id AND account.status='ACTIVE')
         ))
     OR (change_row.action='REMOVE' AND (
           (previous_row.context_json->'relationships' ? 'planningMentor') IS DISTINCT FROM true
           OR (previous_row.context_json->'accounts' ? 'planningMentor') IS DISTINCT FROM true
           OR previous_row.context_json#>>'{relationships,planningMentor,id}' IS DISTINCT FROM change_row.source_relationship_id::text
           OR previous_row.context_json#>>'{relationships,planningMentor,personId}' IS DISTINCT FROM change_row.mentor_person_id::text
           OR previous_row.snapshot_json#>>'{accountByKey,planningMentor}' IS DISTINCT FROM previous_account#>>'{accountCode}'
           OR NOT EXISTS (SELECT 1 FROM settlement_account account WHERE account.id::text=previous_account#>>'{accountId}'
                          AND account.account_code=previous_account#>>'{accountCode}' AND account.owner_type='PERSON'
                          AND account.owner_id=change_row.mentor_person_id AND account.status='ACTIVE')
           OR (result_row.context_json->'relationships' ? 'planningMentor') IS DISTINCT FROM true
           OR result_row.context_json->'relationships'->'planningMentor' IS DISTINCT FROM 'null'::jsonb
           OR (result_row.context_json->'accounts' ? 'planningMentor')
           OR result_row.snapshot_json->'accountByKey' ? 'planningMentor'
         )) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_EFFECT_INVALID action=% previousRelationship=% resultRelationship=% resultAccount=%',
      change_row.action, previous_row.context_json->'relationships'->'planningMentor',
      result_row.context_json->'relationships'->'planningMentor', expected_account;
  END IF;
  -- Recalculate all nine cents with the same frozen rational numerator and
  -- deterministic largest-remainder tie order as settlement.  This is a
  -- guard against a caller changing a single visible mentor line while
  -- silently disturbing the other frozen allocation facts.
  IF EXISTS (
    WITH source AS (
      SELECT fee.gross_amount_cents AS gross,
             (previous_row.context_json#>>'{resolvedRates,actualIntroPoolBasisPoints}')::bigint AS pool,
             CASE WHEN change_row.action='ADD'
               THEN (policy_json->>'planningMentorWeightBasisPoints')::bigint ELSE 0::bigint END AS mentor_weight,
             (previous_row.context_json#>>'{resolvedRates,groupLeaderRateBasisPoints}')::bigint AS group_rate,
             (previous_row.context_json#>>'{resolvedRates,teachingMentorRateBasisPoints}')::bigint AS teaching_rate,
             (previous_row.context_json#>>'{resolvedRates,venueRateBasisPoints}')::bigint AS venue_rate,
             (previous_row.context_json#>>'{resolvedRates,campusConsultationRateBasisPoints}')::bigint AS campus_rate,
             (previous_row.context_json#>>'{resolvedRates,platformFinanceRateBasisPoints}')::bigint AS platform_rate,
             (previous_row.context_json#>>'{resolvedRates,regionFinanceRateBasisPoints}')::bigint AS region_rate
        FROM weekly_fee_entry fee WHERE fee.id=NEW.weekly_fee_entry_id
    ), base AS (
      SELECT spec.key_name,spec.sort_order,spec.numerator FROM source
      CROSS JOIN LATERAL (VALUES
        ('referrer'::text,0, source.pool*(10000-source.mentor_weight)),
        ('planningMentor'::text,1, source.pool*source.mentor_weight),
        ('groupLeader'::text,2, source.group_rate*10000),
        ('teachingMentor'::text,3, source.teaching_rate*10000),
        ('venue'::text,4, source.venue_rate*10000),
        ('campusConsultation'::text,5, source.campus_rate*10000),
        ('platformFinance'::text,6, source.platform_rate*10000),
        ('regionFinance'::text,7, source.region_rate*10000)
      ) spec(key_name,sort_order,numerator)
    ), numerators AS (
      SELECT key_name,sort_order,numerator FROM base
      UNION ALL
      SELECT 'teachingTeacher',8,100000000-COALESCE(sum(numerator),0) FROM base
    ), rounded AS (
      SELECT key_name,sort_order,numerator,
             trunc((source.gross::numeric*numerator::numeric)/100000000)::bigint AS floor_cents,
             mod(source.gross::numeric*numerator::numeric,100000000)::bigint AS remainder,source.gross
        FROM numerators CROSS JOIN source
    ), expected AS (
      SELECT key_name, floor_cents + CASE WHEN row_number() OVER (ORDER BY remainder DESC,sort_order)
                 <= (max(gross) OVER () - sum(floor_cents) OVER ()) THEN 1 ELSE 0 END AS cents
        FROM rounded
    ), actual AS (
      SELECT line->>'key' AS key_name,(line->>'cents')::bigint AS cents
        FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
    ), mismatch AS (
      (SELECT key_name,cents FROM expected EXCEPT ALL SELECT key_name,cents FROM actual)
      UNION ALL (SELECT key_name,cents FROM actual EXCEPT ALL SELECT key_name,cents FROM expected)
    ) SELECT 1 FROM numerators WHERE numerator<0 OR numerator>100000000
      UNION ALL SELECT 1 FROM mismatch
  ) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_EFFECT_ALLOCATION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_planning_mentor_published_relationship_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM planning_mentor_relationship_change c
             WHERE c.source_relationship_id=OLD.id OR c.result_relationship_id=OLD.id) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_PUBLISHED_RELATIONSHIP_IMMUTABLE';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION guard_planning_mentor_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action_code IN ('PLANNING_MENTOR_RELATIONSHIP_ADDED','PLANNING_MENTOR_RELATIONSHIP_REMOVED') THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_IMMUTABLE';
  END IF;
  IF TG_OP<>'DELETE' AND NEW.action_code IN ('PLANNING_MENTOR_RELATIONSHIP_ADDED','PLANNING_MENTOR_RELATIONSHIP_REMOVED') THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_IMMUTABLE';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION assert_planning_mentor_audit_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_code NOT IN ('PLANNING_MENTOR_RELATIONSHIP_ADDED','PLANNING_MENTOR_RELATIONSHIP_REMOVED') THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM planning_mentor_relationship_change change_row
       WHERE change_row.published_by_person_id=NEW.actor_person_id
         AND NEW.subject_type='PERSON_RELATIONSHIP'
         AND NEW.subject_id=COALESCE(change_row.result_relationship_id,change_row.source_relationship_id)
         AND NEW.action_code=CASE WHEN change_row.action='ADD' THEN 'PLANNING_MENTOR_RELATIONSHIP_ADDED' ELSE 'PLANNING_MENTOR_RELATIONSHIP_REMOVED' END
         AND NEW.reason=change_row.reason
         AND NEW.before_json IS NOT DISTINCT FROM change_row.before_json
         AND NEW.after_json IS NOT DISTINCT FROM change_row.after_json
         AND NEW.created_at IS NOT DISTINCT FROM change_row.published_at)<>1 THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_AUDIT_PARENT_INVALID';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER planning_mentor_relationship_change_preview_immutable
BEFORE UPDATE OR DELETE ON planning_mentor_relationship_change_preview
FOR EACH ROW EXECUTE FUNCTION refuse_planning_mentor_relationship_change_mutation();
CREATE CONSTRAINT TRIGGER planning_mentor_preview_complete
AFTER INSERT ON planning_mentor_relationship_change_preview DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_planning_mentor_preview_complete();
CREATE TRIGGER planning_mentor_relationship_change_immutable
BEFORE UPDATE OR DELETE ON planning_mentor_relationship_change
FOR EACH ROW EXECUTE FUNCTION refuse_planning_mentor_relationship_change_mutation();
CREATE TRIGGER planning_mentor_relationship_change_effect_guard
BEFORE INSERT ON planning_mentor_relationship_change_effect
FOR EACH ROW EXECUTE FUNCTION guard_planning_mentor_change_effect();
CREATE TRIGGER planning_mentor_relationship_change_effect_immutable
BEFORE UPDATE OR DELETE ON planning_mentor_relationship_change_effect
FOR EACH ROW EXECUTE FUNCTION refuse_planning_mentor_relationship_change_mutation();
CREATE TRIGGER planning_mentor_published_relationship_delete_guard
BEFORE DELETE ON person_relationship
FOR EACH ROW EXECUTE FUNCTION guard_planning_mentor_published_relationship_delete();
CREATE TRIGGER planning_mentor_audit_immutable
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION guard_planning_mentor_audit_immutable();
CREATE CONSTRAINT TRIGGER planning_mentor_audit_parent_complete
AFTER INSERT ON audit_event DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_planning_mentor_audit_insert();

CREATE INDEX planning_mentor_relationship_change_mentor_lookup
  ON planning_mentor_relationship_change(mentor_person_id,published_at DESC,id);
CREATE INDEX planning_mentor_relationship_change_planner_lookup
  ON planning_mentor_relationship_change(planner_person_id,relationship_version DESC);
CREATE INDEX planning_mentor_relationship_change_effect_fee_lookup
  ON planning_mentor_relationship_change_effect(weekly_fee_entry_id,created_at DESC,change_id);

-- Published records are evidence, not an editable workflow cache.  The
-- following deferred guards intentionally validate the final transaction
-- state: a relationship can be shortened/superseded before its immutable
-- change row is written, but it cannot be changed afterwards.
CREATE FUNCTION planning_mentor_timestamp_text(value timestamptz)
RETURNS text LANGUAGE sql STABLE RETURNS NULL ON NULL INPUT AS $$
  SELECT to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

CREATE FUNCTION planning_mentor_relationship_fact(row_value person_relationship)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', row_value.id::text,
    'teacherPersonId', row_value.teacher_id::text,
    'relationshipType', row_value.relationship_type,
    'relatedPersonId', row_value.related_person_id::text,
    'validFrom', planning_mentor_timestamp_text(row_value.valid_from),
    'validTo', planning_mentor_timestamp_text(row_value.valid_to),
    'effectiveScope', row_value.effective_scope,
    'createdByPersonId', row_value.created_by::text,
    'createdAt', planning_mentor_timestamp_text(row_value.created_at),
    'supersededAt', planning_mentor_timestamp_text(row_value.superseded_at),
    'supersededByChangeId', row_value.superseded_by_change_id::text,
    'supersededByPlanningMentorChangeId', row_value.superseded_by_planning_mentor_change_id::text
  );
$$;

CREATE FUNCTION assert_planning_mentor_published_relationship_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- This constraint is installed on the shared relationship table.  Ordinary
  -- GROUP_LEADER (and every other) relationship maintenance must remain under
  -- its own domain guards; GAP-005-B3 only owns PLANNING_MENTOR facts.
  IF OLD.relationship_type<>'PLANNING_MENTOR' AND NEW.relationship_type<>'PLANNING_MENTOR' THEN
    RETURN NULL;
  END IF;
  -- A relationship may be an ADD result and the source of a later same-week
  -- REMOVE.  Therefore do not select an arbitrary historical change: accept
  -- only the exact immutable REMOVE transition from this OLD fact to NEW.
  IF NOT EXISTS (
    SELECT 1 FROM planning_mentor_relationship_change change_row
     WHERE change_row.source_relationship_id=OLD.id AND change_row.action='REMOVE'
       AND change_row.before_json=planning_mentor_relationship_fact(OLD)
       AND OLD.teacher_id=NEW.teacher_id AND OLD.relationship_type=NEW.relationship_type
       AND OLD.related_person_id=NEW.related_person_id AND OLD.valid_from=NEW.valid_from
       AND OLD.effective_scope IS NOT DISTINCT FROM NEW.effective_scope
       AND OLD.created_by=NEW.created_by AND OLD.created_at=NEW.created_at
       AND ((NEW.valid_to=change_row.effective_at AND NEW.superseded_at IS NULL
             AND NEW.superseded_by_change_id IS NULL AND NEW.superseded_by_planning_mentor_change_id IS NULL)
            OR (OLD.valid_from=change_row.effective_at
                AND NEW.valid_to IS NOT DISTINCT FROM OLD.valid_to
                AND NEW.superseded_at=change_row.published_at
                AND NEW.superseded_by_change_id IS NULL
                AND NEW.superseded_by_planning_mentor_change_id=change_row.id))
  ) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_PUBLISHED_RELATIONSHIP_IMMUTABLE';
  END IF;
  RETURN NULL;
END;
$$;

-- A service transaction writes the relationship before it can write its
-- immutable change evidence, so this must be deferred.  At commit, however,
-- no planning-mentor relationship may exist without the exact ADD evidence.
CREATE FUNCTION assert_planning_mentor_published_relationship_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.relationship_type<>'PLANNING_MENTOR' THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM planning_mentor_relationship_change change_row
    JOIN teaching_week week_row ON week_row.id=change_row.effective_teaching_week_id
     WHERE change_row.action='ADD' AND change_row.result_relationship_id=NEW.id
       AND change_row.before_json IS NULL
       AND change_row.after_json=planning_mentor_relationship_fact(NEW)
       AND NEW.teacher_id=change_row.planner_person_id
       AND NEW.related_person_id=change_row.mentor_person_id
       AND NEW.effective_scope='REGULAR_WEEK:'||change_row.effective_teaching_week_id::text
       AND NEW.valid_from=change_row.effective_at
       AND NEW.valid_to IS NOT DISTINCT FROM change_row.next_boundary_at
       AND NEW.created_by=change_row.published_by_person_id
       AND NEW.created_at=change_row.published_at
       AND week_row.week_kind='REGULAR'
       AND (change_row.published_at AT TIME ZONE 'Asia/Shanghai')::date
           BETWEEN week_row.starts_on AND week_row.ends_on
  ) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_PUBLISHED_RELATIONSHIP_INSERT_INVALID';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_planning_mentor_change_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  preview_row planning_mentor_relationship_change_preview%ROWTYPE;
  week_row teaching_week%ROWTYPE;
  result_row person_relationship%ROWTYPE;
  effect_count integer;
  snapshot_count integer;
  planner_total bigint;
  mentor_total bigint;
BEGIN
  SELECT * INTO preview_row FROM planning_mentor_relationship_change_preview WHERE id=NEW.preview_id;
  SELECT * INTO week_row FROM teaching_week WHERE id=NEW.effective_teaching_week_id;
  SELECT * INTO result_row FROM person_relationship WHERE id=NEW.result_relationship_id;

  IF preview_row.id IS NULL OR week_row.id IS NULL
    OR preview_row.action<>NEW.action OR preview_row.mentor_person_id<>NEW.mentor_person_id
    OR preview_row.planner_person_id<>NEW.planner_person_id
    OR preview_row.source_relationship_id IS DISTINCT FROM NEW.source_relationship_id
    OR preview_row.result_relationship_id IS DISTINCT FROM NEW.result_relationship_id
    OR preview_row.actor_role_assignment_id<>NEW.actor_role_assignment_id
    OR preview_row.created_by_person_id<>NEW.published_by_person_id
    OR preview_row.actor_subject_code<>NEW.actor_subject_code
    OR preview_row.actor_scope_type<>NEW.actor_scope_type
    OR preview_row.effective_teaching_week_id<>NEW.effective_teaching_week_id
    OR preview_row.effective_at<>NEW.effective_at
    OR preview_row.next_boundary_at IS DISTINCT FROM NEW.next_boundary_at
    OR preview_row.reason<>NEW.reason OR preview_row.base_hash<>NEW.base_hash
    OR NEW.published_at<preview_row.created_at
    OR week_row.week_kind<>'REGULAR'
    OR NEW.effective_at IS DISTINCT FROM (week_row.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
    OR (NEW.published_at AT TIME ZONE 'Asia/Shanghai')::date NOT BETWEEN week_row.starts_on AND week_row.ends_on
    OR (preview_row.created_at AT TIME ZONE 'Asia/Shanghai')::date NOT BETWEEN week_row.starts_on AND week_row.ends_on
    OR (SELECT count(*) FROM role_assignment actor_role
          WHERE actor_role.id=NEW.actor_role_assignment_id
            AND actor_role.person_id=NEW.published_by_person_id
            AND actor_role.subject_code='PLANNING_MENTOR'
            AND actor_role.scope_type='SELF'
            AND actor_role.scope_id IS NULL
            AND actor_role.valid_from<=preview_row.created_at
            AND (actor_role.valid_to IS NULL OR actor_role.valid_to>preview_row.created_at)
            AND actor_role.valid_from<=NEW.published_at
            AND (actor_role.valid_to IS NULL OR actor_role.valid_to>NEW.published_at))<>1
    OR (SELECT count(*) FROM role_assignment actor_role
          WHERE actor_role.person_id=NEW.published_by_person_id
            AND actor_role.subject_code='PLANNING_MENTOR'
            AND actor_role.scope_type='SELF'
            AND actor_role.scope_id IS NULL
            AND actor_role.valid_from<=NEW.published_at
            AND (actor_role.valid_to IS NULL OR actor_role.valid_to>NEW.published_at))<>1
    OR (NEW.action='ADD' AND (SELECT count(*) FROM person candidate
          JOIN teacher_profile profile ON profile.person_id=candidate.id
          JOIN user_account login ON login.person_id=candidate.id AND login.login_status='ACTIVE'
          JOIN settlement_account account ON account.owner_type='PERSON' AND account.owner_id=candidate.id AND account.status='ACTIVE'
         WHERE candidate.id=NEW.planner_person_id AND candidate.status='ACTIVE'
           AND profile.employment_status='ACTIVE' AND profile.business_identity='ACADEMIC_PLANNER')<>1)
    OR (NEW.action='REMOVE' AND (SELECT count(*) FROM person candidate
         WHERE candidate.id=NEW.planner_person_id)<>1)
  THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_HEADER_INVALID'; END IF;

  IF NEW.action='ADD' THEN
    IF NEW.before_json IS NOT NULL OR NEW.after_json IS DISTINCT FROM planning_mentor_relationship_fact(result_row)
      OR result_row.teacher_id<>NEW.planner_person_id OR result_row.related_person_id<>NEW.mentor_person_id
      OR result_row.relationship_type<>'PLANNING_MENTOR' OR result_row.valid_from<>NEW.effective_at
      OR result_row.valid_to IS DISTINCT FROM NEW.next_boundary_at
      OR result_row.effective_scope<>'REGULAR_WEEK:'||NEW.effective_teaching_week_id::text
      OR result_row.created_by<>NEW.published_by_person_id OR result_row.created_at<>NEW.published_at
      OR result_row.superseded_at IS NOT NULL OR result_row.superseded_by_change_id IS NOT NULL
      OR result_row.superseded_by_planning_mentor_change_id IS NOT NULL
    THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_ADD_INVALID'; END IF;
  ELSE
    IF NEW.after_json IS NOT NULL OR NEW.before_json IS DISTINCT FROM preview_row.impact_json->'sourceRelationship'
      OR result_row.id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM person_relationship source
         WHERE source.id=NEW.source_relationship_id AND source.teacher_id=NEW.planner_person_id
           AND source.related_person_id=NEW.mentor_person_id AND source.relationship_type='PLANNING_MENTOR'
           AND source.effective_scope ~ '^REGULAR_WEEK:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND EXISTS (SELECT 1 FROM teaching_week source_week
                        WHERE source_week.id::text=substring(source.effective_scope from 14)
                          AND source_week.week_kind='REGULAR')
           AND ((source.valid_to=NEW.effective_at AND source.superseded_at IS NULL
                 AND source.superseded_by_change_id IS NULL AND source.superseded_by_planning_mentor_change_id IS NULL)
             OR (source.valid_from=NEW.effective_at AND source.superseded_at=NEW.published_at
                 AND source.superseded_by_change_id IS NULL
                 AND source.superseded_by_planning_mentor_change_id=NEW.id))
      )
    THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_REMOVE_INVALID'; END IF;
  END IF;

  -- The preview is part of the signed base hash, not an opaque cache.  Reject
  -- fabricated or internally inconsistent fee impacts before their summary
  -- can be promoted into immutable change evidence.
  IF jsonb_typeof(preview_row.impact_json->'fees') IS DISTINCT FROM 'array'
     OR jsonb_typeof(preview_row.impact_json->'totals') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_PREVIEW_IMPACT_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(preview_row.impact_json->'fees') fee
     WHERE jsonb_typeof(fee) IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(fee))<>11
        OR fee->>'feeId' IS NULL OR fee->>'feeId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR fee->>'version' IS NULL OR fee->>'version' !~ '^[1-9][0-9]*$'
        OR fee->>'disposition' IS NULL OR fee->>'disposition' NOT IN ('CHANGE','UNCHANGED','REFUNDED')
        OR NOT EXISTS (
          SELECT 1 FROM weekly_fee_entry entry
          JOIN referral_case referral ON referral.id=entry.referral_case_id
          JOIN teaching_week fee_week ON fee_week.id=entry.teaching_week_id
           WHERE entry.id::text=fee->>'feeId' AND entry.version::text=fee->>'version'
             AND entry.teaching_week_id::text=fee->>'teachingWeekId'
             AND entry.settlement_month::text=fee->>'settlementMonth'
             AND referral.referrer_person_id=NEW.planner_person_id
             AND referral.referrer_identity='ACADEMIC_PLANNER'
             AND fee_week.week_kind='REGULAR'
             AND (fee_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=NEW.effective_at
             AND (NEW.next_boundary_at IS NULL OR (fee_week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<NEW.next_boundary_at)
             AND COALESCE((SELECT source_subject FROM referral_creation_snapshot source WHERE source.referral_case_id=referral.id),'')<>'PLANNING_MENTOR')
        OR (fee->>'disposition'='REFUNDED' AND (
             fee->>'refundId' IS NULL OR fee->>'snapshotId' IS NOT NULL OR fee->>'sequenceNo' IS NOT NULL
             OR fee->>'snapshotHash' IS NOT NULL OR fee->>'policyVersionId' IS NOT NULL OR fee->>'netMonthlyCents' IS NOT NULL
             OR NOT EXISTS (SELECT 1 FROM weekly_fee_refund_effect refund WHERE refund.weekly_fee_entry_id=(fee->>'feeId')::uuid AND refund.finance_document_id::text=fee->>'refundId')))
        OR (fee->>'disposition'<>'REFUNDED' AND (
             fee->>'refundId' IS NOT NULL OR fee->>'snapshotId' IS NULL OR fee->>'sequenceNo' IS NULL
             OR fee->>'snapshotHash' IS NULL OR fee->>'snapshotHash' !~ '^[0-9a-f]{64}$' OR fee->>'policyVersionId' IS NULL OR fee->>'netMonthlyCents' IS NULL OR fee->>'netMonthlyCents' !~ '^-?[0-9]+$'
             OR EXISTS (SELECT 1 FROM weekly_fee_refund_effect refund WHERE refund.weekly_fee_entry_id=(fee->>'feeId')::uuid)))
  ) OR (SELECT count(*) FROM jsonb_array_elements(preview_row.impact_json->'fees'))
       <> (SELECT count(DISTINCT fee->>'feeId') FROM jsonb_array_elements(preview_row.impact_json->'fees') fee) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_PREVIEW_IMPACT_INVALID';
  END IF;

  SELECT count(*),COALESCE(sum(planner_after_cents-planner_before_cents),0),COALESCE(sum(mentor_after_cents-mentor_before_cents),0)
    INTO effect_count,planner_total,mentor_total
    FROM planning_mentor_relationship_change_effect WHERE change_id=NEW.id;
  IF effect_count<>NEW.changed_fee_count
     OR jsonb_typeof(preview_row.impact_json->'fees') IS DISTINCT FROM 'array'
     OR jsonb_typeof(preview_row.impact_json->'totals') IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(preview_row.impact_json->'totals'))<>6
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(preview_row.impact_json->'totals') total_key
                 WHERE total_key NOT IN ('consideredFeeCount','changedFeeCount','zeroShareFeeCount','excludedRefundCount','plannerDeltaCents','mentorDeltaCents'))
     OR (SELECT count(*) FROM jsonb_array_elements(preview_row.impact_json->'fees') fee
          WHERE fee->>'disposition'='CHANGE')<>NEW.changed_fee_count
     OR (SELECT count(*) FROM jsonb_array_elements(preview_row.impact_json->'fees') fee
          WHERE fee->>'disposition'='REFUNDED')<>NEW.excluded_refund_count
     OR (SELECT count(*) FROM jsonb_array_elements(preview_row.impact_json->'fees') fee
          WHERE fee->>'disposition' IN ('CHANGE','UNCHANGED'))<>NEW.considered_fee_count
     OR (SELECT count(*) FROM jsonb_array_elements(preview_row.impact_json->'fees') fee
          WHERE fee->>'disposition'='UNCHANGED')<>(preview_row.impact_json#>>'{totals,zeroShareFeeCount}')::integer
     OR planner_total IS DISTINCT FROM NEW.planner_delta_cents
     OR mentor_total IS DISTINCT FROM NEW.mentor_delta_cents
     OR NEW.considered_fee_count IS DISTINCT FROM (preview_row.impact_json#>>'{totals,consideredFeeCount}')::integer
     OR NEW.changed_fee_count IS DISTINCT FROM (preview_row.impact_json#>>'{totals,changedFeeCount}')::integer
     OR NEW.excluded_refund_count IS DISTINCT FROM (preview_row.impact_json#>>'{totals,excludedRefundCount}')::integer
     OR NEW.planner_delta_cents::text IS DISTINCT FROM preview_row.impact_json#>>'{totals,plannerDeltaCents}'
     OR NEW.mentor_delta_cents::text IS DISTINCT FROM preview_row.impact_json#>>'{totals,mentorDeltaCents}' THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_EFFECT_COUNT_INVALID';
  END IF;
  IF NEW.posting_status='NO_BALANCE_CHANGE' THEN
    IF NEW.settlement_calculation_run_id IS NOT NULL OR NEW.ledger_event_id IS NOT NULL OR effect_count<>0
       OR NEW.changed_fee_count<>0 OR NEW.planner_delta_cents<>0 OR NEW.mentor_delta_cents<>0 THEN
      RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_NO_BALANCE_INVALID';
    END IF;
  ELSE
    SELECT count(*) INTO snapshot_count FROM weekly_fee_allocation_snapshot
      WHERE run_id=NEW.settlement_calculation_run_id;
    IF effect_count=0 OR snapshot_count<>effect_count OR NOT EXISTS (
      SELECT 1 FROM settlement_calculation_run run JOIN ledger_event event ON event.id=run.ledger_event_id
       WHERE run.id=NEW.settlement_calculation_run_id AND run.status='POSTED'
         AND run.ledger_event_id=NEW.ledger_event_id
         AND run.actor_person_id=NEW.published_by_person_id
         AND run.request_key='planning-mentor-change:'||NEW.id::text
         AND event.event_key='weekly-settlement:planning-mentor-change:'||NEW.id::text
         AND event.event_type='WEEKLY_FEE_SETTLEMENT'
    ) OR NOT EXISTS (
      SELECT 1 FROM settlement_calculation_run run
      JOIN planning_mentor_relationship_change_effect effect
        ON effect.change_id=NEW.id AND effect.settlement_calculation_run_id=run.id
       AND effect.weekly_fee_entry_id=run.fee_entry_id AND effect.source_weekly_fee_version=run.fee_version
      WHERE run.id=NEW.settlement_calculation_run_id
    ) OR EXISTS (
      SELECT 1 FROM weekly_fee_allocation_snapshot snapshot
       WHERE snapshot.run_id=NEW.settlement_calculation_run_id
         AND NOT EXISTS (SELECT 1 FROM planning_mentor_relationship_change_effect effect
                           WHERE effect.change_id=NEW.id AND effect.result_snapshot_id=snapshot.id
                             AND effect.weekly_fee_entry_id=snapshot.weekly_fee_entry_id
                             AND effect.source_weekly_fee_version=snapshot.source_weekly_fee_version)
    ) OR EXISTS (
      WITH expected AS (
        SELECT account.id AS account_id,entry->>'categoryKey' AS category_key,
               sum((entry->>'amountCents')::bigint) AS amount_cents
          FROM planning_mentor_relationship_change_effect effect
          CROSS JOIN LATERAL jsonb_array_elements(effect.delta_json->'entries') entry
          JOIN settlement_account account ON account.account_code=entry->>'accountKey'
         WHERE effect.change_id=NEW.id GROUP BY account.id,entry->>'categoryKey'
        HAVING sum((entry->>'amountCents')::bigint)<>0
      ), actual AS (
        SELECT account_id,category_key,sum(amount_cents) AS amount_cents
          FROM ledger_entry WHERE event_id=NEW.ledger_event_id GROUP BY account_id,category_key
      ), mismatch AS ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
                        UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected))
      SELECT 1 FROM mismatch
    ) OR EXISTS (
      SELECT 1 FROM (SELECT DISTINCT account.id AS account_id
        FROM planning_mentor_relationship_change_effect effect
        CROSS JOIN LATERAL jsonb_array_elements(effect.delta_json->'entries') entry
        JOIN settlement_account account ON account.account_code=entry->>'accountKey'
        WHERE effect.change_id=NEW.id) affected
      LEFT JOIN account_balance_projection projection ON projection.account_id=affected.account_id
      WHERE projection.account_id IS NULL OR projection.balance_cents IS DISTINCT FROM
        (SELECT COALESCE(sum(entry.amount_cents),0) FROM ledger_entry entry WHERE entry.account_id=affected.account_id)
    ) THEN
      RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_POSTING_INVALID';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_event audit
     WHERE audit.actor_person_id=NEW.published_by_person_id AND audit.subject_type='PERSON_RELATIONSHIP'
       AND audit.subject_id=COALESCE(NEW.result_relationship_id,NEW.source_relationship_id)
       AND audit.action_code=(CASE WHEN NEW.action='ADD'
            THEN 'PLANNING_MENTOR_RELATIONSHIP_ADDED' ELSE 'PLANNING_MENTOR_RELATIONSHIP_REMOVED' END)
       AND audit.reason=NEW.reason
       AND audit.before_json IS NOT DISTINCT FROM NEW.before_json
       AND audit.after_json IS NOT DISTINCT FROM NEW.after_json
       AND audit.created_at IS NOT DISTINCT FROM NEW.published_at
  ) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_AUDIT_INVALID';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_planning_mentor_effect_parent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_row planning_mentor_relationship_change%ROWTYPE;
BEGIN
  SELECT * INTO change_row FROM planning_mentor_relationship_change WHERE id=NEW.change_id;
  IF change_row.id IS NULL OR change_row.posting_status<>'POSTED'
    OR NEW.settlement_calculation_run_id<>change_row.settlement_calculation_run_id
    OR NOT EXISTS (SELECT 1 FROM weekly_fee_allocation_snapshot snapshot
                   WHERE snapshot.id=NEW.result_snapshot_id AND snapshot.run_id=NEW.settlement_calculation_run_id
                     AND snapshot.weekly_fee_entry_id=NEW.weekly_fee_entry_id
                     AND snapshot.source_weekly_fee_version=NEW.source_weekly_fee_version)
    OR NOT EXISTS (SELECT 1 FROM weekly_fee_allocation_snapshot snapshot
                   WHERE snapshot.id=NEW.previous_snapshot_id AND snapshot.weekly_fee_entry_id=NEW.weekly_fee_entry_id
                     AND snapshot.source_weekly_fee_version=NEW.source_weekly_fee_version)
  THEN RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_EFFECT_INVALID'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_planning_mentor_snapshot_append()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM planning_mentor_relationship_change c WHERE c.settlement_calculation_run_id=NEW.run_id) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_planning_mentor_ledger_append()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM planning_mentor_relationship_change c WHERE c.ledger_event_id=NEW.event_id) THEN
    RAISE EXCEPTION 'PLANNING_MENTOR_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER planning_mentor_published_relationship_update_complete
AFTER UPDATE ON person_relationship DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_planning_mentor_published_relationship_update();
CREATE CONSTRAINT TRIGGER planning_mentor_published_relationship_insert_complete
AFTER INSERT ON person_relationship DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_planning_mentor_published_relationship_insert();
CREATE CONSTRAINT TRIGGER planning_mentor_change_complete
AFTER INSERT ON planning_mentor_relationship_change DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_planning_mentor_change_complete();
CREATE CONSTRAINT TRIGGER planning_mentor_effect_parent_complete
AFTER INSERT ON planning_mentor_relationship_change_effect DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_planning_mentor_effect_parent();
CREATE TRIGGER planning_mentor_snapshot_terminal
BEFORE INSERT ON weekly_fee_allocation_snapshot
FOR EACH ROW EXECUTE FUNCTION guard_planning_mentor_snapshot_append();
CREATE TRIGGER planning_mentor_ledger_terminal
BEFORE INSERT ON ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_planning_mentor_ledger_append();
