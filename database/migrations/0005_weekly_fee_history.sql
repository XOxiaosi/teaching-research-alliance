ALTER TABLE teaching_week
  ADD COLUMN status text NOT NULL DEFAULT 'OPEN'
  CHECK (status IN ('OPEN', 'LOCKED'));

CREATE TABLE weekly_fee_entry_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  settlement_month date NOT NULL,
  gross_amount_cents bigint NOT NULL CHECK (gross_amount_cents >= 0),
  venue_id uuid NOT NULL REFERENCES venue(id),
  venue_owner_person_id uuid NOT NULL REFERENCES person(id),
  is_self_use_snapshot boolean NOT NULL,
  source_case_version bigint NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  recorded_by uuid NOT NULL REFERENCES person(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (weekly_fee_entry_id, version),
  UNIQUE (referral_case_id, teaching_week_id, version),
  CHECK (settlement_month = date_trunc('month', settlement_month)::date)
);

CREATE TABLE weekly_fee_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  actor_person_id uuid NOT NULL REFERENCES person(id),
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO weekly_fee_entry_version (
  weekly_fee_entry_id,
  referral_case_id,
  teaching_week_id,
  settlement_month,
  gross_amount_cents,
  venue_id,
  venue_owner_person_id,
  is_self_use_snapshot,
  source_case_version,
  version,
  recorded_by,
  recorded_at
)
SELECT id,
       referral_case_id,
       teaching_week_id,
       settlement_month,
       gross_amount_cents,
       venue_id,
       venue_owner_person_id,
       is_self_use_snapshot,
       source_case_version,
       version,
       created_by,
       created_at
  FROM weekly_fee_entry;

CREATE OR REPLACE FUNCTION snapshot_weekly_fee_entry_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO weekly_fee_entry_version (
    weekly_fee_entry_id,
    referral_case_id,
    teaching_week_id,
    settlement_month,
    gross_amount_cents,
    venue_id,
    venue_owner_person_id,
    is_self_use_snapshot,
    source_case_version,
    version,
    recorded_by,
    recorded_at
  ) VALUES (
    NEW.id,
    NEW.referral_case_id,
    NEW.teaching_week_id,
    NEW.settlement_month,
    NEW.gross_amount_cents,
    NEW.venue_id,
    NEW.venue_owner_person_id,
    NEW.is_self_use_snapshot,
    NEW.source_case_version,
    NEW.version,
    NEW.created_by,
    NEW.updated_at
  ) ON CONFLICT (weekly_fee_entry_id, version) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER weekly_fee_entry_version_snapshot
AFTER INSERT OR UPDATE OF settlement_month, gross_amount_cents, venue_id,
  venue_owner_person_id, is_self_use_snapshot, source_case_version, version,
  created_by, updated_at ON weekly_fee_entry
FOR EACH ROW EXECUTE FUNCTION snapshot_weekly_fee_entry_version();

CREATE INDEX weekly_fee_entry_version_lookup
  ON weekly_fee_entry_version (referral_case_id, teaching_week_id, version);
CREATE INDEX weekly_fee_idempotency_entry_lookup
  ON weekly_fee_idempotency (weekly_fee_entry_id, version);
