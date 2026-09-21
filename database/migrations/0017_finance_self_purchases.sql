ALTER TABLE finance_document
  DROP CONSTRAINT finance_document_status_check,
  ADD CONSTRAINT finance_document_status_check
    CHECK (
      (kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED'))
      OR (kind = 'SELF_PURCHASE' AND status IN ('DRAFT','COMPLETED'))
      OR (kind NOT IN ('WITHDRAWAL','SELF_PURCHASE') AND status = 'DRAFT')
    );

ALTER TABLE finance_document_event
  DROP CONSTRAINT finance_document_event_type_check,
  ADD CONSTRAINT finance_document_event_event_type_check
    CHECK (event_type IN ('CREATED','SUBMITTED','TRANSFERRED','REVOKED','AUTO_COMPLETED'));

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
      IF NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN
        RETURN NEW;
      END IF;
      IF NEW.status = 'PENDING_TRANSFER' AND NEW.version = OLD.version + 1 THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
    END IF;
    IF OLD.status = 'PENDING_TRANSFER' AND NEW.status IN ('TRANSFERRED','FINANCE_REVOKED')
      AND NEW.version = OLD.version + 1 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
  END IF;

  IF OLD.kind = 'SELF_PURCHASE' THEN
    IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'COMPLETED' AND NEW.version = OLD.version + 1 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_SELF_PURCHASE_TRANSITION_INVALID';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
END;
$$;

CREATE TABLE finance_self_purchase_transfer (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  role_assignment_id uuid NOT NULL REFERENCES role_assignment(id),
  company_fund_assignment_id uuid NOT NULL REFERENCES company_finance_fund_assignment(id),
  source_fund_id uuid NOT NULL REFERENCES company_finance_fund(id),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  destination_person_id uuid NOT NULL REFERENCES person(id),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  authorization_snapshot jsonb NOT NULL,
  ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  processing_mode text NOT NULL CHECK (processing_mode = 'SYSTEM_RULE'),
  submitted_by_person_id uuid NOT NULL REFERENCES person(id),
  submitted_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  source_before_cents bigint NOT NULL,
  source_after_cents bigint NOT NULL,
  destination_before_cents bigint NOT NULL,
  destination_after_cents bigint NOT NULL,
  CHECK (destination_person_id = submitted_by_person_id),
  CHECK (completed_at >= submitted_at),
  CHECK (source_after_cents = source_before_cents - amount_cents),
  CHECK (destination_after_cents = destination_before_cents + amount_cents)
);

CREATE TABLE finance_self_purchase_attachment_binding (
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  finance_attachment_version_id uuid NOT NULL UNIQUE REFERENCES finance_attachment_version(id),
  purpose text NOT NULL CHECK (purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT','INVOICE')),
  document_version bigint NOT NULL CHECK (document_version > 0),
  bound_by_person_id uuid NOT NULL REFERENCES person(id),
  bound_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (finance_document_id, finance_attachment_version_id)
);

CREATE TABLE finance_self_purchase_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  operation text NOT NULL CHECK (operation = 'SUBMIT'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  result_status text NOT NULL CHECK (result_status = 'COMPLETED'),
  result_document_version bigint NOT NULL CHECK (result_document_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, operation, idempotency_key)
);

CREATE FUNCTION guard_finance_self_purchase_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_applicant uuid;
  document_version bigint;
  attachment_slot uuid;
BEGIN
  SELECT applicant_person_id, version
    INTO document_applicant, document_version
    FROM finance_document
   WHERE id = NEW.finance_document_id
     AND kind = 'SELF_PURCHASE'
     AND status = 'COMPLETED';
  IF document_applicant IS NULL
    OR NEW.document_version <> document_version
    OR NEW.bound_by_person_id <> document_applicant
    OR EXISTS (
      SELECT 1 FROM finance_self_purchase_command_idempotency command
       WHERE command.finance_document_id = NEW.finance_document_id
         AND command.result_status = 'COMPLETED'
    ) THEN
    RAISE EXCEPTION 'FINANCE_SELF_PURCHASE_ATTACHMENT_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM finance_document document
      JOIN finance_attachment attachment ON attachment.finance_document_id = document.id
      JOIN finance_attachment_version version ON version.finance_attachment_id = attachment.id
     WHERE document.id = NEW.finance_document_id
       AND document.kind = 'SELF_PURCHASE'
       AND version.id = NEW.finance_attachment_version_id
       AND version.status = 'READY'
       AND attachment.purpose = NEW.purpose
  ) THEN
    RAISE EXCEPTION 'FINANCE_SELF_PURCHASE_ATTACHMENT_INVALID';
  END IF;

  SELECT finance_attachment_id INTO attachment_slot
    FROM finance_attachment_version
   WHERE id = NEW.finance_attachment_version_id;
  IF attachment_slot IS NULL OR EXISTS (
    SELECT 1
      FROM finance_self_purchase_attachment_binding existing
      JOIN finance_attachment_version existing_version ON existing_version.id = existing.finance_attachment_version_id
     WHERE existing.finance_document_id = NEW.finance_document_id
       AND existing_version.finance_attachment_id = attachment_slot
  ) THEN
    RAISE EXCEPTION 'FINANCE_SELF_PURCHASE_ATTACHMENT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refuse_finance_self_purchase_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_SELF_PURCHASE_IMMUTABLE';
END;
$$;

CREATE TRIGGER finance_self_purchase_attachment_binding_document_guard
BEFORE INSERT ON finance_self_purchase_attachment_binding
FOR EACH ROW EXECUTE FUNCTION guard_finance_self_purchase_attachment_binding();
CREATE TRIGGER finance_self_purchase_transfer_immutable
BEFORE UPDATE OR DELETE ON finance_self_purchase_transfer
FOR EACH ROW EXECUTE FUNCTION refuse_finance_self_purchase_mutation();
CREATE TRIGGER finance_self_purchase_attachment_binding_immutable
BEFORE UPDATE OR DELETE ON finance_self_purchase_attachment_binding
FOR EACH ROW EXECUTE FUNCTION refuse_finance_self_purchase_mutation();
CREATE TRIGGER finance_self_purchase_command_idempotency_immutable
BEFORE UPDATE OR DELETE ON finance_self_purchase_command_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_finance_self_purchase_mutation();

CREATE INDEX finance_self_purchase_transfer_source_lookup
  ON finance_self_purchase_transfer (source_account_id, completed_at DESC, finance_document_id);
CREATE INDEX finance_self_purchase_transfer_destination_lookup
  ON finance_self_purchase_transfer (destination_person_id, completed_at DESC, finance_document_id);
CREATE INDEX finance_self_purchase_attachment_binding_document_lookup
  ON finance_self_purchase_attachment_binding (finance_document_id, purpose);
CREATE INDEX finance_self_purchase_command_document_lookup
  ON finance_self_purchase_command_idempotency (finance_document_id, created_at DESC);
