ALTER TABLE teacher_profile ADD COLUMN business_identity_version bigint NOT NULL DEFAULT 1 CHECK (business_identity_version > 0);
CREATE FUNCTION bump_business_identity_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_identity IS DISTINCT FROM OLD.business_identity THEN
    NEW.business_identity_version := OLD.business_identity_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER teacher_identity_version BEFORE UPDATE ON teacher_profile
FOR EACH ROW EXECUTE FUNCTION bump_business_identity_version();

CREATE TABLE referral_creation_snapshot (
  referral_case_id uuid PRIMARY KEY REFERENCES referral_case(id),
  source_subject text NOT NULL CHECK (source_subject IN ('TEACHING_TEACHER','ACADEMIC_PLANNER','PLANNING_MENTOR')),
  business_identity_version bigint NOT NULL CHECK (business_identity_version > 0),
  campus_assignment_id uuid NOT NULL REFERENCES person_campus_assignment(id),
  campus_id uuid NOT NULL REFERENCES organization_unit(id),
  planning_mentor_relationship_id uuid REFERENCES person_relationship(id),
  class_type text NOT NULL CHECK (class_type IN ('ONE_TO_ONE','SMALL_GROUP')),
  collector_person_id uuid NOT NULL REFERENCES person(id),
  created_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL
);
CREATE TABLE referral_creation_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id,idempotency_key)
);
CREATE FUNCTION refuse_referral_creation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REFERRAL_CREATION_IMMUTABLE';
END;
$$;
CREATE TRIGGER referral_creation_snapshot_immutable BEFORE UPDATE OR DELETE ON referral_creation_snapshot
FOR EACH ROW EXECUTE FUNCTION refuse_referral_creation_mutation();
CREATE TRIGGER referral_creation_idempotency_immutable BEFORE UPDATE OR DELETE ON referral_creation_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_referral_creation_mutation();
