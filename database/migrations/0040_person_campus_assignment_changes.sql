-- GAP-005C1 / P27: append-only administrator person-campus corrections.
-- `teacher_profile.campus_id/region_id` remains a current-display mirror only;
-- temporal organisation facts are always these two assignment tables.

ALTER TABLE person_campus_assignment
  ADD COLUMN superseded_by_person_campus_change_id uuid;

-- A zero-length source is an immutable record of a cancelled future
-- appointment. It has no business instant and does not overlap its replacement.
ALTER TABLE person_campus_assignment
  DROP CONSTRAINT person_campus_assignment_check,
  ADD CONSTRAINT person_campus_assignment_valid_time_order CHECK (valid_to IS NULL OR valid_to >= valid_from);
ALTER TABLE person_relationship
  DROP CONSTRAINT person_relationship_check,
  ADD CONSTRAINT person_relationship_valid_time_order CHECK (valid_to IS NULL OR valid_to >= valid_from);

ALTER TABLE person_relationship
  ADD COLUMN person_campus_change_id uuid;

CREATE TABLE person_campus_assignment_change_preview (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('TRANSFER','PRINCIPAL_REPAIR')),
  person_id uuid NOT NULL REFERENCES person(id),
  source_assignment_id uuid NOT NULL REFERENCES person_campus_assignment(id),
  result_assignment_id uuid,
  continuation_assignment_id uuid,
  source_campus_principal_relationship_id uuid REFERENCES person_relationship(id),
  result_campus_principal_relationship_id uuid,
  continuation_campus_principal_relationship_id uuid,
  target_campus_id uuid NOT NULL REFERENCES organization_unit(id),
  target_region_id uuid NOT NULL REFERENCES organization_unit(id),
  target_principal_person_id uuid NOT NULL REFERENCES person(id),
  target_principal_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
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
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((action='TRANSFER' AND result_assignment_id IS NOT NULL)
      OR (action='PRINCIPAL_REPAIR' AND result_assignment_id IS NULL AND continuation_assignment_id IS NULL))
);

CREATE TABLE person_campus_assignment_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id uuid NOT NULL UNIQUE REFERENCES person_campus_assignment_change_preview(id),
  action text NOT NULL CHECK (action IN ('TRANSFER','PRINCIPAL_REPAIR')),
  person_id uuid NOT NULL REFERENCES person(id),
  assignment_version bigint NOT NULL CHECK (assignment_version > 0),
  source_assignment_id uuid NOT NULL REFERENCES person_campus_assignment(id),
  result_assignment_id uuid REFERENCES person_campus_assignment(id),
  continuation_assignment_id uuid UNIQUE REFERENCES person_campus_assignment(id),
  source_campus_principal_relationship_id uuid REFERENCES person_relationship(id),
  result_campus_principal_relationship_id uuid NOT NULL UNIQUE REFERENCES person_relationship(id),
  continuation_campus_principal_relationship_id uuid UNIQUE REFERENCES person_relationship(id),
  target_campus_id uuid NOT NULL REFERENCES organization_unit(id),
  target_region_id uuid NOT NULL REFERENCES organization_unit(id),
  target_principal_person_id uuid NOT NULL REFERENCES person(id),
  target_principal_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  base_hash text NOT NULL CHECK (base_hash ~ '^[0-9a-f]{64}$'),
  posting_status text NOT NULL CHECK (posting_status IN ('POSTED','NO_BALANCE_CHANGE')),
  settlement_calculation_run_id uuid REFERENCES settlement_calculation_run(id),
  ledger_event_id uuid REFERENCES ledger_event(id),
  considered_fee_count integer NOT NULL CHECK (considered_fee_count>=0),
  changed_fee_count integer NOT NULL CHECK (changed_fee_count>=0 AND changed_fee_count<=considered_fee_count),
  excluded_refund_count integer NOT NULL CHECK (excluded_refund_count>=0),
  before_json jsonb NOT NULL CHECK (jsonb_typeof(before_json)='object'),
  after_json jsonb NOT NULL CHECK (jsonb_typeof(after_json)='object'),
  published_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  actor_scope_type text NOT NULL CHECK (actor_scope_type='GLOBAL'),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(person_id, assignment_version),
  UNIQUE(published_by_person_id,idempotency_key),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (published_at=created_at),
  -- A correction appends a settlement snapshot even where all account deltas
  -- cancel. That run is an auditable NO_BALANCE_CHANGE with no ledger event.
  CHECK (settlement_calculation_run_id IS NOT NULL OR considered_fee_count=excluded_refund_count),
  CHECK ((posting_status='POSTED' AND ledger_event_id IS NOT NULL)
      OR (posting_status='NO_BALANCE_CHANGE' AND ledger_event_id IS NULL)),
  CHECK ((action='TRANSFER' AND result_assignment_id IS NOT NULL)
      OR (action='PRINCIPAL_REPAIR' AND result_assignment_id IS NULL AND continuation_assignment_id IS NULL))
);

ALTER TABLE person_campus_assignment
  ADD CONSTRAINT person_campus_assignment_superseded_change_fk
  FOREIGN KEY (superseded_by_person_campus_change_id)
  REFERENCES person_campus_assignment_change(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE person_relationship
  ADD CONSTRAINT person_relationship_person_campus_change_fk
  FOREIGN KEY (person_campus_change_id)
  REFERENCES person_campus_assignment_change(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE person_campus_assignment_change_effect (
  change_id uuid NOT NULL REFERENCES person_campus_assignment_change(id),
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

CREATE FUNCTION assert_person_campus_assignment_region_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deferred so the P27 publisher can cut the old row and add its replacement
  -- atomically. The same check protects direct writes to either history source.
  IF NOT EXISTS (
    SELECT 1 FROM campus_region_assignment cr
     WHERE cr.campus_id=NEW.campus_id AND cr.region_id=NEW.region_id
       AND cr.valid_from<=NEW.valid_from
       AND (NEW.valid_to IS NULL OR cr.valid_to IS NULL OR cr.valid_to>=NEW.valid_to)
  ) THEN
    RAISE EXCEPTION 'PERSON_CAMPUS_REGION_ASSIGNMENT_COVERAGE_REQUIRED';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_campus_region_assignment_person_coverage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- On update/delete, test all dependent rows against the final table state.
  IF EXISTS (
    SELECT 1 FROM person_campus_assignment pa
     WHERE pa.campus_id=OLD.campus_id
       AND NOT EXISTS (
         SELECT 1 FROM campus_region_assignment cr
          WHERE cr.campus_id=pa.campus_id AND cr.region_id=pa.region_id
            AND cr.valid_from<=pa.valid_from
            AND (pa.valid_to IS NULL OR cr.valid_to IS NULL OR cr.valid_to>=pa.valid_to)
       )
  ) THEN RAISE EXCEPTION 'PERSON_CAMPUS_REGION_ASSIGNMENT_COVERAGE_REQUIRED'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER person_campus_assignment_region_coverage
AFTER INSERT OR UPDATE ON person_campus_assignment DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_person_campus_assignment_region_coverage();
CREATE CONSTRAINT TRIGGER campus_region_assignment_person_coverage
AFTER UPDATE OR DELETE ON campus_region_assignment DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_campus_region_assignment_person_coverage();

-- Migrations must not silently grandfather a split history. Existing fixture
-- rows may still be loaded with triggers disabled, but an ordinary migration
-- against application data fails closed until the two sources are reconciled.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM person_campus_assignment pa
     WHERE NOT EXISTS (
       SELECT 1 FROM campus_region_assignment cr
        WHERE cr.campus_id=pa.campus_id AND cr.region_id=pa.region_id
          AND cr.valid_from<=pa.valid_from
          AND (pa.valid_to IS NULL OR cr.valid_to IS NULL OR cr.valid_to>=pa.valid_to)
     )
  ) THEN RAISE EXCEPTION 'PERSON_CAMPUS_REGION_ASSIGNMENT_COVERAGE_REQUIRED'; END IF;
END;
$$;

CREATE FUNCTION refuse_person_campus_assignment_change_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PERSON_CAMPUS_ASSIGNMENT_CHANGE_IMMUTABLE'; END; $$;

CREATE FUNCTION assert_person_campus_assignment_change_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM audit_event a
       WHERE a.actor_person_id=NEW.published_by_person_id
         AND a.action_code='PERSON_CAMPUS_ASSIGNMENT_CHANGED'
         AND a.subject_type='PERSON_CAMPUS_ASSIGNMENT_CHANGE'
         AND a.subject_id=NEW.id
         AND a.reason=NEW.reason AND a.before_json=NEW.before_json
         AND a.after_json=NEW.after_json AND a.created_at=NEW.published_at)<>1 THEN
    RAISE EXCEPTION 'PERSON_CAMPUS_ASSIGNMENT_CHANGE_AUDIT_INVALID';
  END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION guard_person_campus_assignment_change_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP<>'INSERT' AND OLD.action_code='PERSON_CAMPUS_ASSIGNMENT_CHANGED')
     OR (TG_OP='INSERT' AND NEW.action_code='PERSON_CAMPUS_ASSIGNMENT_CHANGED'
         AND EXISTS (SELECT 1 FROM audit_event a WHERE a.action_code=NEW.action_code AND a.subject_id=NEW.subject_id AND a.created_at=NEW.created_at)) THEN
    RAISE EXCEPTION 'PERSON_CAMPUS_ASSIGNMENT_CHANGE_IMMUTABLE';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE FUNCTION assert_person_campus_assignment_change_audit_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_code='PERSON_CAMPUS_ASSIGNMENT_CHANGED' AND NOT EXISTS (
    SELECT 1 FROM person_campus_assignment_change c
     WHERE c.published_by_person_id=NEW.actor_person_id
       AND c.id=NEW.subject_id
       AND c.reason=NEW.reason AND c.before_json=NEW.before_json
       AND c.after_json=NEW.after_json AND c.published_at=NEW.created_at
  ) THEN RAISE EXCEPTION 'PERSON_CAMPUS_ASSIGNMENT_CHANGE_AUDIT_PARENT_INVALID'; END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER person_campus_assignment_change_preview_immutable BEFORE UPDATE OR DELETE ON person_campus_assignment_change_preview
FOR EACH ROW EXECUTE FUNCTION refuse_person_campus_assignment_change_mutation();
CREATE TRIGGER person_campus_assignment_change_immutable BEFORE UPDATE OR DELETE ON person_campus_assignment_change
FOR EACH ROW EXECUTE FUNCTION refuse_person_campus_assignment_change_mutation();
CREATE TRIGGER person_campus_assignment_change_effect_immutable BEFORE UPDATE OR DELETE ON person_campus_assignment_change_effect
FOR EACH ROW EXECUTE FUNCTION refuse_person_campus_assignment_change_mutation();
CREATE CONSTRAINT TRIGGER person_campus_assignment_change_audit_complete AFTER INSERT ON person_campus_assignment_change
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_person_campus_assignment_change_audit();
CREATE CONSTRAINT TRIGGER person_campus_assignment_change_audit_parent AFTER INSERT ON audit_event
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_person_campus_assignment_change_audit_insert();
CREATE TRIGGER person_campus_assignment_change_audit_immutable BEFORE INSERT OR UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION guard_person_campus_assignment_change_audit();

CREATE INDEX person_campus_assignment_change_person_lookup ON person_campus_assignment_change(person_id,assignment_version DESC);
CREATE INDEX person_campus_assignment_change_effect_fee_lookup ON person_campus_assignment_change_effect(weekly_fee_entry_id,created_at DESC);
CREATE UNIQUE INDEX person_campus_assignment_change_audit_subject_once
  ON audit_event(action_code,subject_id)
  WHERE action_code='PERSON_CAMPUS_ASSIGNMENT_CHANGED' AND subject_type='PERSON_CAMPUS_ASSIGNMENT_CHANGE';
