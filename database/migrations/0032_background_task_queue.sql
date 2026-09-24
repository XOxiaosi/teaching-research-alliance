-- GAP-008a: durable internal task queue. Tasks never represent an end-user session.

CREATE TABLE background_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type text NOT NULL CHECK (task_type ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_failure_code text CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  last_failure_reason text CHECK (last_failure_reason IS NULL OR length(btrim(last_failure_reason)) BETWEEN 1 AND 1000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_type, idempotency_key),
  CHECK (attempt_count <= max_attempts),
  CHECK (
    (status = 'PENDING' AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (status = 'RUNNING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'SUCCEEDED' AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
    OR (status = 'FAILED' AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL AND last_failure_code IS NOT NULL AND last_failure_reason IS NOT NULL)
  )
);

CREATE INDEX background_task_claim_lookup
  ON background_task (available_at, created_at, id)
  WHERE status = 'PENDING';
CREATE INDEX background_task_expired_lease_lookup
  ON background_task (lease_expires_at, created_at, id)
  WHERE status = 'RUNNING';

CREATE TABLE background_task_attempt (
  task_id uuid NOT NULL REFERENCES background_task(id),
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  lease_token uuid NOT NULL UNIQUE,
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL CHECK (lease_expires_at > claimed_at),
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('RUNNING','SUCCEEDED','FAILED','LEASE_EXPIRED')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  failure_reason text CHECK (failure_reason IS NULL OR length(btrim(failure_reason)) BETWEEN 1 AND 1000),
  PRIMARY KEY (task_id, attempt_no),
  CHECK (
    (outcome = 'RUNNING' AND finished_at IS NULL AND failure_code IS NULL AND failure_reason IS NULL)
    OR (outcome = 'SUCCEEDED' AND finished_at IS NOT NULL AND failure_code IS NULL AND failure_reason IS NULL)
    OR (outcome IN ('FAILED','LEASE_EXPIRED') AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND failure_reason IS NOT NULL)
  )
);

CREATE INDEX background_task_attempt_history_lookup
  ON background_task_attempt (task_id, attempt_no DESC);
