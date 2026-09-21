ALTER TABLE referral_case_event
  ADD COLUMN result_referral_version bigint;

CREATE TABLE referral_lifecycle_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('ARCHIVE', 'REACTIVATE')),
  request_hash text NOT NULL,
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  result_status text NOT NULL CHECK (result_status IN ('ARCHIVED', 'REACTIVATED')),
  result_referral_version bigint NOT NULL CHECK (result_referral_version > 0),
  result_unaccepted_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, idempotency_key)
);

CREATE FUNCTION refuse_referral_lifecycle_idempotency_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REFERRAL_LIFECYCLE_IDEMPOTENCY_IMMUTABLE';
END;
$$;

CREATE TRIGGER referral_lifecycle_idempotency_immutable
BEFORE UPDATE OR DELETE ON referral_lifecycle_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_referral_lifecycle_idempotency_mutation();

ALTER TABLE referral_acceptance_snapshot
  DROP CONSTRAINT referral_acceptance_snapshot_pkey;

ALTER TABLE referral_acceptance_snapshot
  ADD PRIMARY KEY (referral_case_id, accepted_referral_version);

ALTER TABLE referral_acceptance_idempotency
  ADD COLUMN accepted_referral_version bigint;

DROP TRIGGER referral_acceptance_idempotency_immutable ON referral_acceptance_idempotency;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM referral_acceptance_idempotency command
      LEFT JOIN referral_acceptance_snapshot snapshot
        ON snapshot.referral_case_id = command.referral_case_id
     WHERE snapshot.referral_case_id IS NULL
  ) THEN
    RAISE EXCEPTION 'REFERRAL_ACCEPTANCE_IDEMPOTENCY_SNAPSHOT_REQUIRED';
  END IF;
END;
$$;

UPDATE referral_acceptance_idempotency command
   SET accepted_referral_version = snapshot.accepted_referral_version
  FROM referral_acceptance_snapshot snapshot
 WHERE snapshot.referral_case_id = command.referral_case_id;

ALTER TABLE referral_acceptance_idempotency
  ALTER COLUMN accepted_referral_version SET NOT NULL,
  ADD CONSTRAINT referral_acceptance_idempotency_snapshot_fk
    FOREIGN KEY (referral_case_id, accepted_referral_version)
    REFERENCES referral_acceptance_snapshot (referral_case_id, accepted_referral_version);

CREATE TRIGGER referral_acceptance_idempotency_immutable
BEFORE UPDATE OR DELETE ON referral_acceptance_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_referral_acceptance_mutation();

CREATE INDEX referral_acceptance_snapshot_referral_lookup
  ON referral_acceptance_snapshot (referral_case_id, accepted_referral_version DESC);
