ALTER TABLE finance_document
  DROP CONSTRAINT finance_document_status_check,
  ADD CONSTRAINT finance_document_status_check
    CHECK (
      (kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED'))
      OR (kind = 'SELF_PURCHASE' AND status IN ('DRAFT','COMPLETED','REVERSED'))
      OR (kind = 'REIMBURSEMENT' AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED'))
      OR (kind NOT IN ('WITHDRAWAL','SELF_PURCHASE','REIMBURSEMENT') AND status = 'DRAFT')
    );

ALTER TABLE finance_document_event
  DROP CONSTRAINT finance_document_event_event_type_check,
  ADD CONSTRAINT finance_document_event_event_type_check
    CHECK (event_type IN (
      'CREATED','SUBMITTED','TRANSFERRED','REVOKED','AUTO_COMPLETED','TRANSFER_REVERSED',
      'REIMBURSEMENT_SUBMITTED','REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED'
    ));

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

  IF OLD.kind = 'REIMBURSEMENT' THEN
    IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'PENDING_APPROVAL' AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
    IF OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED') AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_REIMBURSEMENT_TRANSITION_INVALID';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
END;
$$;

CREATE TABLE finance_reimbursement_submission (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  source_document_version bigint NOT NULL CHECK (source_document_version > 0),
  result_document_version bigint NOT NULL CHECK (result_document_version = source_document_version + 1),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  applicant_context_snapshot jsonb NOT NULL,
  submitted_by_person_id uuid NOT NULL REFERENCES person(id),
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (submitted_at = created_at)
);

CREATE TABLE finance_reimbursement_attachment_binding (
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  stage text NOT NULL CHECK (stage = 'SUBMISSION'),
  purpose text NOT NULL CHECK (purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT','INVOICE')),
  finance_attachment_version_id uuid NOT NULL UNIQUE REFERENCES finance_attachment_version(id),
  document_version bigint NOT NULL CHECK (document_version > 0),
  bound_by_person_id uuid NOT NULL REFERENCES person(id),
  bound_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (finance_document_id, stage, finance_attachment_version_id),
  CHECK (bound_at = created_at)
);

CREATE TABLE finance_reimbursement_decision (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  source_document_version bigint NOT NULL CHECK (source_document_version > 0),
  result_document_version bigint NOT NULL CHECK (result_document_version = source_document_version + 1),
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  decided_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code = 'HEADQUARTERS_FINANCE'),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'GLOBAL'),
  authorization_snapshot jsonb NOT NULL,
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (decided_at = created_at)
);

CREATE TABLE finance_reimbursement_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  operation text NOT NULL CHECK (operation IN ('SUBMIT','APPROVE','REJECT')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  result_status text NOT NULL CHECK (result_status IN ('PENDING_APPROVAL','APPROVED','REJECTED')),
  result_document_version bigint NOT NULL CHECK (result_document_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, operation, idempotency_key),
  CHECK ((operation = 'SUBMIT' AND result_status = 'PENDING_APPROVAL')
    OR (operation = 'APPROVE' AND result_status = 'APPROVED')
    OR (operation = 'REJECT' AND result_status = 'REJECTED'))
);

CREATE FUNCTION guard_finance_reimbursement_submission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  applicant uuid;
  document_version bigint;
BEGIN
  SELECT applicant_person_id, version INTO applicant, document_version
    FROM finance_document
   WHERE id = NEW.finance_document_id AND kind = 'REIMBURSEMENT' AND status = 'PENDING_APPROVAL';
  IF applicant IS NULL OR NEW.submitted_by_person_id <> applicant
    OR NEW.result_document_version <> document_version
    OR NEW.source_document_version + 1 <> document_version
    OR EXISTS (SELECT 1 FROM finance_reimbursement_command_idempotency command WHERE command.finance_document_id = NEW.finance_document_id AND command.operation = 'SUBMIT')
    OR NOT EXISTS (
      SELECT 1 FROM settlement_account account
       WHERE account.id = NEW.destination_account_id AND account.owner_type = 'PERSON'
         AND account.owner_id = applicant AND account.status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_SUBMISSION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_finance_reimbursement_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  applicant uuid;
  document_version bigint;
  attachment_slot uuid;
BEGIN
  SELECT document.applicant_person_id, document.version INTO applicant, document_version
    FROM finance_document document
   WHERE document.id = NEW.finance_document_id AND document.kind = 'REIMBURSEMENT' AND document.status = 'PENDING_APPROVAL';
  IF applicant IS NULL OR NEW.bound_by_person_id <> applicant OR NEW.document_version <> document_version
    OR EXISTS (SELECT 1 FROM finance_reimbursement_command_idempotency command WHERE command.finance_document_id = NEW.finance_document_id AND command.operation = 'SUBMIT')
    OR NOT EXISTS (
      SELECT 1 FROM finance_attachment attachment JOIN finance_attachment_version version ON version.finance_attachment_id = attachment.id
       WHERE attachment.finance_document_id = NEW.finance_document_id AND version.id = NEW.finance_attachment_version_id
         AND version.status = 'READY' AND attachment.purpose = NEW.purpose
    ) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_ATTACHMENT_INVALID';
  END IF;
  SELECT finance_attachment_id INTO attachment_slot FROM finance_attachment_version WHERE id = NEW.finance_attachment_version_id;
  IF attachment_slot IS NULL OR EXISTS (
    SELECT 1 FROM finance_reimbursement_attachment_binding existing
      JOIN finance_attachment_version existing_version ON existing_version.id = existing.finance_attachment_version_id
     WHERE existing.finance_document_id = NEW.finance_document_id AND existing.stage = NEW.stage
       AND existing_version.finance_attachment_id = attachment_slot
  ) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_ATTACHMENT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_finance_reimbursement_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  applicant uuid;
  document_version bigint;
BEGIN
  SELECT document.applicant_person_id, document.version INTO applicant, document_version
    FROM finance_document document
   WHERE document.id = NEW.finance_document_id AND document.kind = 'REIMBURSEMENT' AND document.status = NEW.decision;
  IF applicant IS NULL OR NEW.result_document_version <> document_version
    OR NEW.source_document_version + 1 <> document_version
    OR NOT EXISTS (
      SELECT 1 FROM finance_reimbursement_submission submission
       WHERE submission.finance_document_id = NEW.finance_document_id
         AND submission.result_document_version = NEW.source_document_version
    )
    OR NOT EXISTS (
      SELECT 1 FROM finance_reimbursement_command_idempotency command
       WHERE command.finance_document_id = NEW.finance_document_id
         AND command.operation = CASE NEW.decision WHEN 'APPROVED' THEN 'APPROVE' ELSE 'REJECT' END
         AND command.result_status = NEW.decision AND command.result_document_version = NEW.result_document_version
         AND command.actor_person_id = NEW.decided_by_person_id AND command.created_at = NEW.decided_at
    ) THEN
    RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_DECISION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refuse_finance_reimbursement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINANCE_REIMBURSEMENT_IMMUTABLE'; END;
$$;

CREATE TRIGGER finance_reimbursement_submission_guard BEFORE INSERT ON finance_reimbursement_submission
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_submission();
CREATE TRIGGER finance_reimbursement_attachment_binding_guard BEFORE INSERT ON finance_reimbursement_attachment_binding
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_attachment_binding();
CREATE TRIGGER finance_reimbursement_decision_guard BEFORE INSERT ON finance_reimbursement_decision
FOR EACH ROW EXECUTE FUNCTION guard_finance_reimbursement_decision();
CREATE TRIGGER finance_reimbursement_submission_immutable BEFORE UPDATE OR DELETE ON finance_reimbursement_submission
FOR EACH ROW EXECUTE FUNCTION refuse_finance_reimbursement_mutation();
CREATE TRIGGER finance_reimbursement_attachment_binding_immutable BEFORE UPDATE OR DELETE ON finance_reimbursement_attachment_binding
FOR EACH ROW EXECUTE FUNCTION refuse_finance_reimbursement_mutation();
CREATE TRIGGER finance_reimbursement_decision_immutable BEFORE UPDATE OR DELETE ON finance_reimbursement_decision
FOR EACH ROW EXECUTE FUNCTION refuse_finance_reimbursement_mutation();
CREATE TRIGGER finance_reimbursement_command_idempotency_immutable BEFORE UPDATE OR DELETE ON finance_reimbursement_command_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_finance_reimbursement_mutation();

CREATE INDEX finance_reimbursement_submission_destination_lookup ON finance_reimbursement_submission(destination_account_id, submitted_at DESC, finance_document_id);
CREATE INDEX finance_reimbursement_attachment_binding_document_lookup ON finance_reimbursement_attachment_binding(finance_document_id, stage, purpose);
CREATE INDEX finance_reimbursement_decision_actor_lookup ON finance_reimbursement_decision(decided_by_person_id, decided_at DESC, finance_document_id);
CREATE INDEX finance_reimbursement_command_document_lookup ON finance_reimbursement_command_idempotency(finance_document_id, created_at DESC);
