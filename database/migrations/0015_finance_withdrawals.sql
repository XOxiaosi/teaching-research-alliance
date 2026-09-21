ALTER TABLE finance_document
  DROP CONSTRAINT finance_document_status_draft_check,
  ADD CONSTRAINT finance_document_status_check
    CHECK ((kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED'))
      OR (kind <> 'WITHDRAWAL' AND status = 'DRAFT'));

ALTER TABLE finance_document_event
  ADD COLUMN ledger_event_id uuid REFERENCES ledger_event(id),
  ADD COLUMN details_json jsonb,
  DROP CONSTRAINT finance_document_event_event_type_check,
  ADD CONSTRAINT finance_document_event_type_check
    CHECK (event_type IN ('CREATED','SUBMITTED','TRANSFERRED','REVOKED'));

ALTER TABLE finance_attachment
  DROP CONSTRAINT finance_attachment_purpose_check,
  ADD CONSTRAINT finance_attachment_purpose_check
    CHECK (purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT','INVOICE','PAYMENT_RECEIPT'));

CREATE TABLE finance_withdrawal_submission (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  source_owner_type text NOT NULL CHECK (source_owner_type IN ('PERSON','VENUE')),
  source_owner_id uuid NOT NULL,
  authorization_kind text NOT NULL CHECK (authorization_kind IN ('PERSON_OWNER','VENUE_OWNER','VENUE_GRANT')),
  authorization_grant_id uuid REFERENCES venue_permission_grant(id),
  authorization_snapshot jsonb NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  recipient_key_id text NOT NULL,
  recipient_nonce text NOT NULL,
  recipient_ciphertext text NOT NULL,
  recipient_auth_tag text NOT NULL,
  bank_account_last4 text NOT NULL,
  debit_ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  submitted_by_person_id uuid NOT NULL REFERENCES person(id),
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK ((authorization_kind = 'VENUE_GRANT') = (authorization_grant_id IS NOT NULL)),
  CHECK ((source_owner_type = 'PERSON' AND authorization_kind = 'PERSON_OWNER' AND authorization_grant_id IS NULL)
    OR (source_owner_type = 'VENUE' AND authorization_kind = 'VENUE_OWNER' AND authorization_grant_id IS NULL)
    OR (source_owner_type = 'VENUE' AND authorization_kind = 'VENUE_GRANT' AND authorization_grant_id IS NOT NULL))
);

CREATE TABLE finance_withdrawal_transfer (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  transferred_by_person_id uuid NOT NULL REFERENCES person(id),
  transferred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE finance_withdrawal_reversal (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  reversal_ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  reason text NOT NULL,
  revoked_by_person_id uuid NOT NULL REFERENCES person(id),
  revoked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE finance_withdrawal_attachment_binding (
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  stage text NOT NULL CHECK (stage IN ('SUBMISSION','COMPLETION')),
  purpose text NOT NULL CHECK (purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT','INVOICE','PAYMENT_RECEIPT')),
  finance_attachment_version_id uuid NOT NULL REFERENCES finance_attachment_version(id),
  document_version bigint NOT NULL CHECK (document_version > 0),
  bound_by_person_id uuid NOT NULL REFERENCES person(id),
  bound_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (finance_document_id, stage, finance_attachment_version_id),
  UNIQUE (finance_attachment_version_id),
  CHECK ((stage = 'SUBMISSION' AND purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT','INVOICE'))
    OR (stage = 'COMPLETION' AND purpose = 'PAYMENT_RECEIPT'))
);

CREATE TABLE finance_withdrawal_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  operation text NOT NULL CHECK (operation IN ('SUBMIT','REVOKE','MARK_TRANSFERRED')),
  idempotency_key text NOT NULL,
  request_hmac text NOT NULL CHECK (request_hmac ~ '^[0-9a-f]{64}$'),
  hmac_key_id text NOT NULL,
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  result_status text NOT NULL CHECK (result_status IN ('PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED')),
  result_document_version bigint NOT NULL CHECK (result_document_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, operation, idempotency_key)
);

CREATE FUNCTION guard_finance_document_withdrawal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.applicant_person_id IS DISTINCT FROM OLD.applicant_person_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FINANCE_DOCUMENT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'PENDING_TRANSFER' AND (NEW.kind <> 'WITHDRAWAL' OR NEW.version <> OLD.version + 1) THEN
      RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
    END IF;
    IF NEW.status <> 'PENDING_TRANSFER' THEN
      RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.applicant_person_id IS DISTINCT FROM OLD.applicant_person_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'FINANCE_DOCUMENT_SUBMITTED_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status = 'PENDING_TRANSFER' AND NEW.status IN ('TRANSFERRED','FINANCE_REVOKED') AND NEW.version = OLD.version + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
END;
$$;

CREATE FUNCTION guard_finance_withdrawal_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM finance_attachment_version version
      JOIN finance_attachment attachment ON attachment.id = version.finance_attachment_id
     WHERE version.id = NEW.finance_attachment_version_id
       AND attachment.finance_document_id = NEW.finance_document_id
       AND version.status = 'READY'
       AND attachment.purpose = NEW.purpose
  ) THEN
    RAISE EXCEPTION 'FINANCE_WITHDRAWAL_ATTACHMENT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refuse_finance_withdrawal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINANCE_WITHDRAWAL_IMMUTABLE'; END;
$$;

CREATE TRIGGER finance_document_withdrawal_mutation_guard
BEFORE UPDATE ON finance_document
FOR EACH ROW EXECUTE FUNCTION guard_finance_document_withdrawal_mutation();
CREATE TRIGGER finance_withdrawal_attachment_binding_document_guard
BEFORE INSERT ON finance_withdrawal_attachment_binding
FOR EACH ROW EXECUTE FUNCTION guard_finance_withdrawal_attachment_binding();
CREATE TRIGGER finance_withdrawal_submission_immutable
BEFORE UPDATE OR DELETE ON finance_withdrawal_submission
FOR EACH ROW EXECUTE FUNCTION refuse_finance_withdrawal_mutation();
CREATE TRIGGER finance_withdrawal_transfer_immutable
BEFORE UPDATE OR DELETE ON finance_withdrawal_transfer
FOR EACH ROW EXECUTE FUNCTION refuse_finance_withdrawal_mutation();
CREATE TRIGGER finance_withdrawal_reversal_immutable
BEFORE UPDATE OR DELETE ON finance_withdrawal_reversal
FOR EACH ROW EXECUTE FUNCTION refuse_finance_withdrawal_mutation();
CREATE TRIGGER finance_withdrawal_attachment_binding_immutable
BEFORE UPDATE OR DELETE ON finance_withdrawal_attachment_binding
FOR EACH ROW EXECUTE FUNCTION refuse_finance_withdrawal_mutation();
CREATE TRIGGER finance_withdrawal_command_idempotency_immutable
BEFORE UPDATE OR DELETE ON finance_withdrawal_command_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_finance_withdrawal_mutation();

CREATE INDEX finance_withdrawal_submission_source_lookup ON finance_withdrawal_submission (source_account_id, submitted_at DESC, finance_document_id);
CREATE INDEX finance_withdrawal_attachment_binding_document_lookup ON finance_withdrawal_attachment_binding (finance_document_id, stage, purpose);
CREATE INDEX finance_withdrawal_command_document_lookup ON finance_withdrawal_command_idempotency (finance_document_id, created_at DESC);
