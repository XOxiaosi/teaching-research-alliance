-- GAP-002: managed person responsibilities and their replay-safe commands.

ALTER TABLE role_assignment
  ADD COLUMN reason text,
  ADD CONSTRAINT role_assignment_reason_length
    CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000);

-- A zero-length range records a cancelled future appointment without erasing it.
ALTER TABLE role_assignment
  DROP CONSTRAINT role_assignment_check,
  ADD CONSTRAINT role_assignment_valid_time_order
    CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- Responsibilities with the same subject and effective scope are a half-open time range.
-- Existing historical records remain valid; future management commands cannot overlap.
ALTER TABLE role_assignment
  ADD CONSTRAINT role_assignment_no_overlapping_responsibility
  EXCLUDE USING gist (
    person_id WITH =,
    subject_code WITH =,
    scope_type WITH =,
    (COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
  );

CREATE TABLE person_responsibility_command (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  command_kind text NOT NULL CHECK (command_kind IN ('ASSIGN','REVOKE','PERSON_STATUS')),
  target_person_id uuid NOT NULL REFERENCES person(id),
  role_assignment_id uuid REFERENCES role_assignment(id),
  subject_code text,
  scope_type text,
  scope_id uuid,
  valid_from timestamptz,
  valid_to timestamptz,
  next_person_status text CHECK (next_person_status IN ('ACTIVE','INACTIVE')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  result_auth_version bigint NOT NULL CHECK (result_auth_version > 0),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_person_id,idempotency_key),
  CHECK (
    (command_kind='ASSIGN' AND role_assignment_id IS NOT NULL AND subject_code IS NOT NULL
      AND scope_type IS NOT NULL AND valid_from IS NOT NULL AND next_person_status IS NULL)
    OR (command_kind='REVOKE' AND role_assignment_id IS NOT NULL AND valid_to IS NOT NULL
      AND subject_code IS NULL AND scope_type IS NULL AND next_person_status IS NULL)
    OR (command_kind='PERSON_STATUS' AND role_assignment_id IS NULL AND next_person_status IS NOT NULL
      AND subject_code IS NULL AND scope_type IS NULL AND valid_from IS NULL AND valid_to IS NULL)
  )
);

CREATE INDEX person_responsibility_command_target_lookup
  ON person_responsibility_command(target_person_id,created_at DESC);

CREATE FUNCTION refuse_person_responsibility_command_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PERSON_RESPONSIBILITY_COMMAND_IMMUTABLE';
END;
$$;

CREATE TRIGGER person_responsibility_command_immutable
BEFORE UPDATE OR DELETE ON person_responsibility_command
FOR EACH ROW EXECUTE FUNCTION refuse_person_responsibility_command_mutation();
