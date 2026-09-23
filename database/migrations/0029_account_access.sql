-- F01: durable account-access throttling and password-reset command history.

CREATE TABLE auth_login_throttle (
  dimension_type text NOT NULL CHECK (dimension_type IN ('ACCOUNT','IP')),
  dimension_key text NOT NULL CHECK (dimension_key ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dimension_type, dimension_key),
  CHECK (blocked_until IS NULL OR blocked_until >= window_started_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX auth_login_throttle_blocked_lookup
  ON auth_login_throttle (blocked_until, dimension_type, dimension_key);
CREATE INDEX auth_login_throttle_updated_lookup
  ON auth_login_throttle (updated_at DESC, dimension_type, dimension_key);

CREATE TABLE auth_password_reset_command (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  target_account_id uuid NOT NULL REFERENCES user_account(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt-v1\$32768\$8\$3\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  result_auth_version bigint NOT NULL CHECK (result_auth_version > 0),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('SYSTEM_OWNER','SYSTEM_ADMIN')),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'GLOBAL'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_person_id, idempotency_key)
);

CREATE INDEX auth_password_reset_command_target_lookup
  ON auth_password_reset_command (target_account_id, created_at DESC);

CREATE FUNCTION refuse_auth_password_reset_command_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AUTH_PASSWORD_RESET_COMMAND_IMMUTABLE';
END;
$$;

CREATE TRIGGER auth_password_reset_command_immutable
BEFORE UPDATE OR DELETE ON auth_password_reset_command
FOR EACH ROW EXECUTE FUNCTION refuse_auth_password_reset_command_mutation();
