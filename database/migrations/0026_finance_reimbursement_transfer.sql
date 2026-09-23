-- DEV-008A: an approved ordinary reimbursement becomes complete only after its
-- immutable, two-sided internal ledger posting succeeds.

ALTER TABLE finance_document DROP CONSTRAINT finance_document_status_check;
ALTER TABLE finance_document
  ADD CONSTRAINT finance_document_status_check CHECK (
    (kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED')) OR
    (kind = 'SELF_PURCHASE' AND status IN ('DRAFT','COMPLETED','REVERSED')) OR
    (kind = 'REIMBURSEMENT' AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','COMPLETED')) OR
    (kind = 'REFUND' AND status IN ('DRAFT','PENDING_APPROVAL','REFUNDED','REJECTED')) OR
    (kind IN ('CASH_WAGE','PROJECT_BONUS','FINANCE_BENEFIT') AND status IN ('DRAFT','COMPLETED','REVERSED')) OR
    (kind = 'EXTERNAL_PAYMENT' AND status = 'DRAFT')
  );

ALTER TABLE finance_document_event DROP CONSTRAINT finance_document_event_event_type_check;
ALTER TABLE finance_document_event
  ADD CONSTRAINT finance_document_event_event_type_check CHECK (event_type IN (
    'CREATED','SUBMITTED','TRANSFERRED','REVOKED','AUTO_COMPLETED','TRANSFER_REVERSED',
    'REIMBURSEMENT_SUBMITTED','REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED','REIMBURSEMENT_COMPLETED',
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
    CHECK (operation IN ('SUBMIT','APPROVE','REJECT','EXECUTE')),
  ADD CONSTRAINT finance_reimbursement_command_idempotency_result_status_check
    CHECK (result_status IN ('PENDING_APPROVAL','APPROVED','REJECTED','COMPLETED')),
  ADD CONSTRAINT finance_reimbursement_command_idempotency_check CHECK (
    (operation='SUBMIT' AND result_status='PENDING_APPROVAL') OR
    (operation='APPROVE' AND result_status='APPROVED') OR
    (operation='REJECT' AND result_status='REJECTED') OR
    (operation='EXECUTE' AND result_status='COMPLETED')
  );

CREATE TABLE finance_reimbursement_transfer (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  source_document_version bigint NOT NULL CHECK (source_document_version > 0),
  result_document_version bigint NOT NULL CHECK (result_document_version = source_document_version + 1),
  role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  company_fund_assignment_id uuid NOT NULL REFERENCES company_finance_fund_assignment(id),
  source_fund_id uuid NOT NULL REFERENCES company_finance_fund(id),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  authorization_snapshot jsonb NOT NULL,
  ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  executed_by_person_id uuid NOT NULL REFERENCES person(id),
  executed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  source_before_cents bigint NOT NULL,
  source_after_cents bigint NOT NULL,
  destination_before_cents bigint NOT NULL,
  destination_after_cents bigint NOT NULL,
  CHECK (executed_at = created_at),
  CHECK (source_after_cents = source_before_cents - amount_cents),
  CHECK (destination_after_cents = destination_before_cents + amount_cents)
);

CREATE FUNCTION guard_finance_reimbursement_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_rows integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finance_document document
     WHERE document.id=NEW.finance_document_id AND document.kind='REIMBURSEMENT'
       AND document.status='COMPLETED' AND document.version=NEW.result_document_version
  ) OR NOT EXISTS (
    SELECT 1 FROM finance_reimbursement_submission submission
      JOIN finance_reimbursement_decision decision ON decision.finance_document_id=submission.finance_document_id
      JOIN finance_document document ON document.id=submission.finance_document_id
     WHERE submission.finance_document_id=NEW.finance_document_id
       AND submission.result_document_version=decision.source_document_version
       AND decision.decision='APPROVED' AND decision.result_document_version=NEW.source_document_version
       AND submission.submitted_at>=document.created_at AND decision.decided_at>=submission.submitted_at
       AND NEW.executed_at>=decision.decided_at AND decision.created_at=decision.decided_at
       AND EXISTS (
         SELECT 1 FROM finance_reimbursement_command_idempotency command
          WHERE command.finance_document_id=submission.finance_document_id AND command.operation='SUBMIT'
            AND command.actor_person_id=submission.submitted_by_person_id AND command.result_status='PENDING_APPROVAL'
            AND command.result_document_version=submission.result_document_version AND command.created_at=submission.submitted_at
       )
       AND EXISTS (
         SELECT 1 FROM finance_reimbursement_command_idempotency command
          WHERE command.finance_document_id=decision.finance_document_id AND command.operation='APPROVE'
            AND command.actor_person_id=decision.decided_by_person_id AND command.result_status='APPROVED'
            AND command.result_document_version=decision.result_document_version AND command.created_at=decision.decided_at
       )
       AND jsonb_typeof(decision.authorization_snapshot)='object'
       AND decision.authorization_snapshot->>'reviewerPersonId'=decision.decided_by_person_id::text
       AND decision.authorization_snapshot->>'reviewerSubjectCode'='HEADQUARTERS_FINANCE'
       AND decision.authorization_snapshot->>'reviewerScopeType'='GLOBAL'
       AND (decision.authorization_snapshot->'reviewerContextRegionId')='null'::jsonb
       AND (decision.authorization_snapshot->'reviewerContextCampusId')='null'::jsonb
       AND (decision.authorization_snapshot->'reviewerContextVenueId')='null'::jsonb
       AND jsonb_typeof(decision.authorization_snapshot->'submissionDocumentVersion')='number'
       AND decision.authorization_snapshot->>'submissionDocumentVersion'=submission.result_document_version::text
       AND decision.authorization_snapshot->'submissionSnapshot'=submission.applicant_context_snapshot
  ) OR NOT EXISTS (
    SELECT 1 FROM finance_reimbursement_command_idempotency command
     WHERE command.finance_document_id=NEW.finance_document_id AND command.operation='EXECUTE'
       AND command.result_status='COMPLETED' AND command.result_document_version=NEW.result_document_version
       AND command.actor_person_id=NEW.executed_by_person_id AND command.created_at=NEW.executed_at
  ) OR NOT EXISTS (
    SELECT 1 FROM settlement_account account
     WHERE account.id=NEW.source_account_id AND account.owner_type='COMPANY' AND account.owner_id=NEW.source_fund_id AND account.status='ACTIVE'
  ) OR NOT EXISTS (
    SELECT 1 FROM finance_reimbursement_submission submission
      JOIN finance_document document ON document.id=submission.finance_document_id
      JOIN settlement_account account ON account.id=submission.destination_account_id
     WHERE submission.finance_document_id=NEW.finance_document_id
       AND NEW.destination_account_id=submission.destination_account_id
       AND account.owner_type='PERSON' AND account.owner_id=document.applicant_person_id AND account.status='ACTIVE'
       AND NEW.amount_cents=submission.amount_cents AND NEW.reason=submission.reason
  ) OR NOT EXISTS (
    SELECT 1 FROM role_assignment role
     WHERE role.id=NEW.role_assignment_id AND role.person_id=NEW.executed_by_person_id
       AND role.subject_code='HEADQUARTERS_FINANCE' AND role.scope_type='GLOBAL' AND role.scope_id IS NULL
       AND role.valid_from<=NEW.executed_at AND (role.valid_to IS NULL OR role.valid_to>NEW.executed_at)
  ) OR NOT EXISTS (
    SELECT 1 FROM company_finance_fund_assignment assignment
      JOIN company_finance_fund fund ON fund.id=assignment.fund_id
     WHERE assignment.id=NEW.company_fund_assignment_id AND assignment.fund_id=NEW.source_fund_id AND fund.status='ACTIVE'
       AND assignment.duty_subject='HEADQUARTERS_FINANCE' AND assignment.scope_type='GLOBAL'
       AND assignment.scope_id IS NULL AND assignment.responsibility_code='FINANCE_OPERATING_SOURCE'
       AND assignment.valid_from<=NEW.executed_at AND (assignment.valid_to IS NULL OR assignment.valid_to>NEW.executed_at)
  ) OR NOT EXISTS (
    SELECT 1 FROM ledger_event event
     WHERE event.id=NEW.ledger_event_id AND event.event_type='REIMBURSEMENT_COMPLETED'
       AND event.event_key='reimbursement:' || NEW.finance_document_id::text
  ) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_TRANSFER_INVALID';
  END IF;

  SELECT COUNT(*) INTO ledger_rows
    FROM ledger_entry entry
   WHERE entry.event_id=NEW.ledger_event_id AND (
     (entry.account_id=NEW.source_account_id AND entry.category_key='reimbursementExpense' AND entry.amount_cents=-NEW.amount_cents)
     OR (entry.account_id=NEW.destination_account_id AND entry.category_key='reimbursementIncome' AND entry.amount_cents=NEW.amount_cents)
   );
  IF ledger_rows<>2 OR (SELECT COUNT(*) FROM ledger_entry WHERE event_id=NEW.ledger_event_id)<>2 THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_TRANSFER_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refuse_finance_reimbursement_transfer_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_TRANSFER_IMMUTABLE'; END;
$$;

CREATE TRIGGER finance_reimbursement_transfer_guard BEFORE INSERT ON finance_reimbursement_transfer
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_transfer();
CREATE TRIGGER finance_reimbursement_transfer_immutable BEFORE UPDATE OR DELETE ON finance_reimbursement_transfer
FOR EACH ROW EXECUTE FUNCTION refuse_finance_reimbursement_transfer_mutation();

CREATE INDEX finance_reimbursement_transfer_executor_lookup
  ON finance_reimbursement_transfer(executed_by_person_id,executed_at DESC,finance_document_id);
CREATE INDEX finance_reimbursement_transfer_destination_lookup
  ON finance_reimbursement_transfer(destination_account_id,executed_at DESC,finance_document_id);
