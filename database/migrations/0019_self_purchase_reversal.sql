ALTER TABLE finance_document
  DROP CONSTRAINT finance_document_status_check,
  ADD CONSTRAINT finance_document_status_check
    CHECK (
      (kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED'))
      OR (kind = 'SELF_PURCHASE' AND status IN ('DRAFT','COMPLETED','REVERSED'))
      OR (kind NOT IN ('WITHDRAWAL','SELF_PURCHASE') AND status = 'DRAFT')
    );

ALTER TABLE finance_document_event
  DROP CONSTRAINT finance_document_event_event_type_check,
  ADD CONSTRAINT finance_document_event_event_type_check
    CHECK (event_type IN ('CREATED','SUBMITTED','TRANSFERRED','REVOKED','AUTO_COMPLETED','TRANSFER_REVERSED'));

CREATE OR REPLACE FUNCTION guard_finance_document_withdrawal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.applicant_person_id IS DISTINCT FROM OLD.applicant_person_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FINANCE_DOCUMENT_IDENTITY_IMMUTABLE';
  END IF;

  IF OLD.kind = 'WITHDRAWAL' THEN
    IF OLD.status = 'DRAFT' THEN
      IF NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
      IF NEW.status = 'PENDING_TRANSFER' AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
    END IF;
    IF OLD.status = 'PENDING_TRANSFER' AND NEW.status IN ('TRANSFERRED','FINANCE_REVOKED') AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
  END IF;

  IF OLD.kind = 'SELF_PURCHASE' THEN
    IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'COMPLETED' AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
    IF OLD.status = 'COMPLETED' AND NEW.status = 'REVERSED' AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_SELF_PURCHASE_TRANSITION_INVALID';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
END;
$$;

ALTER TABLE finance_self_purchase_command_idempotency
  DROP CONSTRAINT finance_self_purchase_command_idempotency_operation_check,
  DROP CONSTRAINT finance_self_purchase_command_idempotency_result_status_check,
  ADD CONSTRAINT finance_self_purchase_command_idempotency_operation_check CHECK (operation IN ('SUBMIT','REVERSE')),
  ADD CONSTRAINT finance_self_purchase_command_idempotency_result_status_check CHECK (result_status IN ('COMPLETED','REVERSED')),
  ADD CONSTRAINT finance_self_purchase_command_idempotency_operation_result_check
    CHECK ((operation = 'SUBMIT' AND result_status = 'COMPLETED') OR (operation = 'REVERSE' AND result_status = 'REVERSED'));

CREATE TABLE finance_self_purchase_reversal (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  source_document_version bigint NOT NULL CHECK (source_document_version > 0),
  result_document_version bigint NOT NULL CHECK (result_document_version = source_document_version + 1),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  reversal_ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
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
  FOREIGN KEY (finance_document_id) REFERENCES finance_self_purchase_transfer(finance_document_id),
  CHECK (source_after_cents = source_before_cents + amount_cents),
  CHECK (destination_after_cents = destination_before_cents - amount_cents),
  CHECK (reversed_at = created_at)
);

CREATE TRIGGER finance_self_purchase_reversal_immutable
BEFORE UPDATE OR DELETE ON finance_self_purchase_reversal
FOR EACH ROW EXECUTE FUNCTION refuse_finance_self_purchase_mutation();

CREATE INDEX finance_self_purchase_reversal_source_lookup
  ON finance_self_purchase_reversal (source_account_id, reversed_at DESC, finance_document_id);
CREATE INDEX finance_self_purchase_reversal_destination_lookup
  ON finance_self_purchase_reversal (destination_account_id, reversed_at DESC, finance_document_id);
