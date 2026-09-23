-- DEV-009: freeze the administrator-owned 1-10 bonus project catalog into
-- immutable name versions. Existing bonus rows keep their historical text;
-- every new row must reference the current catalog version.

CREATE TABLE bonus_project_slot (
  project_no integer PRIMARY KEY CHECK (project_no BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL
);

INSERT INTO bonus_project_slot(project_no,created_at)
SELECT project_no,'2026-09-23T00:00:00.000Z'::timestamptz
FROM generate_series(1,10) AS project_no;

CREATE TABLE bonus_project_name_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_no integer NOT NULL REFERENCES bonus_project_slot(project_no),
  version_no bigint NOT NULL CHECK (version_no > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  changed_by_person_id uuid REFERENCES person(id),
  actor_subject_code text CHECK (actor_subject_code IN ('SYSTEM_ADMIN','SYSTEM_OWNER')),
  actor_scope_type text CHECK (actor_scope_type = 'GLOBAL'),
  change_source text NOT NULL CHECK (change_source IN ('MIGRATION_DEFAULT','ADMIN')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  UNIQUE(project_no,version_no),
  UNIQUE(id,project_no,display_name),
  CHECK (
    (change_source='MIGRATION_DEFAULT' AND changed_by_person_id IS NULL AND actor_subject_code IS NULL AND actor_scope_type IS NULL)
    OR
    (change_source='ADMIN' AND changed_by_person_id IS NOT NULL AND actor_subject_code IS NOT NULL AND actor_scope_type='GLOBAL')
  )
);

INSERT INTO bonus_project_name_version(
  project_no,version_no,display_name,changed_by_person_id,actor_subject_code,actor_scope_type,change_source,reason,created_at
)
SELECT project_no,1,'项目' || project_no::text,NULL,NULL,NULL,'MIGRATION_DEFAULT','初始化项目名称目录',
       '2026-09-23T00:00:00.000Z'::timestamptz
FROM bonus_project_slot
ORDER BY project_no;

CREATE TABLE bonus_project_catalog_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation='RENAME'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(actor_person_id,idempotency_key)
);

CREATE FUNCTION refuse_bonus_project_catalog_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BONUS_PROJECT_CATALOG_IMMUTABLE';
END;
$$;

CREATE TRIGGER bonus_project_slot_immutable
BEFORE UPDATE OR DELETE ON bonus_project_slot
FOR EACH ROW EXECUTE FUNCTION refuse_bonus_project_catalog_mutation();

CREATE TRIGGER bonus_project_name_version_immutable
BEFORE UPDATE OR DELETE ON bonus_project_name_version
FOR EACH ROW EXECUTE FUNCTION refuse_bonus_project_catalog_mutation();

CREATE TRIGGER bonus_project_catalog_command_immutable
BEFORE UPDATE OR DELETE ON bonus_project_catalog_command_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_bonus_project_catalog_mutation();

ALTER TABLE project_bonus_transfer
  ADD COLUMN project_name_version_id uuid,
  ADD CONSTRAINT project_bonus_transfer_catalog_version_fk
    FOREIGN KEY(project_name_version_id,project_no,project_name)
    REFERENCES bonus_project_name_version(id,project_no,display_name);

CREATE FUNCTION guard_new_project_bonus_transfer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_version bigint;
  newest_version bigint;
  ledger_rows integer;
BEGIN
  IF NEW.project_name_version_id IS NULL THEN
    RAISE EXCEPTION 'BONUS_PROJECT_VERSION_REQUIRED';
  END IF;

  SELECT version_no INTO selected_version
    FROM bonus_project_name_version
   WHERE id=NEW.project_name_version_id
     AND project_no=NEW.project_no
     AND display_name=NEW.project_name;
  SELECT MAX(version_no) INTO newest_version
    FROM bonus_project_name_version
   WHERE project_no=NEW.project_no;
  IF selected_version IS NULL OR selected_version IS DISTINCT FROM newest_version THEN
    RAISE EXCEPTION 'BONUS_PROJECT_VERSION_CONFLICT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM finance_document document
     WHERE document.id=NEW.finance_document_id
       AND document.kind='PROJECT_BONUS'
       AND document.status='COMPLETED'
       AND document.applicant_person_id=NEW.granted_by_person_id
  ) OR NOT EXISTS (
    SELECT 1
      FROM settlement_account account
     WHERE account.id=NEW.source_account_id
       AND account.owner_type='COMPANY'
       AND account.owner_id=NEW.source_fund_id
  ) OR NOT EXISTS (
    SELECT 1
      FROM settlement_account account
     WHERE account.id=NEW.destination_account_id
       AND account.owner_type='PERSON'
       AND account.owner_id=NEW.recipient_person_id
  ) THEN
    RAISE EXCEPTION 'PROJECT_BONUS_TRANSFER_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM ledger_event event
     WHERE event.id=NEW.ledger_event_id
       AND event.event_type='PROJECT_BONUS_GRANTED'
       AND event.event_key='project-bonus:' || NEW.finance_document_id::text
  ) THEN
    RAISE EXCEPTION 'PROJECT_BONUS_LEDGER_INVALID';
  END IF;

  SELECT COUNT(*) INTO ledger_rows
    FROM ledger_entry entry
   WHERE entry.event_id=NEW.ledger_event_id
     AND (
       (entry.account_id=NEW.source_account_id AND entry.category_key='projectBonusExpense' AND entry.amount_cents=-NEW.amount_cents)
       OR
       (entry.account_id=NEW.destination_account_id AND entry.category_key='projectBonusIncome' AND entry.amount_cents=NEW.amount_cents)
     );
  IF ledger_rows<>2 OR (SELECT COUNT(*) FROM ledger_entry WHERE event_id=NEW.ledger_event_id)<>2 THEN
    RAISE EXCEPTION 'PROJECT_BONUS_LEDGER_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_bonus_transfer_catalog_guard
BEFORE INSERT ON project_bonus_transfer
FOR EACH ROW EXECUTE FUNCTION guard_new_project_bonus_transfer();

-- New wage confirmations preserve the exact deduction balance transition for
-- the management read model. Legacy rows remain readable with null snapshots.
ALTER TABLE cash_wage_confirmation
  ADD COLUMN destination_before_cents bigint,
  ADD COLUMN destination_after_cents bigint,
  ADD CONSTRAINT cash_wage_confirmation_balance_pair CHECK (
    (destination_before_cents IS NULL AND destination_after_cents IS NULL)
    OR
    (destination_before_cents IS NOT NULL AND destination_after_cents=destination_before_cents-deduction_cents)
  );

CREATE FUNCTION guard_new_cash_wage_balance_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.destination_before_cents IS NULL OR NEW.destination_after_cents IS NULL
    OR NEW.destination_after_cents<>NEW.destination_before_cents-NEW.deduction_cents THEN
    RAISE EXCEPTION 'CASH_WAGE_BALANCE_SNAPSHOT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cash_wage_confirmation_balance_guard
BEFORE INSERT ON cash_wage_confirmation
FOR EACH ROW EXECUTE FUNCTION guard_new_cash_wage_balance_snapshot();

CREATE INDEX bonus_project_name_current_lookup
  ON bonus_project_name_version(project_no,version_no DESC);
