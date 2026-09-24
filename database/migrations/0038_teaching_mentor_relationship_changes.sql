-- GAP-005-B3-2A: versioned ordinary-week teaching-mentor changes rebind only the
-- effective teachingMentor allocation account while preserving every prior fact.

ALTER TABLE person_relationship
  ADD COLUMN superseded_by_teaching_mentor_change_id uuid;

ALTER TABLE person_relationship
  DROP CONSTRAINT person_relationship_supersession_pair;
ALTER TABLE person_relationship
  ADD CONSTRAINT person_relationship_supersession_pair CHECK (
    (superseded_at IS NULL
      AND superseded_by_change_id IS NULL
      AND superseded_by_planning_mentor_change_id IS NULL
      AND superseded_by_teaching_mentor_change_id IS NULL)
    OR
    (superseded_at IS NOT NULL
      AND ((superseded_by_change_id IS NOT NULL)::integer
           + (superseded_by_planning_mentor_change_id IS NOT NULL)::integer
           + (superseded_by_teaching_mentor_change_id IS NOT NULL)::integer = 1))
  );

CREATE TABLE teaching_mentor_relationship_change_preview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('ADD','REPLACE')),
  relationship_type text NOT NULL CHECK (relationship_type = 'TEACHING_MENTOR'),
  teacher_person_id uuid NOT NULL REFERENCES person(id),
  source_relationship_id uuid REFERENCES person_relationship(id),
  source_related_person_id uuid REFERENCES person(id),
  new_related_person_id uuid NOT NULL REFERENCES person(id),
  candidate_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  effective_teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  effective_through_teaching_week_id uuid REFERENCES teaching_week(id),
  effective_at timestamptz NOT NULL,
  next_boundary_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  base_hash text NOT NULL CHECK (base_hash ~ '^[0-9a-f]{64}$'),
  impact_json jsonb NOT NULL CHECK (jsonb_typeof(impact_json) = 'object'),
  created_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'GLOBAL'),
  created_at timestamptz NOT NULL,
  CHECK ((action='ADD' AND source_relationship_id IS NULL AND source_related_person_id IS NULL) OR (action='REPLACE' AND source_relationship_id IS NOT NULL AND source_related_person_id IS NOT NULL)),
  CHECK (source_related_person_id IS NULL OR source_related_person_id <> new_related_person_id),
  CHECK (effective_through_teaching_week_id IS NULL OR next_boundary_at IS NOT NULL),
  CHECK (next_boundary_at IS NULL OR next_boundary_at > effective_at)
);

CREATE TABLE teaching_mentor_relationship_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id uuid NOT NULL UNIQUE REFERENCES teaching_mentor_relationship_change_preview(id),
  action text NOT NULL CHECK (action IN ('ADD','REPLACE')),
  relationship_type text NOT NULL CHECK (relationship_type = 'TEACHING_MENTOR'),
  teacher_person_id uuid NOT NULL REFERENCES person(id),
  relationship_version bigint NOT NULL CHECK (relationship_version > 0),
  source_relationship_id uuid REFERENCES person_relationship(id),
  result_relationship_id uuid NOT NULL UNIQUE REFERENCES person_relationship(id),
  continuation_relationship_id uuid UNIQUE REFERENCES person_relationship(id) DEFERRABLE INITIALLY DEFERRED,
  source_related_person_id uuid REFERENCES person(id),
  new_related_person_id uuid NOT NULL REFERENCES person(id),
  candidate_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  effective_teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  effective_through_teaching_week_id uuid REFERENCES teaching_week(id),
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
  moved_fee_count integer NOT NULL CHECK (moved_fee_count >= 0 AND moved_fee_count <= considered_fee_count),
  excluded_refund_count integer NOT NULL CHECK (excluded_refund_count >= 0),
  moved_amount_cents bigint NOT NULL CHECK (moved_amount_cents >= 0),
  before_json jsonb NOT NULL CHECK (jsonb_typeof(before_json) = 'object'),
  after_json jsonb NOT NULL CHECK (jsonb_typeof(after_json) = 'object'),
  published_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'GLOBAL'),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (teacher_person_id, relationship_type, relationship_version),
  UNIQUE (published_by_person_id, idempotency_key),
  CHECK ((action='ADD' AND source_relationship_id IS NULL AND source_related_person_id IS NULL) OR (action='REPLACE' AND source_relationship_id IS NOT NULL AND source_related_person_id IS NOT NULL)),
  CHECK (source_relationship_id IS NULL OR source_relationship_id <> result_relationship_id),
  CHECK (source_related_person_id IS NULL OR source_related_person_id <> new_related_person_id),
  CHECK (effective_through_teaching_week_id IS NULL OR next_boundary_at IS NOT NULL),
  CHECK (next_boundary_at IS NULL OR next_boundary_at > effective_at),
  CHECK (published_at = created_at),
  CHECK (
    (posting_status = 'POSTED' AND settlement_calculation_run_id IS NOT NULL
      AND ledger_event_id IS NOT NULL AND moved_fee_count > 0 AND moved_amount_cents > 0)
    OR
    (posting_status = 'NO_BALANCE_CHANGE' AND settlement_calculation_run_id IS NULL
      AND ledger_event_id IS NULL AND moved_fee_count = 0 AND moved_amount_cents = 0)
  )
);

ALTER TABLE person_relationship
  ADD CONSTRAINT person_relationship_superseded_teaching_mentor_change_fk
  FOREIGN KEY (superseded_by_teaching_mentor_change_id) REFERENCES teaching_mentor_relationship_change(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE teaching_mentor_relationship_change_effect (
  change_id uuid NOT NULL REFERENCES teaching_mentor_relationship_change(id),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  source_weekly_fee_version bigint NOT NULL CHECK (source_weekly_fee_version > 0),
  teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  settlement_month date NOT NULL,
  previous_snapshot_id uuid NOT NULL REFERENCES weekly_fee_allocation_snapshot(id),
  result_snapshot_id uuid NOT NULL UNIQUE REFERENCES weekly_fee_allocation_snapshot(id),
  settlement_calculation_run_id uuid NOT NULL REFERENCES settlement_calculation_run(id),
  teaching_mentor_amount_cents bigint NOT NULL CHECK (teaching_mentor_amount_cents > 0),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (change_id, weekly_fee_entry_id),
  FOREIGN KEY (weekly_fee_entry_id, source_weekly_fee_version)
    REFERENCES weekly_fee_entry_version(weekly_fee_entry_id, version),
  CHECK (source_account_id <> destination_account_id)
);

CREATE FUNCTION refuse_teaching_mentor_relationship_change_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_IMMUTABLE';
END;
$$;

CREATE FUNCTION teaching_mentor_timestamp_text(value timestamptz)
RETURNS text LANGUAGE sql STABLE RETURNS NULL ON NULL INPUT AS $$
  SELECT to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

CREATE FUNCTION teaching_mentor_relationship_fact(row_value person_relationship)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', row_value.id::text,
    'teacherPersonId', row_value.teacher_id::text,
    'relationshipType', row_value.relationship_type,
    'relatedPersonId', row_value.related_person_id::text,
    'validFrom', teaching_mentor_timestamp_text(row_value.valid_from),
    'validTo', teaching_mentor_timestamp_text(row_value.valid_to),
    'effectiveScope', row_value.effective_scope,
    'createdByPersonId', row_value.created_by::text,
    'createdAt', teaching_mentor_timestamp_text(row_value.created_at),
    'supersededAt', teaching_mentor_timestamp_text(row_value.superseded_at),
    'supersededByChangeId', row_value.superseded_by_teaching_mentor_change_id::text
  );
$$;

CREATE FUNCTION assert_teaching_mentor_published_person_relationship_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM teaching_mentor_relationship_change relationship_change
     WHERE relationship_change.source_relationship_id=OLD.id
        OR relationship_change.result_relationship_id=OLD.id
        OR relationship_change.continuation_relationship_id=OLD.id
  ) AND NOT EXISTS (
    SELECT 1 FROM teaching_mentor_relationship_change transition
     WHERE transition.source_relationship_id=OLD.id
       AND transition.before_json->'sourceRelationship'=teaching_mentor_relationship_fact(OLD)
       AND transition.after_json->'sourceRelationship'=teaching_mentor_relationship_fact(NEW)
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_teaching_mentor_published_person_relationship_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM teaching_mentor_relationship_change relationship_change
     WHERE relationship_change.source_relationship_id=OLD.id
        OR relationship_change.result_relationship_id=OLD.id
        OR relationship_change.continuation_relationship_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_PERSON_RELATIONSHIP_IMMUTABLE';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION guard_teaching_mentor_relationship_change_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_row teaching_mentor_relationship_change%ROWTYPE;
  previous_row weekly_fee_allocation_snapshot%ROWTYPE;
  result_row weekly_fee_allocation_snapshot%ROWTYPE;
  source_account settlement_account%ROWTYPE;
  destination_account settlement_account%ROWTYPE;
  line_amount bigint;
  group_line_count integer;
  fee_valid boolean;
BEGIN
  SELECT * INTO change_row FROM teaching_mentor_relationship_change WHERE id=NEW.change_id;
  SELECT * INTO previous_row FROM weekly_fee_allocation_snapshot WHERE id=NEW.previous_snapshot_id;
  SELECT * INTO result_row FROM weekly_fee_allocation_snapshot WHERE id=NEW.result_snapshot_id;
  SELECT * INTO source_account FROM settlement_account WHERE id=NEW.source_account_id;
  SELECT * INTO destination_account FROM settlement_account WHERE id=NEW.destination_account_id;

  SELECT count(*), min((line->>'cents')::bigint) INTO group_line_count,line_amount
    FROM jsonb_array_elements(previous_row.snapshot_json->'lines') line
   WHERE line->>'key'='teachingMentor';

  SELECT EXISTS (
    SELECT 1
      FROM weekly_fee_entry fee
      JOIN referral_case referral ON referral.id=fee.referral_case_id
      JOIN teaching_week week ON week.id=fee.teaching_week_id
     WHERE fee.id=NEW.weekly_fee_entry_id
       AND fee.version=NEW.source_weekly_fee_version
       AND fee.teaching_week_id=NEW.teaching_week_id
       AND fee.settlement_month=NEW.settlement_month
       AND referral.receiver_person_id=change_row.teacher_person_id
       AND week.week_kind='REGULAR'
       AND (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')>=change_row.effective_at
       AND (change_row.next_boundary_at IS NULL
            OR (week.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')<change_row.next_boundary_at)
       AND NOT EXISTS (
         SELECT 1 FROM weekly_fee_refund_effect refund WHERE refund.weekly_fee_entry_id=fee.id
       )
  ) INTO fee_valid;

  IF change_row.id IS NULL OR previous_row.id IS NULL OR result_row.id IS NULL
    OR source_account.id IS NULL OR destination_account.id IS NULL
    OR fee_valid IS DISTINCT FROM true
    OR group_line_count<>1
    OR change_row.settlement_calculation_run_id IS DISTINCT FROM NEW.settlement_calculation_run_id
    OR result_row.run_id IS DISTINCT FROM NEW.settlement_calculation_run_id
    OR previous_row.weekly_fee_entry_id IS DISTINCT FROM NEW.weekly_fee_entry_id
    OR result_row.weekly_fee_entry_id IS DISTINCT FROM NEW.weekly_fee_entry_id
    OR previous_row.source_weekly_fee_version IS DISTINCT FROM NEW.source_weekly_fee_version
    OR result_row.source_weekly_fee_version IS DISTINCT FROM NEW.source_weekly_fee_version
    OR previous_row.policy_version_id IS DISTINCT FROM result_row.policy_version_id
    OR previous_row.net_monthly_cents IS DISTINCT FROM result_row.net_monthly_cents
    OR result_row.sequence_no<=previous_row.sequence_no
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
    OR line_amount IS DISTINCT FROM NEW.teaching_mentor_amount_cents
    OR previous_row.snapshot_json->'lines' IS DISTINCT FROM result_row.snapshot_json->'lines'
    OR (previous_row.snapshot_json #- '{accountByKey,teachingMentor}'::text[])
       IS DISTINCT FROM (result_row.snapshot_json #- '{accountByKey,teachingMentor}'::text[])
    OR previous_row.snapshot_json#>>'{accountByKey,teachingMentor}' IS DISTINCT FROM source_account.account_code
    OR result_row.snapshot_json#>>'{accountByKey,teachingMentor}' IS DISTINCT FROM destination_account.account_code
    OR previous_row.context_json#>>'{relationships,teachingMentor,id}' IS DISTINCT FROM change_row.source_relationship_id::text
    OR previous_row.context_json#>>'{relationships,teachingMentor,personId}' IS DISTINCT FROM change_row.source_related_person_id::text
    OR previous_row.context_json#>>'{accounts,teachingMentor,ownerType}' IS DISTINCT FROM 'PERSON'
    OR previous_row.context_json#>>'{accounts,teachingMentor,ownerId}' IS DISTINCT FROM change_row.source_related_person_id::text
    OR previous_row.context_json#>>'{accounts,teachingMentor,accountId}' IS DISTINCT FROM source_account.id::text
    OR previous_row.context_json#>>'{accounts,teachingMentor,accountCode}' IS DISTINCT FROM source_account.account_code
    OR (previous_row.context_json #- '{relationships,teachingMentor}'::text[] #- '{accounts,teachingMentor}'::text[])
       IS DISTINCT FROM (result_row.context_json #- '{relationships,teachingMentor}'::text[] #- '{accounts,teachingMentor}'::text[])
    OR result_row.context_json#>>'{relationships,teachingMentor,id}' IS DISTINCT FROM change_row.result_relationship_id::text
    OR result_row.context_json#>>'{relationships,teachingMentor,personId}' IS DISTINCT FROM change_row.new_related_person_id::text
    OR result_row.context_json#>>'{accounts,teachingMentor,ownerType}' IS DISTINCT FROM 'PERSON'
    OR result_row.context_json#>>'{accounts,teachingMentor,ownerId}' IS DISTINCT FROM change_row.new_related_person_id::text
    OR result_row.context_json#>>'{accounts,teachingMentor,accountId}' IS DISTINCT FROM destination_account.id::text
    OR result_row.context_json#>>'{accounts,teachingMentor,accountCode}' IS DISTINCT FROM destination_account.account_code
    OR source_account.owner_type<>'PERSON' OR source_account.owner_id<>change_row.source_related_person_id
    OR destination_account.owner_type<>'PERSON' OR destination_account.owner_id<>change_row.new_related_person_id
    OR result_row.created_at IS DISTINCT FROM NEW.created_at
    OR NEW.created_at IS DISTINCT FROM change_row.created_at THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_EFFECT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION assert_teaching_mentor_relationship_change_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  effect_count integer;
  effect_total bigint;
  expected_entries integer;
  run_snapshot_count integer;
  preview_row teaching_mentor_relationship_change_preview%ROWTYPE;
  source_row person_relationship%ROWTYPE;
  result_row person_relationship%ROWTYPE;
  continuation_row person_relationship%ROWTYPE;
  week_row teaching_week%ROWTYPE;
  before_source jsonb;
  after_source jsonb;
  after_result jsonb;
  after_continuation jsonb;
BEGIN
  SELECT * INTO preview_row FROM teaching_mentor_relationship_change_preview WHERE id=NEW.preview_id;
  SELECT * INTO source_row FROM person_relationship WHERE id=NEW.source_relationship_id;
  SELECT * INTO result_row FROM person_relationship WHERE id=NEW.result_relationship_id;
  SELECT * INTO continuation_row FROM person_relationship WHERE id=NEW.continuation_relationship_id;
  SELECT * INTO week_row FROM teaching_week WHERE id=NEW.effective_teaching_week_id;
  before_source := NEW.before_json->'sourceRelationship';
  after_source := NEW.after_json->'sourceRelationship';
  after_result := NEW.after_json->'resultRelationship';
  after_continuation := NEW.after_json->'continuationRelationship';

  IF NOT EXISTS (
    SELECT 1 FROM teaching_mentor_relationship_change_preview preview
     WHERE preview.id=NEW.preview_id AND preview.action=NEW.action AND preview.relationship_type=NEW.relationship_type
       AND preview.teacher_person_id=NEW.teacher_person_id
       AND preview.source_relationship_id IS NOT DISTINCT FROM NEW.source_relationship_id
       AND preview.source_related_person_id IS NOT DISTINCT FROM NEW.source_related_person_id
       AND preview.new_related_person_id=NEW.new_related_person_id
       AND preview.candidate_role_assignment_id=NEW.candidate_role_assignment_id
       AND preview.effective_teaching_week_id=NEW.effective_teaching_week_id
       AND preview.effective_through_teaching_week_id IS NOT DISTINCT FROM NEW.effective_through_teaching_week_id
       AND preview.effective_at=NEW.effective_at
       AND preview.next_boundary_at IS NOT DISTINCT FROM NEW.next_boundary_at
       AND preview.reason=NEW.reason AND preview.base_hash=NEW.base_hash
       AND preview.actor_subject_code=NEW.actor_subject_code AND preview.actor_scope_type=NEW.actor_scope_type
       AND preview.created_at<=NEW.published_at
       AND (SELECT count(*) FROM role_assignment actor_role
             WHERE actor_role.person_id=preview.created_by_person_id
               AND actor_role.subject_code=preview.actor_subject_code
               AND actor_role.scope_type='GLOBAL' AND actor_role.scope_id IS NULL
               AND actor_role.valid_from<=preview.created_at
               AND (actor_role.valid_to IS NULL OR actor_role.valid_to>preview.created_at))=1
  ) OR NOT EXISTS (
    SELECT 1 FROM person_relationship relationship
     WHERE relationship.id=NEW.result_relationship_id
       AND relationship.teacher_id=NEW.teacher_person_id
       AND relationship.relationship_type=NEW.relationship_type
       AND relationship.related_person_id=NEW.new_related_person_id
       AND relationship.valid_from=NEW.effective_at
       AND relationship.valid_to IS NOT DISTINCT FROM NEW.next_boundary_at
       AND relationship.effective_scope='REGULAR_WEEK:' || NEW.effective_teaching_week_id::text
       AND relationship.created_by=NEW.published_by_person_id
       AND relationship.created_at=NEW.published_at
       AND relationship.superseded_at IS NULL
       AND relationship.superseded_by_teaching_mentor_change_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM role_assignment role
     WHERE role.id=NEW.candidate_role_assignment_id
       AND role.person_id=NEW.new_related_person_id
       AND role.subject_code='TEACHING_MENTOR' AND role.scope_type='MENTEES'
       AND (role.scope_id IS NULL OR role.scope_id=NEW.teacher_person_id)
       AND role.valid_from<=NEW.effective_at AND (role.valid_to IS NULL OR role.valid_to>NEW.effective_at)
       AND role.valid_from<=preview_row.created_at AND (role.valid_to IS NULL OR role.valid_to>preview_row.created_at)
       AND role.valid_from<=NEW.published_at AND (role.valid_to IS NULL OR role.valid_to>NEW.published_at)
       AND (NEW.next_boundary_at IS NULL OR role.valid_to IS NULL OR role.valid_to>=NEW.next_boundary_at)
       AND (
         (role.scope_id IS NULL AND (SELECT count(*) FROM role_assignment same_global
            WHERE same_global.person_id=role.person_id AND same_global.subject_code='TEACHING_MENTOR'
              AND same_global.scope_type='MENTEES' AND same_global.scope_id IS NULL
              AND same_global.valid_from<=NEW.effective_at AND (same_global.valid_to IS NULL OR same_global.valid_to>NEW.effective_at)
              AND same_global.valid_from<=preview_row.created_at AND (same_global.valid_to IS NULL OR same_global.valid_to>preview_row.created_at)
              AND same_global.valid_from<=NEW.published_at AND (same_global.valid_to IS NULL OR same_global.valid_to>NEW.published_at))=1)
         OR
         (role.scope_id IS NOT NULL
          AND (SELECT count(*) FROM role_assignment same_global
            WHERE same_global.person_id=role.person_id AND same_global.subject_code='TEACHING_MENTOR'
              AND same_global.scope_type='MENTEES' AND same_global.scope_id IS NULL
              AND same_global.valid_from<=NEW.effective_at AND (same_global.valid_to IS NULL OR same_global.valid_to>NEW.effective_at)
              AND same_global.valid_from<=preview_row.created_at AND (same_global.valid_to IS NULL OR same_global.valid_to>preview_row.created_at)
              AND same_global.valid_from<=NEW.published_at AND (same_global.valid_to IS NULL OR same_global.valid_to>NEW.published_at))=0
          AND (SELECT count(*) FROM role_assignment same_directed
            WHERE same_directed.person_id=role.person_id AND same_directed.subject_code='TEACHING_MENTOR'
              AND same_directed.scope_type='MENTEES' AND same_directed.scope_id=NEW.teacher_person_id
              AND same_directed.valid_from<=NEW.effective_at AND (same_directed.valid_to IS NULL OR same_directed.valid_to>NEW.effective_at)
              AND same_directed.valid_from<=preview_row.created_at AND (same_directed.valid_to IS NULL OR same_directed.valid_to>preview_row.created_at)
              AND same_directed.valid_from<=NEW.published_at AND (same_directed.valid_to IS NULL OR same_directed.valid_to>NEW.published_at))=1)
       )
  ) OR (SELECT count(*) FROM role_assignment actor_role
         WHERE actor_role.person_id=NEW.published_by_person_id
           AND actor_role.subject_code=NEW.actor_subject_code
           AND actor_role.scope_type='GLOBAL' AND actor_role.scope_id IS NULL
           AND actor_role.valid_from<=NEW.published_at
           AND (actor_role.valid_to IS NULL OR actor_role.valid_to>NEW.published_at))<>1
    OR NOT EXISTS (
      SELECT 1 FROM person candidate
      JOIN settlement_account account ON account.owner_type='PERSON' AND account.owner_id=candidate.id
       AND account.status='ACTIVE'
      WHERE candidate.id=NEW.new_related_person_id AND candidate.status='ACTIVE'
        AND account.id=(preview_row.impact_json#>>'{destinationAccount,id}')::uuid
        AND account.account_code=preview_row.impact_json#>>'{destinationAccount,code}'
        AND (SELECT count(*) FROM user_account login
              WHERE login.person_id=candidate.id AND login.login_status='ACTIVE')=1
        AND (SELECT count(*) FROM settlement_account active_account
              WHERE active_account.owner_type='PERSON' AND active_account.owner_id=candidate.id
                AND active_account.status='ACTIVE')=1
  ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;

  IF preview_row.id IS NULL OR result_row.id IS NULL OR week_row.id IS NULL
    OR NEW.considered_fee_count IS DISTINCT FROM (preview_row.impact_json#>>'{totals,consideredFeeCount}')::integer
    OR NEW.moved_fee_count IS DISTINCT FROM (preview_row.impact_json#>>'{totals,movedFeeCount}')::integer
    OR NEW.excluded_refund_count IS DISTINCT FROM (preview_row.impact_json#>>'{totals,excludedRefundCount}')::integer
    OR NEW.moved_amount_cents IS DISTINCT FROM (preview_row.impact_json#>>'{totals,movedAmountCents}')::bigint
    OR week_row.week_kind<>'REGULAR'
    OR NEW.effective_at IS DISTINCT FROM (week_row.starts_on::timestamp AT TIME ZONE 'Asia/Shanghai')
    OR (NEW.published_at AT TIME ZONE 'Asia/Shanghai')::date NOT BETWEEN week_row.starts_on AND week_row.ends_on
    OR result_row.teacher_id IS DISTINCT FROM NEW.teacher_person_id
    OR result_row.relationship_type IS DISTINCT FROM NEW.relationship_type
    OR result_row.related_person_id IS DISTINCT FROM NEW.new_related_person_id
    OR result_row.valid_from IS DISTINCT FROM NEW.effective_at
    OR result_row.valid_to IS DISTINCT FROM NEW.next_boundary_at
    OR result_row.effective_scope IS DISTINCT FROM 'REGULAR_WEEK:' || NEW.effective_teaching_week_id::text
    OR result_row.created_by IS DISTINCT FROM NEW.published_by_person_id
    OR result_row.created_at IS DISTINCT FROM NEW.published_at
    OR result_row.superseded_at IS NOT NULL OR result_row.superseded_by_teaching_mentor_change_id IS NOT NULL
    OR jsonb_typeof(after_result) IS DISTINCT FROM 'object'
    OR after_result IS DISTINCT FROM teaching_mentor_relationship_fact(result_row)
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.before_json))<>1
    OR (NEW.continuation_relationship_id IS NULL AND (SELECT count(*) FROM jsonb_object_keys(NEW.after_json))<>2)
    OR (NEW.continuation_relationship_id IS NOT NULL AND (SELECT count(*) FROM jsonb_object_keys(NEW.after_json))<>3)
    OR (NEW.action='ADD' AND (
      NEW.source_relationship_id IS NOT NULL OR NEW.source_related_person_id IS NOT NULL
      OR source_row.id IS NOT NULL OR before_source IS DISTINCT FROM 'null'::jsonb OR after_source IS DISTINCT FROM 'null'::jsonb
      OR NEW.continuation_relationship_id IS NOT NULL OR after_continuation IS NOT NULL
    ))
    OR (NEW.action='REPLACE' AND (
      source_row.id IS NULL OR source_row.teacher_id IS DISTINCT FROM NEW.teacher_person_id
      OR source_row.relationship_type IS DISTINCT FROM NEW.relationship_type
      OR source_row.related_person_id IS DISTINCT FROM NEW.source_related_person_id
      OR source_row.valid_from>NEW.effective_at
      OR jsonb_typeof(before_source) IS DISTINCT FROM 'object' OR jsonb_typeof(after_source) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(before_source))<>11
      OR before_source IS DISTINCT FROM preview_row.impact_json->'sourceRelationship'
      OR before_source->>'id' IS DISTINCT FROM NEW.source_relationship_id::text
      OR before_source->>'teacherPersonId' IS DISTINCT FROM NEW.teacher_person_id::text
      OR before_source->>'relationshipType' IS DISTINCT FROM NEW.relationship_type
      OR before_source->>'relatedPersonId' IS DISTINCT FROM NEW.source_related_person_id::text
      OR before_source->>'validFrom' IS DISTINCT FROM teaching_mentor_timestamp_text(source_row.valid_from)
      OR before_source->>'effectiveScope' IS DISTINCT FROM source_row.effective_scope
      OR before_source->>'createdByPersonId' IS DISTINCT FROM source_row.created_by::text
      OR before_source->>'createdAt' IS DISTINCT FROM teaching_mentor_timestamp_text(source_row.created_at)
      OR before_source->>'supersededAt' IS NOT NULL OR before_source->>'supersededByChangeId' IS NOT NULL
      OR after_source IS DISTINCT FROM teaching_mentor_relationship_fact(source_row)
      OR NOT (
        (source_row.valid_from<NEW.effective_at AND source_row.valid_to=NEW.effective_at
         AND source_row.superseded_at IS NULL AND source_row.superseded_by_teaching_mentor_change_id IS NULL)
        OR
        (source_row.valid_from=NEW.effective_at
         AND source_row.valid_to IS NOT DISTINCT FROM NEW.next_boundary_at
         AND source_row.superseded_at=NEW.published_at AND source_row.superseded_by_teaching_mentor_change_id=NEW.id)
      )
    ))
    OR (NEW.continuation_relationship_id IS NULL AND after_continuation IS NOT NULL)
    OR (NEW.continuation_relationship_id IS NOT NULL AND (
      continuation_row.id IS NULL OR NEW.action<>'REPLACE' OR NEW.next_boundary_at IS NULL
      OR jsonb_typeof(after_continuation) IS DISTINCT FROM 'object'
      OR after_continuation IS DISTINCT FROM teaching_mentor_relationship_fact(continuation_row)
      OR continuation_row.teacher_id IS DISTINCT FROM NEW.teacher_person_id
      OR continuation_row.relationship_type IS DISTINCT FROM NEW.relationship_type
      OR continuation_row.related_person_id IS DISTINCT FROM NEW.source_related_person_id
      OR continuation_row.valid_from IS DISTINCT FROM NEW.next_boundary_at
      OR continuation_row.valid_to IS DISTINCT FROM (before_source->>'validTo')::timestamptz
      OR continuation_row.effective_scope IS DISTINCT FROM source_row.effective_scope
      OR continuation_row.created_by IS DISTINCT FROM NEW.published_by_person_id
      OR continuation_row.created_at IS DISTINCT FROM NEW.published_at
      OR continuation_row.superseded_at IS NOT NULL OR continuation_row.superseded_by_teaching_mentor_change_id IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;

  SELECT count(*), COALESCE(sum(teaching_mentor_amount_cents),0)
    INTO effect_count,effect_total
    FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.id;
  IF effect_count<>NEW.moved_fee_count OR effect_total<>NEW.moved_amount_cents THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;

  IF NEW.posting_status='NO_BALANCE_CHANGE' THEN
    IF NEW.settlement_calculation_run_id IS DISTINCT FROM NULL
      OR NEW.ledger_event_id IS DISTINCT FROM NULL OR effect_count<>0 THEN
      RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
    END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM settlement_calculation_run run JOIN ledger_event event ON event.id=run.ledger_event_id
     WHERE run.id=NEW.settlement_calculation_run_id AND run.actor_person_id=NEW.published_by_person_id
       AND run.status='POSTED' AND run.ledger_event_id=NEW.ledger_event_id
       AND run.request_key='relationship-change:' || NEW.id::text
       AND event.event_key='weekly-settlement:' || run.request_key
       AND event.event_type='WEEKLY_FEE_SETTLEMENT'
  ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;

  SELECT count(*) INTO run_snapshot_count
    FROM weekly_fee_allocation_snapshot snapshot
   WHERE snapshot.run_id=NEW.settlement_calculation_run_id;
  IF run_snapshot_count<>effect_count
    OR EXISTS (
      SELECT 1 FROM weekly_fee_allocation_snapshot snapshot
       WHERE snapshot.run_id=NEW.settlement_calculation_run_id
         AND NOT EXISTS (
           SELECT 1 FROM teaching_mentor_relationship_change_effect effect
            WHERE effect.change_id=NEW.id AND effect.result_snapshot_id=snapshot.id
              AND effect.weekly_fee_entry_id=snapshot.weekly_fee_entry_id
              AND effect.source_weekly_fee_version=snapshot.source_weekly_fee_version
         )
    )
    OR NOT EXISTS (
      SELECT 1 FROM settlement_calculation_run run
      JOIN teaching_mentor_relationship_change_effect effect
        ON effect.change_id=NEW.id AND effect.weekly_fee_entry_id=run.fee_entry_id
       AND effect.source_weekly_fee_version=run.fee_version
       AND effect.settlement_calculation_run_id=run.id
      WHERE run.id=NEW.settlement_calculation_run_id
    ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;

  SELECT count(*) INTO expected_entries FROM (
    SELECT source_account_id AS account_id FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.id
    UNION
    SELECT destination_account_id AS account_id FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.id
  ) accounts;
  IF (SELECT count(*) FROM ledger_entry WHERE event_id=NEW.ledger_event_id)<>expected_entries
    OR EXISTS (
      SELECT 1 FROM (
        SELECT account_id, sum(amount_cents) amount_cents
          FROM ledger_entry WHERE event_id=NEW.ledger_event_id AND category_key='teachingMentor'
         GROUP BY account_id
      ) actual FULL JOIN (
        SELECT account_id, sum(amount_cents) amount_cents FROM (
          SELECT source_account_id account_id, -teaching_mentor_amount_cents amount_cents
            FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.id
          UNION ALL
          SELECT destination_account_id account_id, teaching_mentor_amount_cents amount_cents
            FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.id
        ) expected GROUP BY account_id
      ) expected USING(account_id)
      WHERE actual.amount_cents IS DISTINCT FROM expected.amount_cents
    ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT source_account_id account_id FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.id
        UNION
        SELECT destination_account_id account_id FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.id
      ) affected
      LEFT JOIN account_balance_projection projection ON projection.account_id=affected.account_id
     WHERE projection.account_id IS NULL OR projection.balance_cents IS DISTINCT FROM (
       SELECT COALESCE(sum(entry.amount_cents),0) FROM ledger_entry entry WHERE entry.account_id=affected.account_id
     )
  ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_teaching_mentor_relationship_change_effect_parent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_row teaching_mentor_relationship_change%ROWTYPE;
  effect_count integer;
  snapshot_count integer;
BEGIN
  SELECT * INTO change_row FROM teaching_mentor_relationship_change WHERE id=NEW.change_id;
  IF change_row.id IS NULL THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;
  SELECT count(*) INTO effect_count FROM teaching_mentor_relationship_change_effect WHERE change_id=NEW.change_id;
  SELECT count(*) INTO snapshot_count FROM weekly_fee_allocation_snapshot
   WHERE run_id=change_row.settlement_calculation_run_id;
  IF change_row.posting_status<>'POSTED'
    OR effect_count<>change_row.moved_fee_count
    OR snapshot_count<>effect_count
    OR NOT EXISTS (
      SELECT 1 FROM settlement_calculation_run run
      JOIN teaching_mentor_relationship_change_effect effect
        ON effect.change_id=change_row.id AND effect.weekly_fee_entry_id=run.fee_entry_id
       AND effect.source_weekly_fee_version=run.fee_version
      WHERE run.id=change_row.settlement_calculation_run_id
    ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_INCOMPLETE';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_teaching_mentor_relationship_change_snapshot_append()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM teaching_mentor_relationship_change relationship_change
     WHERE relationship_change.settlement_calculation_run_id=NEW.run_id
  ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_teaching_mentor_relationship_change_ledger_append()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM teaching_mentor_relationship_change relationship_change
     WHERE relationship_change.ledger_event_id=NEW.event_id
  ) THEN
    RAISE EXCEPTION 'PERSON_RELATIONSHIP_CHANGE_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER teaching_mentor_relationship_change_preview_immutable
BEFORE UPDATE OR DELETE ON teaching_mentor_relationship_change_preview
FOR EACH ROW EXECUTE FUNCTION refuse_teaching_mentor_relationship_change_mutation();
CREATE TRIGGER teaching_mentor_relationship_change_immutable
BEFORE UPDATE OR DELETE ON teaching_mentor_relationship_change
FOR EACH ROW EXECUTE FUNCTION refuse_teaching_mentor_relationship_change_mutation();
CREATE TRIGGER teaching_mentor_relationship_change_effect_guard
BEFORE INSERT ON teaching_mentor_relationship_change_effect
FOR EACH ROW EXECUTE FUNCTION guard_teaching_mentor_relationship_change_effect();
CREATE TRIGGER teaching_mentor_relationship_change_effect_immutable
BEFORE UPDATE OR DELETE ON teaching_mentor_relationship_change_effect
FOR EACH ROW EXECUTE FUNCTION refuse_teaching_mentor_relationship_change_mutation();
CREATE CONSTRAINT TRIGGER teaching_mentor_published_relationship_update_complete
AFTER UPDATE ON person_relationship DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_teaching_mentor_published_person_relationship_update();
CREATE TRIGGER teaching_mentor_relationship_published_delete_guard
BEFORE DELETE ON person_relationship
FOR EACH ROW EXECUTE FUNCTION guard_teaching_mentor_published_person_relationship_delete();
CREATE CONSTRAINT TRIGGER teaching_mentor_relationship_change_effect_parent_complete
AFTER INSERT ON teaching_mentor_relationship_change_effect DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_teaching_mentor_relationship_change_effect_parent();
CREATE CONSTRAINT TRIGGER teaching_mentor_relationship_change_complete
AFTER INSERT ON teaching_mentor_relationship_change DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_teaching_mentor_relationship_change_complete();
CREATE TRIGGER teaching_mentor_relationship_change_snapshot_terminal
BEFORE INSERT ON weekly_fee_allocation_snapshot
FOR EACH ROW EXECUTE FUNCTION guard_teaching_mentor_relationship_change_snapshot_append();
CREATE TRIGGER teaching_mentor_relationship_change_ledger_terminal
BEFORE INSERT ON ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_teaching_mentor_relationship_change_ledger_append();

CREATE INDEX teaching_mentor_relationship_active_lookup
  ON person_relationship(teacher_id,relationship_type,valid_from,valid_to)
  WHERE superseded_at IS NULL;
CREATE INDEX teaching_mentor_relationship_change_teacher_lookup
  ON teaching_mentor_relationship_change(teacher_person_id,relationship_type,relationship_version DESC);
CREATE INDEX teaching_mentor_relationship_change_publisher_lookup
  ON teaching_mentor_relationship_change(published_by_person_id,published_at DESC,id);
CREATE INDEX teaching_mentor_relationship_change_effect_fee_lookup
  ON teaching_mentor_relationship_change_effect(weekly_fee_entry_id,created_at DESC,change_id);
