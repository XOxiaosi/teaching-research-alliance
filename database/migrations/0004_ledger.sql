CREATE TABLE ledger_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES ledger_event(id),
  account_id uuid NOT NULL REFERENCES settlement_account(id),
  category_key text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, account_id, category_key)
);

CREATE TABLE account_balance_projection (
  account_id uuid PRIMARY KEY REFERENCES settlement_account(id),
  balance_cents bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE';
END;
$$;

CREATE TRIGGER ledger_event_immutable
BEFORE UPDATE OR DELETE ON ledger_event
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER ledger_entry_immutable
BEFORE UPDATE OR DELETE ON ledger_entry
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE INDEX ledger_entry_account_lookup ON ledger_entry (account_id, created_at);
CREATE INDEX ledger_entry_event_lookup ON ledger_entry (event_id);
