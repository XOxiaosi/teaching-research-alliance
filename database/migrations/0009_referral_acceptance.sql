CREATE TABLE referral_acceptance_snapshot (
  referral_case_id uuid PRIMARY KEY REFERENCES referral_case(id),
  venue_id uuid NOT NULL REFERENCES venue(id),
  venue_owner_person_id uuid NOT NULL REFERENCES person(id),
  is_self_use boolean NOT NULL,
  selection_source text NOT NULL CHECK (selection_source IN ('EXPLICIT', 'OWNER_DEFAULT')),
  accepted_referral_version bigint NOT NULL CHECK (accepted_referral_version > 0),
  accepted_by_person_id uuid NOT NULL REFERENCES person(id),
  accepted_at timestamptz NOT NULL
);

CREATE TABLE referral_acceptance_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, idempotency_key)
);

CREATE FUNCTION refuse_referral_acceptance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REFERRAL_ACCEPTANCE_IMMUTABLE';
END;
$$;

CREATE TRIGGER referral_acceptance_snapshot_immutable
BEFORE UPDATE OR DELETE ON referral_acceptance_snapshot
FOR EACH ROW EXECUTE FUNCTION refuse_referral_acceptance_mutation();

CREATE TRIGGER referral_acceptance_idempotency_immutable
BEFORE UPDATE OR DELETE ON referral_acceptance_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_referral_acceptance_mutation();
