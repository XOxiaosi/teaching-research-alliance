-- GAP-005C2: append-only campus to region temporal corrections.
-- The regional history is authoritative for every person assignment at that
-- campus.  C2 rows carry an explicit origin so a historical split cannot be
-- mistaken for an ordinary/manual edit.

ALTER TABLE campus_region_assignment
  ADD COLUMN superseded_by_campus_region_change_id uuid,
  ADD COLUMN campus_region_change_id uuid;
ALTER TABLE campus_region_assignment
  DROP CONSTRAINT campus_region_assignment_check,
  ADD CONSTRAINT campus_region_assignment_valid_time_order CHECK (valid_to IS NULL OR valid_to >= valid_from);
ALTER TABLE person_campus_assignment
  ADD COLUMN campus_region_change_id uuid,
  ADD COLUMN superseded_by_campus_region_change_id uuid;

CREATE TABLE campus_region_assignment_change_preview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campus_id uuid NOT NULL REFERENCES organization_unit(id),
  source_region_id uuid NOT NULL REFERENCES organization_unit(id),
  target_region_id uuid NOT NULL REFERENCES organization_unit(id),
  source_assignment_id uuid NOT NULL REFERENCES campus_region_assignment(id),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  base_hash text NOT NULL CHECK (base_hash ~ '^[0-9a-f]{64}$'),
  impact_json jsonb NOT NULL CHECK (jsonb_typeof(impact_json)='object'),
  actor_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  created_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  actor_scope_type text NOT NULL CHECK (actor_scope_type='GLOBAL'),
  created_at timestamptz NOT NULL,
  CHECK (source_region_id <> target_region_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE campus_region_assignment_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id uuid NOT NULL UNIQUE REFERENCES campus_region_assignment_change_preview(id),
  campus_id uuid NOT NULL REFERENCES organization_unit(id),
  source_region_id uuid NOT NULL REFERENCES organization_unit(id),
  target_region_id uuid NOT NULL REFERENCES organization_unit(id),
  source_assignment_id uuid NOT NULL REFERENCES campus_region_assignment(id),
  result_assignment_id uuid NOT NULL UNIQUE REFERENCES campus_region_assignment(id),
  continuation_assignment_id uuid UNIQUE REFERENCES campus_region_assignment(id),
  assignment_version bigint NOT NULL CHECK (assignment_version > 0),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  base_hash text NOT NULL CHECK (base_hash ~ '^[0-9a-f]{64}$'),
  posting_status text NOT NULL CHECK (posting_status IN ('POSTED','NO_BALANCE_CHANGE')),
  settlement_calculation_run_id uuid REFERENCES settlement_calculation_run(id),
  ledger_event_id uuid REFERENCES ledger_event(id),
  considered_person_count integer NOT NULL CHECK (considered_person_count >= 0),
  affected_assignment_count integer NOT NULL CHECK (affected_assignment_count >= 0),
  considered_fee_count integer NOT NULL CHECK (considered_fee_count >= 0),
  changed_fee_count integer NOT NULL CHECK (changed_fee_count BETWEEN 0 AND considered_fee_count),
  excluded_refund_count integer NOT NULL CHECK (excluded_refund_count >= 0),
  before_json jsonb NOT NULL CHECK (jsonb_typeof(before_json)='object'),
  after_json jsonb NOT NULL CHECK (jsonb_typeof(after_json)='object'),
  published_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  actor_scope_type text NOT NULL CHECK (actor_scope_type='GLOBAL'),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(campus_id, assignment_version),
  UNIQUE(published_by_person_id,idempotency_key),
  CHECK (source_region_id <> target_region_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (published_at=created_at),
  CHECK (settlement_calculation_run_id IS NOT NULL OR considered_fee_count=excluded_refund_count),
  CHECK ((posting_status='POSTED' AND ledger_event_id IS NOT NULL) OR (posting_status='NO_BALANCE_CHANGE' AND ledger_event_id IS NULL))
);

CREATE TABLE campus_region_assignment_person_effect (
  change_id uuid NOT NULL REFERENCES campus_region_assignment_change(id),
  person_id uuid NOT NULL REFERENCES person(id),
  source_assignment_id uuid NOT NULL REFERENCES person_campus_assignment(id),
  result_assignment_id uuid NOT NULL UNIQUE REFERENCES person_campus_assignment(id),
  continuation_assignment_id uuid UNIQUE REFERENCES person_campus_assignment(id),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  before_json jsonb NOT NULL CHECK (jsonb_typeof(before_json)='object'),
  after_json jsonb NOT NULL CHECK (jsonb_typeof(after_json)='object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(change_id,source_assignment_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE campus_region_assignment_settlement_effect (
  change_id uuid NOT NULL REFERENCES campus_region_assignment_change(id),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  source_weekly_fee_version bigint NOT NULL,
  teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  settlement_month date NOT NULL,
  previous_snapshot_id uuid NOT NULL REFERENCES weekly_fee_allocation_snapshot(id),
  result_snapshot_id uuid NOT NULL UNIQUE REFERENCES weekly_fee_allocation_snapshot(id),
  settlement_calculation_run_id uuid NOT NULL REFERENCES settlement_calculation_run(id),
  delta_json jsonb NOT NULL CHECK (jsonb_typeof(delta_json)='object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(change_id,weekly_fee_entry_id),
  FOREIGN KEY(weekly_fee_entry_id,source_weekly_fee_version)
    REFERENCES weekly_fee_entry_version(weekly_fee_entry_id,version)
);

ALTER TABLE campus_region_assignment
  ADD CONSTRAINT campus_region_assignment_superseded_change_fk
  FOREIGN KEY (superseded_by_campus_region_change_id)
  REFERENCES campus_region_assignment_change(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE campus_region_assignment
  ADD CONSTRAINT campus_region_assignment_origin_change_fk
  FOREIGN KEY (campus_region_change_id)
  REFERENCES campus_region_assignment_change(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE person_campus_assignment
  ADD CONSTRAINT person_campus_assignment_campus_region_change_fk
  FOREIGN KEY (campus_region_change_id)
  REFERENCES campus_region_assignment_change(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE person_campus_assignment
  ADD CONSTRAINT person_campus_assignment_superseded_campus_region_change_fk
  FOREIGN KEY (superseded_by_campus_region_change_id)
  REFERENCES campus_region_assignment_change(id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION refuse_campus_region_assignment_change_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_IMMUTABLE'; END; $$;

CREATE FUNCTION assert_campus_region_assignment_change_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM audit_event a
       WHERE a.actor_person_id=NEW.published_by_person_id
         AND a.action_code='CAMPUS_REGION_ASSIGNMENT_CHANGED'
         AND a.subject_type='CAMPUS_REGION_ASSIGNMENT_CHANGE'
         AND a.subject_id=NEW.id AND a.reason=NEW.reason
         AND a.before_json=NEW.before_json AND a.after_json=NEW.after_json
         AND a.created_at=NEW.published_at)<>1 THEN
    RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_AUDIT_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM campus_region_assignment a WHERE a.id=NEW.source_assignment_id AND a.superseded_by_campus_region_change_id=NEW.id)
     OR NOT EXISTS (SELECT 1 FROM campus_region_assignment a WHERE a.id=NEW.result_assignment_id AND a.campus_region_change_id=NEW.id)
     OR (NEW.continuation_assignment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campus_region_assignment a WHERE a.id=NEW.continuation_assignment_id AND a.campus_region_change_id=NEW.id))
     OR EXISTS (SELECT 1 FROM campus_region_assignment a
                 WHERE a.superseded_by_campus_region_change_id=NEW.id AND a.id<>NEW.source_assignment_id)
     OR EXISTS (SELECT 1 FROM campus_region_assignment a
                 WHERE a.campus_region_change_id=NEW.id
                   AND a.id<>NEW.result_assignment_id
                   AND a.id IS DISTINCT FROM NEW.continuation_assignment_id)
     OR (SELECT count(*) FROM campus_region_assignment_person_effect e WHERE e.change_id=NEW.id)<>NEW.affected_assignment_count
     OR (SELECT count(DISTINCT e.person_id) FROM campus_region_assignment_person_effect e WHERE e.change_id=NEW.id)<>NEW.considered_person_count
     OR (SELECT count(*) FROM campus_region_assignment_settlement_effect e WHERE e.change_id=NEW.id)<>(NEW.considered_fee_count-NEW.excluded_refund_count)
     OR EXISTS (SELECT 1 FROM person_campus_assignment s
                 WHERE s.superseded_by_campus_region_change_id=NEW.id
                   AND NOT EXISTS (SELECT 1 FROM campus_region_assignment_person_effect e
                                    WHERE e.change_id=NEW.id AND e.source_assignment_id=s.id))
     OR EXISTS (SELECT 1 FROM person_campus_assignment r
                 WHERE r.campus_region_change_id=NEW.id
                   AND NOT EXISTS (SELECT 1 FROM campus_region_assignment_person_effect e
                                    WHERE e.change_id=NEW.id
                                      AND (e.result_assignment_id=r.id OR e.continuation_assignment_id=r.id)))
     OR EXISTS (SELECT 1 FROM campus_region_assignment_person_effect e
                  LEFT JOIN person_campus_assignment s ON s.id=e.source_assignment_id
                  LEFT JOIN person_campus_assignment r ON r.id=e.result_assignment_id
                  LEFT JOIN person_campus_assignment c ON c.id=e.continuation_assignment_id
                 WHERE e.change_id=NEW.id AND (
                   s.superseded_by_campus_region_change_id IS DISTINCT FROM NEW.id
                   OR r.campus_region_change_id IS DISTINCT FROM NEW.id
                   OR e.person_id IS DISTINCT FROM s.person_id
                   OR e.person_id IS DISTINCT FROM r.person_id
                   OR s.campus_id IS DISTINCT FROM NEW.campus_id
                   OR r.campus_id IS DISTINCT FROM NEW.campus_id
                   OR s.region_id IS DISTINCT FROM NEW.source_region_id
                   OR r.region_id IS DISTINCT FROM NEW.target_region_id
                   OR s.valid_to IS DISTINCT FROM e.effective_from
                   OR r.valid_from IS DISTINCT FROM e.effective_from
                   OR r.valid_to IS DISTINCT FROM e.effective_to
                   OR (e.continuation_assignment_id IS NOT NULL AND (
                     c.campus_region_change_id IS DISTINCT FROM NEW.id
                     OR c.person_id IS DISTINCT FROM e.person_id
                     OR c.campus_id IS DISTINCT FROM NEW.campus_id
                     OR c.region_id IS DISTINCT FROM NEW.source_region_id
                     OR c.valid_from IS DISTINCT FROM e.effective_to
                   ))
                 )) THEN
    RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_DUAL_SOURCE_INVALID';
  END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION guard_campus_region_assignment_change_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP<>'INSERT' AND OLD.action_code='CAMPUS_REGION_ASSIGNMENT_CHANGED')
     OR (TG_OP='INSERT' AND NEW.action_code='CAMPUS_REGION_ASSIGNMENT_CHANGED'
         AND EXISTS (SELECT 1 FROM audit_event a WHERE a.action_code=NEW.action_code AND a.subject_id=NEW.subject_id)) THEN
    RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_IMMUTABLE';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE FUNCTION assert_campus_region_assignment_change_audit_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_code='CAMPUS_REGION_ASSIGNMENT_CHANGED' AND NOT EXISTS (
    SELECT 1 FROM campus_region_assignment_change c
     WHERE c.id=NEW.subject_id AND c.published_by_person_id=NEW.actor_person_id
       AND c.reason=NEW.reason AND c.before_json=NEW.before_json
       AND c.after_json=NEW.after_json AND c.published_at=NEW.created_at
  ) THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_AUDIT_PARENT_INVALID'; END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER campus_region_assignment_change_preview_immutable BEFORE UPDATE OR DELETE ON campus_region_assignment_change_preview
FOR EACH ROW EXECUTE FUNCTION refuse_campus_region_assignment_change_mutation();
CREATE TRIGGER campus_region_assignment_change_immutable BEFORE UPDATE OR DELETE ON campus_region_assignment_change
FOR EACH ROW EXECUTE FUNCTION refuse_campus_region_assignment_change_mutation();
CREATE TRIGGER campus_region_assignment_person_effect_immutable BEFORE UPDATE OR DELETE ON campus_region_assignment_person_effect
FOR EACH ROW EXECUTE FUNCTION refuse_campus_region_assignment_change_mutation();
CREATE TRIGGER campus_region_assignment_settlement_effect_immutable BEFORE UPDATE OR DELETE ON campus_region_assignment_settlement_effect
FOR EACH ROW EXECUTE FUNCTION refuse_campus_region_assignment_change_mutation();
CREATE CONSTRAINT TRIGGER campus_region_assignment_change_audit_complete AFTER INSERT ON campus_region_assignment_change
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_campus_region_assignment_change_audit();
CREATE CONSTRAINT TRIGGER campus_region_assignment_change_audit_parent AFTER INSERT ON audit_event
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_campus_region_assignment_change_audit_insert();
CREATE TRIGGER campus_region_assignment_change_audit_immutable BEFORE INSERT OR UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION guard_campus_region_assignment_change_audit();

CREATE INDEX campus_region_assignment_change_campus_lookup ON campus_region_assignment_change(campus_id,assignment_version DESC);
CREATE INDEX campus_region_assignment_person_effect_person_lookup ON campus_region_assignment_person_effect(person_id,created_at DESC);
CREATE INDEX campus_region_assignment_settlement_effect_fee_lookup ON campus_region_assignment_settlement_effect(weekly_fee_entry_id,created_at DESC);
CREATE UNIQUE INDEX campus_region_assignment_change_audit_subject_once
  ON audit_event(action_code,subject_id)
  WHERE action_code='CAMPUS_REGION_ASSIGNMENT_CHANGED' AND subject_type='CAMPUS_REGION_ASSIGNMENT_CHANGE';

-- A C2 publication is a terminal settlement bundle: all eligible fees receive
-- a fresh context/snapshot, while only the aggregated non-zero deltas receive
-- ledger entries.  These constraints deliberately repeat the service scope
-- query below so direct SQL cannot omit an in-range fee or manufacture one.
ALTER TABLE campus_region_assignment_change
  ADD CONSTRAINT campus_region_assignment_change_run_once UNIQUE (settlement_calculation_run_id),
  ADD CONSTRAINT campus_region_assignment_change_ledger_once UNIQUE (ledger_event_id);

CREATE FUNCTION guard_campus_region_assignment_settlement_effect_shape()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.delta_json)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.delta_json))<>1
     OR NEW.delta_json ? 'entries' IS DISTINCT FROM true
     OR jsonb_typeof(NEW.delta_json->'entries')<>'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.delta_json->'entries') item
        WHERE jsonb_typeof(item)<>'object'
           OR (SELECT count(*) FROM jsonb_object_keys(item))<>3
           OR NOT (item ?& ARRAY['accountKey','categoryKey','amountCents'])
           OR item->>'accountKey' IS NULL OR btrim(item->>'accountKey')=''
           OR item->>'categoryKey' NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
           OR item->>'amountCents' !~ '^-?[1-9][0-9]*$'
           OR NOT EXISTS (SELECT 1 FROM settlement_account a WHERE a.account_code=item->>'accountKey')
     )
     OR (SELECT count(*) FROM jsonb_array_elements(NEW.delta_json->'entries'))
        <> (SELECT count(DISTINCT (item->>'accountKey',item->>'categoryKey')) FROM jsonb_array_elements(NEW.delta_json->'entries') item)
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_DELTA_INVALID'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION assert_campus_region_assignment_settlement_effect_parent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c campus_region_assignment_change%ROWTYPE;
  previous_row weekly_fee_allocation_snapshot%ROWTYPE;
  result_row weekly_fee_allocation_snapshot%ROWTYPE;
BEGIN
  SELECT * INTO c FROM campus_region_assignment_change WHERE id=NEW.change_id;
  SELECT * INTO previous_row FROM weekly_fee_allocation_snapshot WHERE id=NEW.previous_snapshot_id;
  SELECT * INTO result_row FROM weekly_fee_allocation_snapshot WHERE id=NEW.result_snapshot_id;

  IF c.id IS NULL OR c.settlement_calculation_run_id IS NULL
     OR NEW.settlement_calculation_run_id IS DISTINCT FROM c.settlement_calculation_run_id
     OR previous_row.id IS NULL OR result_row.id IS NULL
     OR previous_row.weekly_fee_entry_id IS DISTINCT FROM NEW.weekly_fee_entry_id
     OR result_row.weekly_fee_entry_id IS DISTINCT FROM NEW.weekly_fee_entry_id
     OR previous_row.source_weekly_fee_version IS DISTINCT FROM NEW.source_weekly_fee_version
     OR result_row.source_weekly_fee_version IS DISTINCT FROM NEW.source_weekly_fee_version
     OR previous_row.policy_version_id IS DISTINCT FROM result_row.policy_version_id
     OR previous_row.net_monthly_cents IS DISTINCT FROM result_row.net_monthly_cents
     OR result_row.run_id IS DISTINCT FROM c.settlement_calculation_run_id
     OR previous_row.sequence_no>=result_row.sequence_no
     OR result_row.created_at IS DISTINCT FROM c.published_at
     OR NEW.created_at IS DISTINCT FROM c.published_at
     OR EXISTS (
       SELECT 1 FROM weekly_fee_allocation_snapshot intervening
        WHERE intervening.weekly_fee_entry_id=NEW.weekly_fee_entry_id
          AND intervening.sequence_no>previous_row.sequence_no
          AND intervening.sequence_no<result_row.sequence_no
     )
     OR EXISTS (
       SELECT 1 FROM weekly_fee_allocation_snapshot later
        WHERE later.weekly_fee_entry_id=NEW.weekly_fee_entry_id
          AND later.sequence_no>result_row.sequence_no
     )
     OR EXISTS (
       SELECT 1
         FROM weekly_fee_entry fee
         JOIN referral_case referral ON referral.id=fee.referral_case_id
         JOIN teaching_week week ON week.id=fee.teaching_week_id
        WHERE fee.id=NEW.weekly_fee_entry_id
          AND (fee.version IS DISTINCT FROM NEW.source_weekly_fee_version
               OR fee.teaching_week_id IS DISTINCT FROM NEW.teaching_week_id
               OR fee.settlement_month IS DISTINCT FROM NEW.settlement_month
               OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<c.effective_from
               OR (c.effective_to IS NOT NULL AND (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=c.effective_to)
               OR NOT EXISTS (
                 SELECT 1 FROM person_campus_assignment assignment
                  WHERE assignment.campus_id=c.campus_id
                    AND (assignment.person_id=referral.receiver_person_id
                         OR assignment.person_id=referral.referrer_person_id)
                    AND assignment.valid_from<=(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
                    AND (assignment.valid_to IS NULL OR assignment.valid_to>(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai'))
               )
               OR EXISTS (SELECT 1 FROM weekly_fee_refund_effect refund WHERE refund.weekly_fee_entry_id=fee.id))
     )
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_PARENT_INVALID'; END IF;

  IF jsonb_typeof(previous_row.snapshot_json) IS DISTINCT FROM 'object'
     OR jsonb_typeof(result_row.snapshot_json) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(previous_row.snapshot_json))<>2
     OR (SELECT count(*) FROM jsonb_object_keys(result_row.snapshot_json))<>2
     OR jsonb_typeof(previous_row.snapshot_json->'lines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(result_row.snapshot_json->'lines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(previous_row.snapshot_json->'accountByKey') IS DISTINCT FROM 'object'
     OR jsonb_typeof(result_row.snapshot_json->'accountByKey') IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_array_elements(previous_row.snapshot_json->'lines'))<>9
     OR (SELECT count(*) FROM jsonb_array_elements(result_row.snapshot_json->'lines'))<>9
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
        WHERE jsonb_typeof(line) IS DISTINCT FROM 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(line))<>2
           OR line->>'key' NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
           OR line->>'cents' IS NULL OR line->>'cents' !~ '^[0-9]+$'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
        WHERE jsonb_typeof(line) IS DISTINCT FROM 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(line))<>2
           OR line->>'key' NOT IN ('referrer','planningMentor','groupLeader','teachingMentor','venue','campusConsultation','platformFinance','regionFinance','teachingTeacher')
           OR line->>'cents' IS NULL OR line->>'cents' !~ '^[0-9]+$'
     )
     OR (SELECT count(DISTINCT line->>'key') FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line)<>9
     OR (SELECT count(DISTINCT line->>'key') FROM jsonb_array_elements(result_row.snapshot_json->'lines') line)<>9
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
     OR (SELECT sum((line->>'cents')::bigint) FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line)
        IS DISTINCT FROM (SELECT gross_amount_cents FROM weekly_fee_entry WHERE id=NEW.weekly_fee_entry_id)
     OR (SELECT sum((line->>'cents')::bigint) FROM jsonb_array_elements(result_row.snapshot_json->'lines') line)
        IS DISTINCT FROM (SELECT gross_amount_cents FROM weekly_fee_entry WHERE id=NEW.weekly_fee_entry_id)
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_SNAPSHOT_INVALID'; END IF;

  IF previous_row.snapshot_json->'lines' IS DISTINCT FROM result_row.snapshot_json->'lines'
     OR (previous_row.snapshot_json->'accountByKey') - 'regionFinance'
        IS DISTINCT FROM (result_row.snapshot_json->'accountByKey') - 'regionFinance'
     OR jsonb_typeof(previous_row.context_json->'organization') IS DISTINCT FROM 'object'
     OR jsonb_typeof(result_row.context_json->'organization') IS DISTINCT FROM 'object'
     OR jsonb_typeof(previous_row.context_json->'accounts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(result_row.context_json->'accounts') IS DISTINCT FROM 'object'
     OR (previous_row.context_json
          #- '{organization,referrerCampusAssignment}'::text[]
          #- '{organization,receiverCampusAssignment}'::text[]
          #- '{organization,regionFinanceRole}'::text[]
          #- '{accounts,regionFinance}'::text[])
        IS DISTINCT FROM
        (result_row.context_json
          #- '{organization,referrerCampusAssignment}'::text[]
          #- '{organization,receiverCampusAssignment}'::text[]
          #- '{organization,regionFinanceRole}'::text[]
          #- '{accounts,regionFinance}'::text[])
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_CONTEXT_INVALID'; END IF;

  IF EXISTS (
       SELECT 1
         FROM weekly_fee_entry fee
         JOIN referral_case referral ON referral.id=fee.referral_case_id
         JOIN teaching_week week ON week.id=fee.teaching_week_id
        WHERE fee.id=NEW.weekly_fee_entry_id AND (
          ((previous_row.context_json#>'{organization,referrerCampusAssignment}') IS DISTINCT FROM 'null'::jsonb
            AND NOT EXISTS (
              SELECT 1 FROM person_campus_assignment assignment
               WHERE assignment.id::text=result_row.context_json#>>'{organization,referrerCampusAssignment,id}'
                 AND assignment.person_id=referral.referrer_person_id
                 AND assignment.campus_id::text=result_row.context_json#>>'{organization,referrerCampusAssignment,campus_id}'
                 AND assignment.region_id::text=result_row.context_json#>>'{organization,referrerCampusAssignment,region_id}'
                 AND assignment.valid_from<=(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
                 AND (assignment.valid_to IS NULL OR assignment.valid_to>(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai'))
            ))
          OR ((previous_row.context_json#>'{organization,referrerCampusAssignment}') IS NOT DISTINCT FROM 'null'::jsonb
              AND (result_row.context_json#>'{organization,referrerCampusAssignment}') IS DISTINCT FROM 'null'::jsonb)
          OR ((previous_row.context_json#>'{organization,receiverCampusAssignment}') IS DISTINCT FROM 'null'::jsonb
            AND NOT EXISTS (
              SELECT 1 FROM person_campus_assignment assignment
               WHERE assignment.id::text=result_row.context_json#>>'{organization,receiverCampusAssignment,id}'
                 AND assignment.person_id=referral.receiver_person_id
                 AND assignment.campus_id::text=result_row.context_json#>>'{organization,receiverCampusAssignment,campus_id}'
                 AND assignment.region_id::text=result_row.context_json#>>'{organization,receiverCampusAssignment,region_id}'
                 AND assignment.valid_from<=(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
                 AND (assignment.valid_to IS NULL OR assignment.valid_to>(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai'))
            ))
          OR ((previous_row.context_json#>'{organization,receiverCampusAssignment}') IS NOT DISTINCT FROM 'null'::jsonb
              AND (result_row.context_json#>'{organization,receiverCampusAssignment}') IS DISTINCT FROM 'null'::jsonb)
          OR ((previous_row.context_json#>'{organization,regionFinanceRole}') IS DISTINCT FROM 'null'::jsonb
            AND NOT EXISTS (
              SELECT 1 FROM role_assignment role
               WHERE role.id::text=result_row.context_json#>>'{organization,regionFinanceRole,id}'
                 AND role.person_id::text=result_row.context_json#>>'{organization,regionFinanceRole,person_id}'
                 AND role.subject_code='REGION_FINANCE' AND role.scope_type='REGION'
                 AND role.scope_id=c.target_region_id
                 AND role.valid_from<=(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
                 AND (role.valid_to IS NULL OR role.valid_to>(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai'))
            ))
          OR ((previous_row.context_json#>'{organization,regionFinanceRole}') IS NOT DISTINCT FROM 'null'::jsonb
              AND (result_row.context_json#>'{organization,regionFinanceRole}') IS DISTINCT FROM 'null'::jsonb)
        )
     )
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_TARGET_INVALID'; END IF;

  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
        WHERE (line->>'cents')::bigint<>0 AND NOT EXISTS (
          SELECT 1 FROM settlement_account account
           WHERE account.account_code=previous_row.snapshot_json#>>ARRAY['accountByKey',line->>'key']
             AND previous_row.context_json#>>ARRAY['accounts',line->>'key','accountId']=account.id::text
             AND previous_row.context_json#>>ARRAY['accounts',line->>'key','accountCode']=account.account_code
             AND previous_row.context_json#>>ARRAY['accounts',line->>'key','ownerType']=account.owner_type
             AND previous_row.context_json#>>ARRAY['accounts',line->>'key','ownerId']=account.owner_id::text
        )
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
        WHERE (line->>'cents')::bigint<>0 AND NOT EXISTS (
          SELECT 1 FROM settlement_account account
           WHERE account.account_code=result_row.snapshot_json#>>ARRAY['accountByKey',line->>'key']
             AND account.status='ACTIVE'
             AND result_row.context_json#>>ARRAY['accounts',line->>'key','accountId']=account.id::text
             AND result_row.context_json#>>ARRAY['accounts',line->>'key','accountCode']=account.account_code
             AND result_row.context_json#>>ARRAY['accounts',line->>'key','ownerType']=account.owner_type
             AND result_row.context_json#>>ARRAY['accounts',line->>'key','ownerId']=account.owner_id::text
        )
     )
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_ACCOUNT_INVALID'; END IF;

  IF EXISTS (
       WITH raw_delta AS (
         SELECT previous_row.snapshot_json#>>ARRAY['accountByKey',line->>'key'] account_key,
                line->>'key' category_key,-(line->>'cents')::bigint amount_cents
           FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
          WHERE (line->>'cents')::bigint<>0
         UNION ALL
         SELECT result_row.snapshot_json#>>ARRAY['accountByKey',line->>'key'] account_key,
                line->>'key' category_key,(line->>'cents')::bigint amount_cents
           FROM jsonb_array_elements(result_row.snapshot_json->'lines') line
          WHERE (line->>'cents')::bigint<>0
       ), expected AS (
         SELECT account_key,category_key,sum(amount_cents) amount_cents
           FROM raw_delta GROUP BY account_key,category_key HAVING sum(amount_cents)<>0
       ), actual AS (
         SELECT item->>'accountKey' account_key,item->>'categoryKey' category_key,
                (item->>'amountCents')::bigint amount_cents
           FROM jsonb_array_elements(NEW.delta_json->'entries') item
       ), mismatch AS (
         (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
         UNION ALL
         (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
       ) SELECT 1 FROM mismatch
     )
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_EFFECT_DELTA_MISMATCH'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION assert_campus_region_assignment_change_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scoped_fee_count integer;
  refunded_fee_count integer;
  eligible_fee_count integer;
  effect_count integer;
  changed_effect_count integer;
  snapshot_count integer;
BEGIN
  -- Keep the bidirectional campus/person history proof that C2 already had.
  IF (SELECT count(*) FROM audit_event a
       WHERE a.actor_person_id=NEW.published_by_person_id
         AND a.action_code='CAMPUS_REGION_ASSIGNMENT_CHANGED'
         AND a.subject_type='CAMPUS_REGION_ASSIGNMENT_CHANGE'
         AND a.subject_id=NEW.id AND a.reason=NEW.reason
         AND a.before_json=NEW.before_json AND a.after_json=NEW.after_json
         AND a.created_at=NEW.published_at)<>1 THEN
    RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_AUDIT_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM campus_region_assignment a WHERE a.id=NEW.source_assignment_id AND a.superseded_by_campus_region_change_id=NEW.id)
     OR NOT EXISTS (SELECT 1 FROM campus_region_assignment a WHERE a.id=NEW.result_assignment_id AND a.campus_region_change_id=NEW.id)
     OR (NEW.continuation_assignment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campus_region_assignment a WHERE a.id=NEW.continuation_assignment_id AND a.campus_region_change_id=NEW.id))
     OR EXISTS (SELECT 1 FROM campus_region_assignment a
                 WHERE a.superseded_by_campus_region_change_id=NEW.id AND a.id<>NEW.source_assignment_id)
     OR EXISTS (SELECT 1 FROM campus_region_assignment a
                 WHERE a.campus_region_change_id=NEW.id
                   AND a.id<>NEW.result_assignment_id
                   AND a.id IS DISTINCT FROM NEW.continuation_assignment_id)
     OR (SELECT count(*) FROM campus_region_assignment_person_effect e WHERE e.change_id=NEW.id)<>NEW.affected_assignment_count
     OR (SELECT count(DISTINCT e.person_id) FROM campus_region_assignment_person_effect e WHERE e.change_id=NEW.id)<>NEW.considered_person_count
     OR EXISTS (SELECT 1 FROM person_campus_assignment s
                 WHERE s.superseded_by_campus_region_change_id=NEW.id
                   AND NOT EXISTS (SELECT 1 FROM campus_region_assignment_person_effect e
                                    WHERE e.change_id=NEW.id AND e.source_assignment_id=s.id))
     OR EXISTS (SELECT 1 FROM person_campus_assignment r
                 WHERE r.campus_region_change_id=NEW.id
                   AND NOT EXISTS (SELECT 1 FROM campus_region_assignment_person_effect e
                                    WHERE e.change_id=NEW.id
                                      AND (e.result_assignment_id=r.id OR e.continuation_assignment_id=r.id)))
     OR EXISTS (SELECT 1 FROM campus_region_assignment_person_effect e
                  LEFT JOIN person_campus_assignment s ON s.id=e.source_assignment_id
                  LEFT JOIN person_campus_assignment r ON r.id=e.result_assignment_id
                  LEFT JOIN person_campus_assignment c ON c.id=e.continuation_assignment_id
                 WHERE e.change_id=NEW.id AND (
                   s.superseded_by_campus_region_change_id IS DISTINCT FROM NEW.id
                   OR r.campus_region_change_id IS DISTINCT FROM NEW.id
                   OR e.person_id IS DISTINCT FROM s.person_id
                   OR e.person_id IS DISTINCT FROM r.person_id
                   OR s.campus_id IS DISTINCT FROM NEW.campus_id
                   OR r.campus_id IS DISTINCT FROM NEW.campus_id
                   OR s.region_id IS DISTINCT FROM NEW.source_region_id
                   OR r.region_id IS DISTINCT FROM NEW.target_region_id
                   OR s.valid_to IS DISTINCT FROM e.effective_from
                   OR r.valid_from IS DISTINCT FROM e.effective_from
                   OR r.valid_to IS DISTINCT FROM e.effective_to
                   OR (e.continuation_assignment_id IS NOT NULL AND (
                     c.campus_region_change_id IS DISTINCT FROM NEW.id
                     OR c.person_id IS DISTINCT FROM e.person_id
                     OR c.campus_id IS DISTINCT FROM NEW.campus_id
                     OR c.region_id IS DISTINCT FROM NEW.source_region_id
                     OR c.valid_from IS DISTINCT FROM e.effective_to
                   ))
                 )) THEN
    RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_DUAL_SOURCE_INVALID';
  END IF;

  -- This is exactly the service's fee selection: an in-range teaching week
  -- whose referral receiver or referrer belongs to this campus at that week.
  SELECT count(*), count(*) FILTER (WHERE refund_id IS NOT NULL)
    INTO scoped_fee_count,refunded_fee_count
    FROM (
      SELECT fee.id,refund.finance_document_id refund_id
        FROM weekly_fee_entry fee
        JOIN referral_case referral ON referral.id=fee.referral_case_id
        JOIN teaching_week week ON week.id=fee.teaching_week_id
        LEFT JOIN weekly_fee_refund_effect refund ON refund.weekly_fee_entry_id=fee.id
       WHERE (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=NEW.effective_from
         AND (NEW.effective_to IS NULL OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<NEW.effective_to)
         AND EXISTS (
           SELECT 1 FROM person_campus_assignment assignment
            WHERE assignment.campus_id=NEW.campus_id
              AND (assignment.person_id=referral.receiver_person_id
                   OR assignment.person_id=referral.referrer_person_id)
              AND assignment.valid_from<=(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
              AND (assignment.valid_to IS NULL OR assignment.valid_to>(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai'))
         )
    ) scoped;
  eligible_fee_count:=scoped_fee_count-refunded_fee_count;
  SELECT count(*),COALESCE(sum(CASE WHEN jsonb_array_length(effect.delta_json->'entries')>0 THEN 1 ELSE 0 END),0)
    INTO effect_count,changed_effect_count
    FROM campus_region_assignment_settlement_effect effect WHERE effect.change_id=NEW.id;

  IF NEW.considered_fee_count<>scoped_fee_count
     OR NEW.excluded_refund_count<>refunded_fee_count
     OR NEW.changed_fee_count<>changed_effect_count
     OR effect_count<>eligible_fee_count
     OR EXISTS (
       SELECT 1 FROM campus_region_assignment_settlement_effect effect
        WHERE effect.change_id=NEW.id AND NOT EXISTS (
          SELECT 1
            FROM weekly_fee_entry fee
            JOIN referral_case referral ON referral.id=fee.referral_case_id
            JOIN teaching_week week ON week.id=fee.teaching_week_id
           WHERE fee.id=effect.weekly_fee_entry_id
             AND fee.version=effect.source_weekly_fee_version
             AND (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=NEW.effective_from
             AND (NEW.effective_to IS NULL OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<NEW.effective_to)
             AND EXISTS (
               SELECT 1 FROM person_campus_assignment assignment
                WHERE assignment.campus_id=NEW.campus_id
                  AND (assignment.person_id=referral.receiver_person_id
                       OR assignment.person_id=referral.referrer_person_id)
                  AND assignment.valid_from<=(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
                  AND (assignment.valid_to IS NULL OR assignment.valid_to>(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai'))
             )
             AND NOT EXISTS (SELECT 1 FROM weekly_fee_refund_effect refund WHERE refund.weekly_fee_entry_id=fee.id)
        )
     )
     OR EXISTS (
       SELECT 1
         FROM weekly_fee_entry fee
         JOIN referral_case referral ON referral.id=fee.referral_case_id
         JOIN teaching_week week ON week.id=fee.teaching_week_id
        WHERE (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=NEW.effective_from
          AND (NEW.effective_to IS NULL OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<NEW.effective_to)
          AND EXISTS (
            SELECT 1 FROM person_campus_assignment assignment
             WHERE assignment.campus_id=NEW.campus_id
               AND (assignment.person_id=referral.receiver_person_id
                    OR assignment.person_id=referral.referrer_person_id)
               AND assignment.valid_from<=(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
               AND (assignment.valid_to IS NULL OR assignment.valid_to>(week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai'))
          )
          AND NOT EXISTS (SELECT 1 FROM weekly_fee_refund_effect refund WHERE refund.weekly_fee_entry_id=fee.id)
          AND NOT EXISTS (
            SELECT 1 FROM campus_region_assignment_settlement_effect effect
             WHERE effect.change_id=NEW.id AND effect.weekly_fee_entry_id=fee.id
          )
     )
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_SETTLEMENT_SCOPE_INVALID'; END IF;

  IF eligible_fee_count=0 THEN
    IF NEW.settlement_calculation_run_id IS NOT NULL OR NEW.ledger_event_id IS NOT NULL
       OR NEW.posting_status<>'NO_BALANCE_CHANGE' THEN
      RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_NO_ELIGIBLE_SETTLEMENT_INVALID';
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*) INTO snapshot_count
    FROM weekly_fee_allocation_snapshot snapshot
   WHERE snapshot.run_id=NEW.settlement_calculation_run_id;
  IF NEW.settlement_calculation_run_id IS NULL OR snapshot_count<>effect_count
     OR EXISTS (
       SELECT 1 FROM weekly_fee_allocation_snapshot snapshot
        WHERE snapshot.run_id=NEW.settlement_calculation_run_id
          AND NOT EXISTS (
            SELECT 1 FROM campus_region_assignment_settlement_effect effect
             WHERE effect.change_id=NEW.id AND effect.result_snapshot_id=snapshot.id
          )
     )
     OR NOT EXISTS (
       SELECT 1 FROM settlement_calculation_run run
        JOIN campus_region_assignment_settlement_effect effect
          ON effect.change_id=NEW.id AND effect.weekly_fee_entry_id=run.fee_entry_id
         AND effect.source_weekly_fee_version=run.fee_version
       WHERE run.id=NEW.settlement_calculation_run_id
         AND run.actor_person_id=NEW.published_by_person_id
         AND run.status=NEW.posting_status
         AND run.request_key='campus-region-change:'||NEW.id::text
         AND run.ledger_event_id IS NOT DISTINCT FROM NEW.ledger_event_id
     )
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_RUN_INVALID'; END IF;

  IF NEW.posting_status='NO_BALANCE_CHANGE' THEN
    IF NEW.ledger_event_id IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM campus_region_assignment_settlement_effect effect
         CROSS JOIN LATERAL jsonb_array_elements(effect.delta_json->'entries') entry
          WHERE effect.change_id=NEW.id
         GROUP BY entry->>'accountKey',entry->>'categoryKey'
        HAVING sum((entry->>'amountCents')::bigint)<>0
       ) THEN
      RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_NO_BALANCE_INVALID';
    END IF;
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ledger_event event
     WHERE event.id=NEW.ledger_event_id
       AND event.event_key='weekly-settlement:campus-region-change:'||NEW.id::text
       AND event.event_type='WEEKLY_FEE_SETTLEMENT'
  ) OR NOT EXISTS (
    SELECT 1
      FROM campus_region_assignment_settlement_effect effect
      CROSS JOIN LATERAL jsonb_array_elements(effect.delta_json->'entries') entry
     WHERE effect.change_id=NEW.id
     GROUP BY entry->>'accountKey',entry->>'categoryKey'
    HAVING sum((entry->>'amountCents')::bigint)<>0
  ) OR EXISTS (
    WITH expected AS (
      SELECT account.id account_id,entry->>'categoryKey' category_key,
             sum((entry->>'amountCents')::bigint) amount_cents
        FROM campus_region_assignment_settlement_effect effect
        CROSS JOIN LATERAL jsonb_array_elements(effect.delta_json->'entries') entry
        JOIN settlement_account account ON account.account_code=entry->>'accountKey'
       WHERE effect.change_id=NEW.id
       GROUP BY account.id,entry->>'categoryKey'
      HAVING sum((entry->>'amountCents')::bigint)<>0
    ), actual AS (
      SELECT account_id,category_key,sum(amount_cents) amount_cents
        FROM ledger_entry WHERE event_id=NEW.ledger_event_id
       GROUP BY account_id,category_key
    ), mismatch AS (
      (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
    ) SELECT 1 FROM mismatch
  ) THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_POSTING_INVALID'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_campus_region_assignment_snapshot_append()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM campus_region_assignment_change c WHERE c.settlement_calculation_run_id=NEW.run_id)
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_TERMINAL_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_campus_region_assignment_ledger_append()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM campus_region_assignment_change c WHERE c.ledger_event_id=NEW.event_id)
  THEN RAISE EXCEPTION 'CAMPUS_REGION_ASSIGNMENT_CHANGE_TERMINAL_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campus_region_assignment_settlement_effect_shape
BEFORE INSERT ON campus_region_assignment_settlement_effect
FOR EACH ROW EXECUTE FUNCTION guard_campus_region_assignment_settlement_effect_shape();
CREATE CONSTRAINT TRIGGER campus_region_assignment_settlement_effect_parent_complete
AFTER INSERT ON campus_region_assignment_settlement_effect DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_campus_region_assignment_settlement_effect_parent();
CREATE TRIGGER campus_region_assignment_change_snapshot_terminal
BEFORE INSERT ON weekly_fee_allocation_snapshot
FOR EACH ROW EXECUTE FUNCTION guard_campus_region_assignment_snapshot_append();
CREATE TRIGGER campus_region_assignment_change_ledger_terminal
BEFORE INSERT ON ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_campus_region_assignment_ledger_append();
