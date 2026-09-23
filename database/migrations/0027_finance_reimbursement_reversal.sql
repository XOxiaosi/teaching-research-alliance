-- DEV-008B: an immutable reimbursement reversal restores the original two-sided
-- transfer only after the document, command, ledger event and ledger entries agree.

ALTER TABLE finance_document DROP CONSTRAINT finance_document_status_check;
ALTER TABLE finance_document
  ADD CONSTRAINT finance_document_status_check CHECK (
    (kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED')) OR
    (kind = 'SELF_PURCHASE' AND status IN ('DRAFT','COMPLETED','REVERSED')) OR
    (kind = 'REIMBURSEMENT' AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','COMPLETED','REVERSED')) OR
    (kind = 'REFUND' AND status IN ('DRAFT','PENDING_APPROVAL','REFUNDED','REJECTED')) OR
    (kind IN ('CASH_WAGE','PROJECT_BONUS','FINANCE_BENEFIT') AND status IN ('DRAFT','COMPLETED','REVERSED')) OR
    (kind = 'EXTERNAL_PAYMENT' AND status = 'DRAFT')
  );

ALTER TABLE finance_document_event DROP CONSTRAINT finance_document_event_event_type_check;
ALTER TABLE finance_document_event
  ADD CONSTRAINT finance_document_event_event_type_check CHECK (event_type IN (
    'CREATED','SUBMITTED','TRANSFERRED','REVOKED','AUTO_COMPLETED','TRANSFER_REVERSED',
    'REIMBURSEMENT_SUBMITTED','REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED',
    'REIMBURSEMENT_COMPLETED','REIMBURSEMENT_REVERSED',
    'REFUND_SUBMITTED','REFUND_APPROVED','REFUND_REJECTED',
    'SALARY_BENEFIT_COMPLETED','SALARY_BENEFIT_REVERSED'
  ));

CREATE OR REPLACE FUNCTION guard_finance_document_withdrawal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.applicant_person_id IS DISTINCT FROM OLD.applicant_person_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FINANCE_DOCUMENT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.kind = 'WITHDRAWAL' THEN
    IF OLD.status='DRAFT' AND NEW.status='DRAFT' AND NEW.version IN (OLD.version,OLD.version+1) THEN RETURN NEW; END IF;
    IF OLD.status='DRAFT' AND NEW.status='PENDING_TRANSFER' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='PENDING_TRANSFER' AND NEW.status IN ('TRANSFERRED','FINANCE_REVOKED') AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
  END IF;
  IF OLD.kind='SELF_PURCHASE' THEN
    IF OLD.status='DRAFT' AND NEW.status='DRAFT' AND NEW.version IN (OLD.version,OLD.version+1) THEN RETURN NEW; END IF;
    IF OLD.status='DRAFT' AND NEW.status='COMPLETED' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='COMPLETED' AND NEW.status='REVERSED' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_SELF_PURCHASE_TRANSITION_INVALID';
  END IF;
  IF OLD.kind='REIMBURSEMENT' THEN
    IF OLD.status='DRAFT' AND NEW.status='DRAFT' AND NEW.version IN (OLD.version,OLD.version+1) THEN RETURN NEW; END IF;
    IF OLD.status='DRAFT' AND NEW.status='PENDING_APPROVAL' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='PENDING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED') AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='APPROVED' AND NEW.status='COMPLETED' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='COMPLETED' AND NEW.status='REVERSED' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_REIMBURSEMENT_TRANSITION_INVALID';
  END IF;
  IF OLD.kind='REFUND' THEN
    IF OLD.status='DRAFT' AND NEW.status='DRAFT' AND NEW.version IN (OLD.version,OLD.version+1) THEN RETURN NEW; END IF;
    IF OLD.status='DRAFT' AND NEW.status='PENDING_APPROVAL' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='PENDING_APPROVAL' AND NEW.status IN ('REFUNDED','REJECTED') AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_REFUND_TRANSITION_INVALID';
  END IF;
  IF OLD.kind IN ('CASH_WAGE','PROJECT_BONUS','FINANCE_BENEFIT') THEN
    IF OLD.status='DRAFT' AND NEW.status='COMPLETED' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='COMPLETED' AND NEW.status='REVERSED' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_SALARY_BENEFIT_TRANSITION_INVALID';
  END IF;
  IF OLD.status='DRAFT' AND NEW.status='DRAFT' AND NEW.version IN (OLD.version,OLD.version+1) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
END;
$$;

ALTER TABLE finance_reimbursement_command_idempotency
  DROP CONSTRAINT finance_reimbursement_command_idempotency_operation_check,
  DROP CONSTRAINT finance_reimbursement_command_idempotency_result_status_check,
  DROP CONSTRAINT finance_reimbursement_command_idempotency_check,
  ADD CONSTRAINT finance_reimbursement_command_idempotency_operation_check
    CHECK (operation IN ('SUBMIT','APPROVE','REJECT','EXECUTE','REVERSE')),
  ADD CONSTRAINT finance_reimbursement_command_idempotency_result_status_check
    CHECK (result_status IN ('PENDING_APPROVAL','APPROVED','REJECTED','COMPLETED','REVERSED')),
  ADD CONSTRAINT finance_reimbursement_command_idempotency_check CHECK (
    (operation='SUBMIT' AND result_status='PENDING_APPROVAL') OR
    (operation='APPROVE' AND result_status='APPROVED') OR
    (operation='REJECT' AND result_status='REJECTED') OR
    (operation='EXECUTE' AND result_status='COMPLETED') OR
    (operation='REVERSE' AND result_status='REVERSED')
  );

CREATE TABLE finance_reimbursement_reversal (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  source_document_version bigint NOT NULL CHECK (source_document_version > 0),
  result_document_version bigint NOT NULL CHECK (result_document_version = source_document_version + 1),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  original_ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  reversal_ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  reversed_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code IN ('HEADQUARTERS_FINANCE','SYSTEM_ADMIN','SYSTEM_OWNER')),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'GLOBAL'),
  authorization_snapshot jsonb NOT NULL,
  reversed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  source_before_cents bigint NOT NULL,
  source_after_cents bigint NOT NULL,
  destination_before_cents bigint NOT NULL,
  destination_after_cents bigint NOT NULL,
  CHECK (reversed_at = created_at),
  CHECK (source_account_id <> destination_account_id),
  CHECK (original_ledger_event_id <> reversal_ledger_event_id),
  CHECK (source_after_cents = source_before_cents + amount_cents),
  CHECK (destination_after_cents = destination_before_cents - amount_cents),
  FOREIGN KEY (finance_document_id) REFERENCES finance_reimbursement_transfer(finance_document_id)
);

CREATE UNIQUE INDEX finance_reimbursement_reverse_command_once
  ON finance_reimbursement_command_idempotency(finance_document_id) WHERE operation='REVERSE';
CREATE UNIQUE INDEX finance_reimbursement_reversed_event_once
  ON finance_document_event(finance_document_id) WHERE event_type='REIMBURSEMENT_REVERSED';

CREATE FUNCTION guard_finance_reimbursement_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_rows integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finance_document document
     WHERE document.id=NEW.finance_document_id AND document.kind='REIMBURSEMENT'
       AND document.status='REVERSED' AND document.version=NEW.result_document_version
       AND document.updated_at=NEW.reversed_at
  ) OR NOT EXISTS (
    SELECT 1 FROM finance_reimbursement_transfer transfer
     WHERE transfer.finance_document_id=NEW.finance_document_id
       AND transfer.result_document_version=NEW.source_document_version
       AND transfer.source_document_version + 1=transfer.result_document_version
       AND transfer.source_account_id=NEW.source_account_id
       AND transfer.destination_account_id=NEW.destination_account_id
       AND transfer.amount_cents=NEW.amount_cents
       AND transfer.ledger_event_id=NEW.original_ledger_event_id
       AND NEW.reversed_at>=transfer.executed_at
       AND jsonb_typeof(NEW.authorization_snapshot->'originalTransferAuthorization')='object'
       AND NEW.authorization_snapshot->'originalTransferAuthorization'=transfer.authorization_snapshot
       AND NEW.authorization_snapshot->>'originalLedgerEventId'=transfer.ledger_event_id::text
       AND NEW.authorization_snapshot->>'originalExecutedByPersonId'=transfer.executed_by_person_id::text
  ) OR NOT EXISTS (
    SELECT 1 FROM ledger_event event
     WHERE event.id=NEW.original_ledger_event_id AND event.event_type='REIMBURSEMENT_COMPLETED'
       AND event.event_key='reimbursement:' || NEW.finance_document_id::text
  ) OR NOT EXISTS (
    SELECT 1 FROM finance_reimbursement_command_idempotency command
     WHERE command.finance_document_id=NEW.finance_document_id AND command.operation='REVERSE'
       AND command.result_status='REVERSED' AND command.result_document_version=NEW.result_document_version
       AND command.actor_person_id=NEW.reversed_by_person_id AND command.created_at=NEW.reversed_at
  ) OR NOT EXISTS (
    SELECT 1 FROM role_assignment role
     WHERE role.person_id=NEW.reversed_by_person_id AND role.subject_code=NEW.actor_subject_code
       AND role.scope_type='GLOBAL' AND role.scope_id IS NULL AND role.valid_from<=NEW.reversed_at
       AND (role.valid_to IS NULL OR role.valid_to>NEW.reversed_at)
  ) OR NOT EXISTS (
    SELECT 1 FROM ledger_event event
     WHERE event.id=NEW.reversal_ledger_event_id AND event.event_type='REIMBURSEMENT_REVERSED'
       AND event.event_key='reimbursement-reversal:' || NEW.finance_document_id::text
  ) OR NOT EXISTS (
    SELECT 1 FROM finance_document_event event
     WHERE event.finance_document_id=NEW.finance_document_id AND event.event_type='REIMBURSEMENT_REVERSED'
       AND event.actor_person_id=NEW.reversed_by_person_id AND event.result_document_version=NEW.result_document_version
       AND event.ledger_event_id=NEW.reversal_ledger_event_id AND event.created_at=NEW.reversed_at
       AND event.details_json->>'processingMode'='MANUAL'
       AND event.details_json->>'reason'=NEW.reason
       AND event.details_json->>'originalLedgerEventId'=NEW.original_ledger_event_id::text
       AND event.details_json->>'actorSubjectCode'=NEW.actor_subject_code
       AND event.details_json->>'actorScopeType'=NEW.actor_scope_type
  ) OR NOT EXISTS (
    SELECT 1 FROM account_balance_projection source_projection
      JOIN account_balance_projection destination_projection ON destination_projection.account_id=NEW.destination_account_id
     WHERE source_projection.account_id=NEW.source_account_id
       AND source_projection.balance_cents=NEW.source_after_cents
       AND destination_projection.balance_cents=NEW.destination_after_cents
  ) OR (SELECT COUNT(*) FROM finance_reimbursement_command_idempotency command
         WHERE command.finance_document_id=NEW.finance_document_id)<>4
    OR (SELECT COUNT(*) FROM finance_reimbursement_command_idempotency command
         WHERE command.finance_document_id=NEW.finance_document_id AND command.operation='REVERSE')<>1
    OR (SELECT COUNT(*) FROM finance_document_event event
         WHERE event.finance_document_id=NEW.finance_document_id)<>5
    OR (SELECT COUNT(*) FROM finance_document_event event
         WHERE event.finance_document_id=NEW.finance_document_id AND event.event_type='REIMBURSEMENT_REVERSED')<>1
    OR jsonb_typeof(NEW.authorization_snapshot) IS DISTINCT FROM 'object'
    OR NEW.authorization_snapshot->>'actorPersonId' IS DISTINCT FROM NEW.reversed_by_person_id::text
    OR NEW.authorization_snapshot->>'actorSubjectCode' IS DISTINCT FROM NEW.actor_subject_code
    OR NEW.authorization_snapshot->>'actorScopeType' IS DISTINCT FROM NEW.actor_scope_type
    OR NEW.authorization_snapshot->>'processingMode' IS DISTINCT FROM 'MANUAL' THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_REVERSAL_INVALID';
  END IF;

  SELECT COUNT(*) INTO ledger_rows
    FROM ledger_entry entry
   WHERE entry.event_id=NEW.original_ledger_event_id AND (
     (entry.account_id=NEW.source_account_id AND entry.category_key='reimbursementExpense' AND entry.amount_cents=-NEW.amount_cents)
     OR (entry.account_id=NEW.destination_account_id AND entry.category_key='reimbursementIncome' AND entry.amount_cents=NEW.amount_cents)
   );
  IF ledger_rows<>2 OR (SELECT COUNT(*) FROM ledger_entry WHERE event_id=NEW.original_ledger_event_id)<>2 THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_REVERSAL_INVALID';
  END IF;

  SELECT COUNT(*) INTO ledger_rows
    FROM ledger_entry entry
   WHERE entry.event_id=NEW.reversal_ledger_event_id AND (
     (entry.account_id=NEW.source_account_id AND entry.category_key='reimbursementExpenseReversal' AND entry.amount_cents=NEW.amount_cents)
     OR (entry.account_id=NEW.destination_account_id AND entry.category_key='reimbursementIncomeReversal' AND entry.amount_cents=-NEW.amount_cents)
   );
  IF ledger_rows<>2 OR (SELECT COUNT(*) FROM ledger_entry WHERE event_id=NEW.reversal_ledger_event_id)<>2 THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_REVERSAL_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refuse_finance_reimbursement_reversal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_REVERSAL_IMMUTABLE'; END;
$$;

CREATE FUNCTION guard_finance_reimbursement_terminal_command_append() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_reimbursement_reversal reversal WHERE reversal.finance_document_id=NEW.finance_document_id) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_finance_reimbursement_terminal_event_append() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_reimbursement_reversal reversal WHERE reversal.finance_document_id=NEW.finance_document_id) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_finance_reimbursement_ledger_append() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_reimbursement_transfer transfer WHERE transfer.ledger_event_id=NEW.event_id)
    OR EXISTS (
      SELECT 1 FROM finance_reimbursement_reversal reversal
       WHERE reversal.original_ledger_event_id=NEW.event_id OR reversal.reversal_ledger_event_id=NEW.event_id
    ) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_LEDGER_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION assert_finance_reimbursement_reversed_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finance_reimbursement_reversal reversal
     WHERE reversal.finance_document_id=NEW.id AND reversal.result_document_version=NEW.version
  ) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_REVERSED_INCOMPLETE';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER finance_reimbursement_reversal_guard BEFORE INSERT ON finance_reimbursement_reversal
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_reversal();
CREATE TRIGGER finance_reimbursement_reversal_immutable BEFORE UPDATE OR DELETE ON finance_reimbursement_reversal
FOR EACH ROW EXECUTE FUNCTION refuse_finance_reimbursement_reversal_mutation();
CREATE TRIGGER finance_reimbursement_terminal_command_append BEFORE INSERT ON finance_reimbursement_command_idempotency
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_terminal_command_append();
CREATE TRIGGER finance_reimbursement_terminal_event_append BEFORE INSERT ON finance_document_event
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_terminal_event_append();
CREATE TRIGGER finance_reimbursement_ledger_append BEFORE INSERT ON ledger_entry
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_ledger_append();
CREATE CONSTRAINT TRIGGER finance_reimbursement_reversed_document_complete
AFTER INSERT OR UPDATE ON finance_document DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.kind='REIMBURSEMENT' AND NEW.status='REVERSED')
EXECUTE FUNCTION assert_finance_reimbursement_reversed_document();

CREATE INDEX finance_reimbursement_reversal_actor_lookup
  ON finance_reimbursement_reversal(reversed_by_person_id,reversed_at DESC,finance_document_id);
CREATE INDEX finance_reimbursement_reversal_source_lookup
  ON finance_reimbursement_reversal(source_account_id,reversed_at DESC,finance_document_id);
CREATE INDEX finance_reimbursement_reversal_destination_lookup
  ON finance_reimbursement_reversal(destination_account_id,reversed_at DESC,finance_document_id);
