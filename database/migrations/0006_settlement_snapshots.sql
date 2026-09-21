CREATE TABLE rate_policy_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version bigint NOT NULL UNIQUE CHECK (version >= 0),
  effective_from date NOT NULL,
  policy_json jsonb NOT NULL CHECK (jsonb_typeof(policy_json) = 'object'),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  published_by uuid NOT NULL REFERENCES person(id),
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settlement_calculation_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key text NOT NULL UNIQUE CHECK (btrim(request_key) <> ''),
  fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  fee_version bigint NOT NULL CHECK (fee_version > 0),
  actor_person_id uuid NOT NULL REFERENCES person(id),
  status text NOT NULL CHECK (status IN ('POSTED', 'NO_BALANCE_CHANGE')),
  ledger_event_id uuid UNIQUE REFERENCES ledger_event(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (fee_entry_id, fee_version) REFERENCES weekly_fee_entry_version (weekly_fee_entry_id, version),
  CHECK (
    (status = 'POSTED' AND ledger_event_id IS NOT NULL)
    OR (status = 'NO_BALANCE_CHANGE' AND ledger_event_id IS NULL)
  )
);

CREATE TABLE weekly_fee_allocation_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  run_id uuid NOT NULL REFERENCES settlement_calculation_run(id),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  source_weekly_fee_version bigint NOT NULL CHECK (source_weekly_fee_version > 0),
  policy_version_id uuid NOT NULL REFERENCES rate_policy_version(id),
  net_monthly_cents bigint NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  context_json jsonb NOT NULL CHECK (jsonb_typeof(context_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (weekly_fee_entry_id, source_weekly_fee_version) REFERENCES weekly_fee_entry_version (weekly_fee_entry_id, version),
  UNIQUE (run_id, weekly_fee_entry_id)
);

CREATE TRIGGER rate_policy_version_immutable
BEFORE UPDATE OR DELETE ON rate_policy_version
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER settlement_calculation_run_immutable
BEFORE UPDATE OR DELETE ON settlement_calculation_run
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER weekly_fee_allocation_snapshot_immutable
BEFORE UPDATE OR DELETE ON weekly_fee_allocation_snapshot
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE INDEX rate_policy_version_effective_lookup
  ON rate_policy_version (effective_from DESC, version DESC);
CREATE INDEX settlement_calculation_run_fee_lookup
  ON settlement_calculation_run (fee_entry_id, fee_version, created_at DESC);
CREATE INDEX weekly_fee_allocation_snapshot_latest_lookup
  ON weekly_fee_allocation_snapshot (weekly_fee_entry_id, sequence_no DESC);
