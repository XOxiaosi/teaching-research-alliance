-- GAP-005B1: administrator controlled person display/legal name corrections.
ALTER TABLE person
  ADD COLUMN profile_version bigint NOT NULL DEFAULT 1
    CHECK (profile_version > 0);

CREATE TABLE person_profile_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_event(id) DEFERRABLE INITIALLY DEFERRED,
  person_id uuid NOT NULL REFERENCES person(id),
  source_profile_version bigint NOT NULL CHECK (source_profile_version > 0),
  result_profile_version bigint NOT NULL CHECK (result_profile_version = source_profile_version + 1),
  before_nickname text NOT NULL,
  before_legal_name text NOT NULL,
  after_nickname text NOT NULL,
  after_legal_name text NOT NULL,
  actor_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (person_id, result_profile_version),
  UNIQUE (actor_person_id, idempotency_key),
  CHECK (before_nickname <> after_nickname OR before_legal_name <> after_legal_name),
  CHECK (changed_at = created_at)
);

CREATE INDEX person_profile_change_person_lookup
  ON person_profile_change(person_id, result_profile_version DESC);

CREATE FUNCTION refuse_person_profile_change_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PERSON_PROFILE_CHANGE_IMMUTABLE';
END;
$$;

CREATE TRIGGER person_profile_change_immutable
BEFORE UPDATE OR DELETE ON person_profile_change
FOR EACH ROW EXECUTE FUNCTION refuse_person_profile_change_mutation();

-- Profile corrections are one transaction: only the service-marked transaction
-- may change the current profile, append its history, or append the matching
-- audit event. SET LOCAL is deliberately transaction-scoped and is cleared on
-- pool connection reuse/rollback.
CREATE FUNCTION assert_person_profile_write_context()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.person_profile_write_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'PERSON_PROFILE_WRITE_FORBIDDEN';
  END IF;
END;
$$;

CREATE FUNCTION require_person_profile_write_context()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_person_profile_write_context();
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_person_profile_current_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nickname IS DISTINCT FROM OLD.nickname
     OR NEW.legal_name IS DISTINCT FROM OLD.legal_name
     OR NEW.profile_version IS DISTINCT FROM OLD.profile_version THEN
    PERFORM assert_person_profile_write_context();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER person_profile_current_write_guard
BEFORE UPDATE ON person
FOR EACH ROW EXECUTE FUNCTION guard_person_profile_current_write();

CREATE TRIGGER person_profile_change_insert_guard
BEFORE INSERT ON person_profile_change
FOR EACH ROW EXECUTE FUNCTION require_person_profile_write_context();

CREATE FUNCTION enforce_person_profile_triple()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  history_count integer;
  audit_count integer;
BEGIN
  IF TG_TABLE_NAME = 'person' THEN
    IF NEW.nickname IS NOT DISTINCT FROM OLD.nickname
       AND NEW.legal_name IS NOT DISTINCT FROM OLD.legal_name
       AND NEW.profile_version IS NOT DISTINCT FROM OLD.profile_version THEN
      RETURN NEW;
    END IF;
    SELECT count(*) INTO history_count
      FROM person_profile_change history
     WHERE history.person_id = NEW.id
       AND history.source_profile_version = OLD.profile_version
       AND history.result_profile_version = NEW.profile_version
       AND history.before_nickname = OLD.nickname
       AND history.before_legal_name = OLD.legal_name
       AND history.after_nickname = NEW.nickname
       AND history.after_legal_name = NEW.legal_name;
    IF history_count <> 1 THEN RAISE EXCEPTION 'PERSON_PROFILE_TRIPLE_INCOMPLETE'; END IF;
  ELSIF TG_TABLE_NAME = 'person_profile_change' THEN
    SELECT count(*) INTO audit_count
      FROM audit_event audit
     WHERE audit.id = NEW.audit_event_id
       AND audit.action_code = 'PERSON_PROFILE_CHANGED'
       AND audit.subject_type = 'PERSON'
       AND audit.subject_id = NEW.person_id
       AND audit.actor_person_id = NEW.actor_person_id
       AND audit.reason = NEW.reason
       AND audit.created_at = NEW.changed_at
       AND audit.before_json = jsonb_build_object('nickname', NEW.before_nickname, 'legalName', NEW.before_legal_name, 'profileVersion', NEW.source_profile_version::text)
       AND audit.after_json = jsonb_build_object('nickname', NEW.after_nickname, 'legalName', NEW.after_legal_name, 'profileVersion', NEW.result_profile_version::text);
    IF audit_count <> 1 THEN RAISE EXCEPTION 'PERSON_PROFILE_TRIPLE_INCOMPLETE'; END IF;
    SELECT count(*) INTO history_count
      FROM person current_person
     WHERE current_person.id = NEW.person_id
       AND current_person.nickname = NEW.after_nickname
       AND current_person.legal_name = NEW.after_legal_name
       AND current_person.profile_version = NEW.result_profile_version;
    IF history_count <> 1 THEN RAISE EXCEPTION 'PERSON_PROFILE_TRIPLE_INCOMPLETE'; END IF;
  ELSIF TG_TABLE_NAME = 'audit_event' AND TG_OP = 'INSERT' AND NEW.action_code = 'PERSON_PROFILE_CHANGED' THEN
    SELECT count(*) INTO history_count
      FROM person_profile_change history
     WHERE history.audit_event_id = NEW.id
       AND history.person_id = NEW.subject_id
       AND history.actor_person_id = NEW.actor_person_id
       AND history.reason = NEW.reason
       AND history.changed_at = NEW.created_at
       AND NEW.before_json = jsonb_build_object('nickname', history.before_nickname, 'legalName', history.before_legal_name, 'profileVersion', history.source_profile_version::text)
       AND NEW.after_json = jsonb_build_object('nickname', history.after_nickname, 'legalName', history.after_legal_name, 'profileVersion', history.result_profile_version::text);
    IF history_count <> 1 THEN RAISE EXCEPTION 'PERSON_PROFILE_TRIPLE_INCOMPLETE'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER person_profile_current_triple_guard
AFTER UPDATE OF nickname, legal_name, profile_version ON person
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_person_profile_triple();

CREATE CONSTRAINT TRIGGER person_profile_history_triple_guard
AFTER INSERT ON person_profile_change
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_person_profile_triple();

CREATE CONSTRAINT TRIGGER person_profile_audit_triple_guard
AFTER INSERT ON audit_event
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_person_profile_triple();

CREATE FUNCTION guard_person_profile_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.action_code = 'PERSON_PROFILE_CHANGED' THEN
    PERFORM assert_person_profile_write_context();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD.action_code = 'PERSON_PROFILE_CHANGED' OR NEW.action_code = 'PERSON_PROFILE_CHANGED') THEN
    RAISE EXCEPTION 'PERSON_PROFILE_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.action_code = 'PERSON_PROFILE_CHANGED' THEN
    RAISE EXCEPTION 'PERSON_PROFILE_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER person_profile_audit_event_guard
BEFORE INSERT OR UPDATE OR DELETE ON audit_event
FOR EACH ROW
EXECUTE FUNCTION guard_person_profile_audit_event();
