-- GAP-005B2: atomic business identity configuration and switching.
CREATE TABLE teacher_profile_identity_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_event(id) DEFERRABLE INITIALLY DEFERRED,
  person_id uuid NOT NULL REFERENCES person(id),
  source_business_identity_version bigint,
  result_business_identity_version bigint NOT NULL CHECK (result_business_identity_version > 0),
  before_business_identity text CHECK (before_business_identity IN ('TEACHING_TEACHER','ACADEMIC_PLANNER')),
  after_business_identity text NOT NULL CHECK (after_business_identity IN ('TEACHING_TEACHER','ACADEMIC_PLANNER')),
  before_grade_subject text,
  after_grade_subject text,
  before_role_assignment_id uuid REFERENCES role_assignment(id),
  result_role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  before_auth_version bigint NOT NULL,
  result_auth_version bigint NOT NULL CHECK (result_auth_version > 0),
  actor_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  requested_grade_subject text,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (person_id, result_business_identity_version),
  UNIQUE (actor_person_id, idempotency_key),
  CHECK (result_auth_version = before_auth_version + 1),
  CHECK ((source_business_identity_version IS NULL AND before_business_identity IS NULL AND before_role_assignment_id IS NULL AND result_business_identity_version = 1)
      OR (source_business_identity_version IS NOT NULL AND before_business_identity IS NOT NULL AND before_role_assignment_id IS NOT NULL AND result_business_identity_version = source_business_identity_version + 1)),
  CHECK (before_business_identity IS NULL OR before_business_identity <> after_business_identity),
  CHECK (changed_at = created_at)
);
CREATE INDEX teacher_profile_identity_change_person_lookup ON teacher_profile_identity_change(person_id, result_business_identity_version DESC);

CREATE FUNCTION refuse_teacher_profile_identity_change_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_CHANGE_IMMUTABLE'; END; $$;
CREATE TRIGGER teacher_profile_identity_change_immutable
BEFORE UPDATE OR DELETE ON teacher_profile_identity_change
FOR EACH ROW EXECUTE FUNCTION refuse_teacher_profile_identity_change_mutation();

CREATE FUNCTION assert_teacher_profile_identity_write_context()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.teacher_profile_identity_write_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_WRITE_FORBIDDEN';
  END IF;
END; $$;

CREATE FUNCTION guard_teacher_profile_identity_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_identity IS DISTINCT FROM OLD.business_identity
     OR NEW.grade_subject IS DISTINCT FROM OLD.grade_subject THEN
    PERFORM assert_teacher_profile_identity_write_context();
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER teacher_profile_identity_write_guard
BEFORE UPDATE ON teacher_profile FOR EACH ROW EXECUTE FUNCTION guard_teacher_profile_identity_write();

CREATE FUNCTION guard_teacher_profile_identity_history_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_teacher_profile_identity_write_context(); RETURN NEW; END; $$;
CREATE TRIGGER teacher_profile_identity_history_insert_guard
BEFORE INSERT ON teacher_profile_identity_change
FOR EACH ROW EXECUTE FUNCTION guard_teacher_profile_identity_history_insert();

CREATE FUNCTION guard_teacher_profile_identity_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.action_code = 'TEACHER_PROFILE_IDENTITY_CHANGED' THEN
    PERFORM assert_teacher_profile_identity_write_context(); RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.action_code = 'TEACHER_PROFILE_IDENTITY_CHANGED' OR NEW.action_code = 'TEACHER_PROFILE_IDENTITY_CHANGED') THEN
    RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.action_code = 'TEACHER_PROFILE_IDENTITY_CHANGED' THEN
    RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER teacher_profile_identity_audit_guard
BEFORE INSERT OR UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION guard_teacher_profile_identity_audit();

CREATE FUNCTION enforce_teacher_profile_identity_triple()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF TG_TABLE_NAME = 'teacher_profile' AND TG_OP = 'INSERT' THEN
    IF current_setting('app.teacher_profile_identity_write_context', true) IS DISTINCT FROM 'service-v1' THEN RETURN NEW; END IF;
    SELECT count(*) INTO n FROM teacher_profile_identity_change h
     WHERE h.person_id=NEW.person_id AND h.source_business_identity_version IS NULL
       AND h.result_business_identity_version=NEW.business_identity_version
       AND h.before_business_identity IS NULL AND h.after_business_identity=NEW.business_identity
       AND h.before_grade_subject IS NULL AND h.after_grade_subject IS NOT DISTINCT FROM NEW.grade_subject;
    IF n <> 1 THEN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE'; END IF;
  ELSIF TG_TABLE_NAME = 'teacher_profile' THEN
    IF NEW.business_identity IS NOT DISTINCT FROM OLD.business_identity AND NEW.grade_subject IS NOT DISTINCT FROM OLD.grade_subject THEN RETURN NEW; END IF;
    SELECT count(*) INTO n FROM teacher_profile_identity_change h
     WHERE h.person_id=NEW.person_id AND h.source_business_identity_version=OLD.business_identity_version
       AND h.result_business_identity_version=NEW.business_identity_version
       AND h.before_business_identity=OLD.business_identity AND h.after_business_identity=NEW.business_identity
       AND h.before_grade_subject IS NOT DISTINCT FROM OLD.grade_subject AND h.after_grade_subject IS NOT DISTINCT FROM NEW.grade_subject;
    IF n <> 1 THEN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE'; END IF;
  ELSIF TG_TABLE_NAME = 'teacher_profile_identity_change' THEN
    SELECT count(*) INTO n FROM teacher_profile p JOIN user_account a ON a.person_id=p.person_id
     WHERE p.person_id=NEW.person_id AND p.business_identity=NEW.after_business_identity
       AND p.grade_subject IS NOT DISTINCT FROM NEW.after_grade_subject
       AND p.business_identity_version=NEW.result_business_identity_version
       AND a.auth_version=NEW.result_auth_version;
    IF n <> 1 THEN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE'; END IF;
    SELECT count(*) INTO n FROM audit_event e
     WHERE e.id=NEW.audit_event_id AND e.action_code='TEACHER_PROFILE_IDENTITY_CHANGED' AND e.subject_type='PERSON'
       AND e.subject_id=NEW.person_id AND e.actor_person_id=NEW.actor_person_id AND e.reason=NEW.reason
       AND e.before_json = jsonb_build_object('businessIdentity', NEW.before_business_identity, 'businessIdentityVersion', NEW.source_business_identity_version::text, 'gradeSubject', NEW.before_grade_subject, 'roleAssignmentId', NEW.before_role_assignment_id::text, 'authVersion', NEW.before_auth_version::text)
       AND e.after_json = jsonb_build_object('businessIdentity', NEW.after_business_identity, 'businessIdentityVersion', NEW.result_business_identity_version::text, 'gradeSubject', NEW.after_grade_subject, 'roleAssignmentId', NEW.result_role_assignment_id::text, 'authVersion', NEW.result_auth_version::text)
       AND e.created_at=NEW.changed_at;
    IF n <> 1 THEN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE'; END IF;
    SELECT count(*) INTO n FROM role_assignment r
     WHERE r.id=NEW.result_role_assignment_id AND r.person_id=NEW.person_id AND r.subject_code=NEW.after_business_identity
       AND r.scope_type='SELF' AND r.scope_id IS NULL AND r.valid_from=NEW.changed_at AND (r.valid_to IS NULL OR r.valid_to>NEW.changed_at);
    IF n <> 1 THEN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE'; END IF;
    IF NEW.before_role_assignment_id IS NOT NULL THEN
      SELECT count(*) INTO n FROM role_assignment r WHERE r.id=NEW.before_role_assignment_id AND r.person_id=NEW.person_id
        AND r.subject_code=NEW.before_business_identity AND r.scope_type='SELF' AND r.scope_id IS NULL AND r.valid_to=NEW.changed_at;
      IF n <> 1 THEN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'audit_event' AND TG_OP='INSERT' AND NEW.action_code='TEACHER_PROFILE_IDENTITY_CHANGED' THEN
    SELECT count(*) INTO n FROM teacher_profile_identity_change h
     WHERE h.audit_event_id=NEW.id AND h.person_id=NEW.subject_id AND h.actor_person_id=NEW.actor_person_id
       AND h.reason=NEW.reason AND h.changed_at=NEW.created_at
       AND NEW.before_json = jsonb_build_object('businessIdentity', h.before_business_identity, 'businessIdentityVersion', h.source_business_identity_version::text, 'gradeSubject', h.before_grade_subject, 'roleAssignmentId', h.before_role_assignment_id::text, 'authVersion', h.before_auth_version::text)
       AND NEW.after_json = jsonb_build_object('businessIdentity', h.after_business_identity, 'businessIdentityVersion', h.result_business_identity_version::text, 'gradeSubject', h.after_grade_subject, 'roleAssignmentId', h.result_role_assignment_id::text, 'authVersion', h.result_auth_version::text);
    IF n <> 1 THEN RAISE EXCEPTION 'TEACHER_PROFILE_IDENTITY_TRIPLE_INCOMPLETE'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;

CREATE CONSTRAINT TRIGGER teacher_profile_identity_profile_guard
AFTER UPDATE OF business_identity,grade_subject,business_identity_version ON teacher_profile
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_teacher_profile_identity_triple();
CREATE CONSTRAINT TRIGGER teacher_profile_identity_profile_insert_guard
AFTER INSERT ON teacher_profile DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_teacher_profile_identity_triple();
CREATE CONSTRAINT TRIGGER teacher_profile_identity_history_guard
AFTER INSERT ON teacher_profile_identity_change DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_teacher_profile_identity_triple();
CREATE CONSTRAINT TRIGGER teacher_profile_identity_audit_triple_guard
AFTER INSERT ON audit_event DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_teacher_profile_identity_triple();
