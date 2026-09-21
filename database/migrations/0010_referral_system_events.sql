ALTER TABLE referral_case_event
  ALTER COLUMN actor_person_id DROP NOT NULL;

ALTER TABLE referral_case_event
  ADD COLUMN actor_type text NOT NULL DEFAULT 'PERSON'
  CHECK (actor_type IN ('PERSON', 'SYSTEM')),
  ADD CONSTRAINT referral_case_event_actor_consistency
  CHECK (
    (actor_type = 'PERSON' AND actor_person_id IS NOT NULL)
    OR (actor_type = 'SYSTEM' AND actor_person_id IS NULL)
  );

CREATE OR REPLACE FUNCTION refuse_referral_case_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REFERRAL_CASE_EVENT_IMMUTABLE';
END;
$$;

CREATE TRIGGER referral_case_event_immutable
BEFORE UPDATE OR DELETE ON referral_case_event
FOR EACH ROW EXECUTE FUNCTION refuse_referral_case_event_mutation();

CREATE INDEX referral_case_unaccepted_expiry_lookup
  ON referral_case (unaccepted_expires_at, id)
  WHERE status IN ('PENDING', 'REACTIVATED')
    AND unaccepted_expires_at IS NOT NULL;
