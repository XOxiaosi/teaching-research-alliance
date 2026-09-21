ALTER TABLE user_account
  ADD COLUMN auth_version bigint NOT NULL DEFAULT 1 CHECK (auth_version > 0);

CREATE OR REPLACE FUNCTION bump_user_account_auth_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.login_status IS DISTINCT FROM OLD.login_status THEN
    NEW.auth_version := OLD.auth_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_account_auth_version_guard
BEFORE UPDATE OF password_hash, login_status ON user_account
FOR EACH ROW EXECUTE FUNCTION bump_user_account_auth_version();

CREATE OR REPLACE FUNCTION invalidate_person_sessions_on_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE user_account
       SET auth_version = auth_version + 1,
           updated_at = now()
     WHERE person_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER person_status_invalidates_sessions
AFTER UPDATE OF status ON person
FOR EACH ROW EXECUTE FUNCTION invalidate_person_sessions_on_status_change();

CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES user_account(id),
  auth_version bigint NOT NULL CHECK (auth_version > 0),
  current_subject text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX user_session_account_lookup
  ON user_session (account_id, expires_at DESC);
CREATE INDEX user_session_expiry_lookup
  ON user_session (expires_at);
