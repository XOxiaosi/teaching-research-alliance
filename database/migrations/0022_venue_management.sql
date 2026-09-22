ALTER TABLE venue ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE venue_permission_grant ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE venue_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  operation text NOT NULL CHECK (operation IN ('CREATE','RENAME','STATUS','DEFAULT','PERMISSION')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  venue_id uuid NOT NULL REFERENCES venue(id),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, operation, idempotency_key)
);

CREATE INDEX venue_owner_lookup ON venue(owner_person_id, status, id);
CREATE INDEX venue_permission_active_lookup ON venue_permission_grant(grantee_person_id, venue_id, valid_from, valid_to);

CREATE OR REPLACE FUNCTION guard_venue_permission_grant_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.venue_id IS DISTINCT FROM OLD.venue_id
    OR NEW.grantee_person_id IS DISTINCT FROM OLD.grantee_person_id
    OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'VENUE_PERMISSION_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.version <> OLD.version + 1
    OR NEW.can_view IS DISTINCT FROM OLD.can_view OR NEW.can_withdraw IS DISTINCT FROM OLD.can_withdraw THEN
    RAISE EXCEPTION 'VENUE_PERMISSION_MUTATION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER venue_permission_grant_mutation_guard
BEFORE UPDATE ON venue_permission_grant
FOR EACH ROW EXECUTE FUNCTION guard_venue_permission_grant_mutation();

CREATE OR REPLACE FUNCTION refuse_venue_command_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'VENUE_COMMAND_IMMUTABLE'; END;
$$;
CREATE TRIGGER venue_command_idempotency_immutable
BEFORE UPDATE OR DELETE ON venue_command_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_venue_command_mutation();
