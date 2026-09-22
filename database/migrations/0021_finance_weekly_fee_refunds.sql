ALTER TABLE finance_document
  DROP CONSTRAINT finance_document_status_check,
  ADD CONSTRAINT finance_document_status_check
    CHECK (
      (kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED'))
      OR (kind = 'SELF_PURCHASE' AND status IN ('DRAFT','COMPLETED','REVERSED'))
      OR (kind = 'REIMBURSEMENT' AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED'))
      OR (kind = 'REFUND' AND status IN ('DRAFT','PENDING_APPROVAL','REFUNDED','REJECTED'))
      OR (kind NOT IN ('WITHDRAWAL','SELF_PURCHASE','REIMBURSEMENT','REFUND') AND status = 'DRAFT')
    );

ALTER TABLE finance_document_event
  DROP CONSTRAINT finance_document_event_event_type_check,
  ADD CONSTRAINT finance_document_event_event_type_check
    CHECK (event_type IN (
      'CREATED','SUBMITTED','TRANSFERRED','REVOKED','AUTO_COMPLETED','TRANSFER_REVERSED',
      'REIMBURSEMENT_SUBMITTED','REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED',
      'REFUND_SUBMITTED','REFUND_APPROVED','REFUND_REJECTED'
    ));

CREATE OR REPLACE FUNCTION guard_finance_document_withdrawal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.applicant_person_id IS DISTINCT FROM OLD.applicant_person_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FINANCE_DOCUMENT_IDENTITY_IMMUTABLE';
  END IF;

  IF OLD.kind = 'WITHDRAWAL' THEN
    IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'PENDING_TRANSFER' AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
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

  IF OLD.kind = 'REFUND' THEN
    IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'PENDING_APPROVAL' AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
    IF OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('REFUNDED','REJECTED') AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_REFUND_TRANSITION_INVALID';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.version IN (OLD.version, OLD.version + 1) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'FINANCE_DOCUMENT_WITHDRAWAL_TRANSITION_INVALID';
END;
$$;

CREATE TABLE finance_refund_submission (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  student_record_id uuid NOT NULL REFERENCES teacher_student_record(id),
  source_document_version bigint NOT NULL CHECK (source_document_version > 0),
  result_document_version bigint NOT NULL CHECK (result_document_version = source_document_version + 1),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  applicant_context_snapshot jsonb NOT NULL CHECK (jsonb_typeof(applicant_context_snapshot) = 'object'),
  submitted_by_person_id uuid NOT NULL REFERENCES person(id),
  submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL CHECK (submitted_at = created_at)
);

CREATE TABLE finance_refund_submission_item (
  finance_document_id uuid NOT NULL REFERENCES finance_refund_submission(finance_document_id),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  submitted_fee_version bigint NOT NULL CHECK (submitted_fee_version > 0),
  submitted_gross_amount_cents bigint NOT NULL CHECK (submitted_gross_amount_cents >= 0),
  teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  settlement_month date NOT NULL,
  PRIMARY KEY (finance_document_id, weekly_fee_entry_id)
);

CREATE TABLE finance_refund_attachment_binding (
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  stage text NOT NULL CHECK (stage = 'SUBMISSION'),
  purpose text NOT NULL CHECK (purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT','INVOICE')),
  finance_attachment_version_id uuid NOT NULL UNIQUE REFERENCES finance_attachment_version(id),
  document_version bigint NOT NULL CHECK (document_version > 0),
  bound_by_person_id uuid NOT NULL REFERENCES person(id),
  bound_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL CHECK (bound_at = created_at),
  PRIMARY KEY (finance_document_id, finance_attachment_version_id)
);

CREATE TABLE finance_refund_decision (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  source_document_version bigint NOT NULL CHECK (source_document_version > 0),
  result_document_version bigint NOT NULL CHECK (result_document_version = source_document_version + 1),
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  decided_by_person_id uuid NOT NULL REFERENCES person(id),
  actor_subject_code text NOT NULL CHECK (actor_subject_code = 'HEADQUARTERS_FINANCE'),
  actor_scope_type text NOT NULL CHECK (actor_scope_type = 'GLOBAL'),
  authorization_snapshot jsonb NOT NULL CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL CHECK (decided_at = created_at),
  posting_status text NOT NULL CHECK (posting_status IN ('POSTED','NO_BALANCE_CHANGE','REJECTED')),
  ledger_event_id uuid UNIQUE REFERENCES ledger_event(id),
  approved_gross_amount_cents bigint NOT NULL CHECK (approved_gross_amount_cents >= 0),
  CHECK (
    (decision = 'APPROVED' AND posting_status = 'POSTED' AND ledger_event_id IS NOT NULL)
    OR (decision = 'APPROVED' AND posting_status = 'NO_BALANCE_CHANGE' AND ledger_event_id IS NULL)
    OR (decision = 'REJECTED' AND posting_status = 'REJECTED' AND ledger_event_id IS NULL AND approved_gross_amount_cents = 0)
  )
);

CREATE TABLE weekly_fee_refund_effect (
  weekly_fee_entry_id uuid PRIMARY KEY REFERENCES weekly_fee_entry(id),
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  allocation_snapshot_id uuid NOT NULL REFERENCES weekly_fee_allocation_snapshot(id),
  source_weekly_fee_version bigint NOT NULL CHECK (source_weekly_fee_version > 0),
  gross_amount_cents bigint NOT NULL CHECK (gross_amount_cents >= 0),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at timestamptz NOT NULL
);

CREATE TABLE finance_refund_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  operation text NOT NULL CHECK (operation IN ('SUBMIT','APPROVE','REJECT')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  result_status text NOT NULL CHECK (result_status IN ('PENDING_APPROVAL','REFUNDED','REJECTED')),
  result_document_version bigint NOT NULL CHECK (result_document_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, operation, idempotency_key),
  CHECK ((operation = 'SUBMIT' AND result_status = 'PENDING_APPROVAL')
    OR (operation = 'APPROVE' AND result_status = 'REFUNDED')
    OR (operation = 'REJECT' AND result_status = 'REJECTED'))
);

CREATE FUNCTION guard_finance_refund_submission()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  applicant uuid;
  document_version bigint;
BEGIN
  SELECT applicant_person_id, version INTO applicant, document_version
    FROM finance_document
   WHERE id = NEW.finance_document_id AND kind = 'REFUND' AND status = 'PENDING_APPROVAL';
  IF applicant IS NULL OR NEW.submitted_by_person_id <> applicant
    OR NEW.result_document_version <> document_version
    OR NEW.source_document_version + 1 <> document_version
    OR EXISTS (SELECT 1 FROM finance_refund_command_idempotency command
                WHERE command.finance_document_id = NEW.finance_document_id AND command.operation = 'SUBMIT')
    OR NOT EXISTS (
      SELECT 1 FROM referral_case referral
       WHERE referral.id = NEW.referral_case_id
         AND referral.receiver_person_id = applicant
         AND referral.teacher_student_record_id = NEW.student_record_id
    ) THEN
    RAISE EXCEPTION 'FINANCE_REFUND_SUBMISSION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_finance_refund_submission_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  submission_referral uuid;
  fee_referral uuid;
  item_month date;
  item_week uuid;
  item_version bigint;
  item_gross bigint;
BEGIN
  SELECT submission.referral_case_id INTO submission_referral
    FROM finance_refund_submission submission
   WHERE submission.finance_document_id = NEW.finance_document_id;
  SELECT referral_case_id, settlement_month, teaching_week_id, version, gross_amount_cents
    INTO fee_referral, item_month, item_week, item_version, item_gross
    FROM weekly_fee_entry WHERE id = NEW.weekly_fee_entry_id;
  IF submission_referral IS NULL OR fee_referral IS NULL OR fee_referral <> submission_referral
    OR NEW.teaching_week_id <> item_week OR NEW.settlement_month <> item_month
    OR NEW.submitted_fee_version <> item_version OR NEW.submitted_gross_amount_cents <> item_gross
    OR EXISTS (SELECT 1 FROM weekly_fee_refund_effect effect WHERE effect.weekly_fee_entry_id = NEW.weekly_fee_entry_id)
    OR EXISTS (SELECT 1 FROM finance_refund_command_idempotency command
                WHERE command.finance_document_id = NEW.finance_document_id AND command.operation = 'SUBMIT') THEN
    RAISE EXCEPTION 'FINANCE_REFUND_SUBMISSION_ITEM_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_finance_refund_attachment_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  applicant uuid;
  document_version bigint;
  attachment_slot uuid;
BEGIN
  SELECT applicant_person_id, version INTO applicant, document_version
    FROM finance_document
   WHERE id = NEW.finance_document_id AND kind = 'REFUND' AND status = 'PENDING_APPROVAL';
  IF applicant IS NULL OR NEW.bound_by_person_id <> applicant OR NEW.document_version <> document_version
    OR EXISTS (SELECT 1 FROM finance_refund_command_idempotency command
                WHERE command.finance_document_id = NEW.finance_document_id AND command.operation = 'SUBMIT')
    OR NOT EXISTS (
      SELECT 1 FROM finance_attachment attachment
       JOIN finance_attachment_version version ON version.finance_attachment_id = attachment.id
       WHERE attachment.finance_document_id = NEW.finance_document_id
         AND version.id = NEW.finance_attachment_version_id
         AND version.status = 'READY' AND attachment.purpose = NEW.purpose
    ) THEN
    RAISE EXCEPTION 'FINANCE_REFUND_ATTACHMENT_INVALID';
  END IF;
  SELECT finance_attachment_id INTO attachment_slot
    FROM finance_attachment_version WHERE id = NEW.finance_attachment_version_id;
  IF attachment_slot IS NULL OR EXISTS (
    SELECT 1 FROM finance_refund_attachment_binding existing
    JOIN finance_attachment_version existing_version ON existing_version.id = existing.finance_attachment_version_id
    WHERE existing.finance_document_id = NEW.finance_document_id
      AND existing.stage = NEW.stage
      AND existing_version.finance_attachment_id = attachment_slot
  ) THEN
    RAISE EXCEPTION 'FINANCE_REFUND_ATTACHMENT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_finance_refund_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_version bigint;
BEGIN
  SELECT version INTO document_version
    FROM finance_document
   WHERE id = NEW.finance_document_id AND kind = 'REFUND'
     AND status = CASE NEW.decision WHEN 'APPROVED' THEN 'REFUNDED' ELSE 'REJECTED' END;
  IF document_version IS NULL OR NEW.result_document_version <> document_version
    OR NEW.source_document_version + 1 <> document_version
    OR NOT EXISTS (
      SELECT 1 FROM finance_refund_submission submission
       WHERE submission.finance_document_id = NEW.finance_document_id
         AND submission.result_document_version = NEW.source_document_version
    )
    OR NOT EXISTS (
      SELECT 1 FROM finance_refund_command_idempotency command
       WHERE command.finance_document_id = NEW.finance_document_id
         AND command.operation = CASE NEW.decision WHEN 'APPROVED' THEN 'APPROVE' ELSE 'REJECT' END
         AND command.result_status = CASE NEW.decision WHEN 'APPROVED' THEN 'REFUNDED' ELSE 'REJECTED' END
         AND command.result_document_version = NEW.result_document_version
         AND command.actor_person_id = NEW.decided_by_person_id
         AND command.created_at = NEW.decided_at
    ) THEN
    RAISE EXCEPTION 'FINANCE_REFUND_DECISION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_weekly_fee_refund_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_snapshot uuid;
  current_version bigint;
  current_gross bigint;
BEGIN
  SELECT snapshot.id, snapshot.source_weekly_fee_version, fee.gross_amount_cents
    INTO current_snapshot, current_version, current_gross
    FROM weekly_fee_allocation_snapshot snapshot
    JOIN weekly_fee_entry fee ON fee.id = snapshot.weekly_fee_entry_id
   WHERE snapshot.weekly_fee_entry_id = NEW.weekly_fee_entry_id
     AND snapshot.source_weekly_fee_version = fee.version
   ORDER BY snapshot.sequence_no DESC
   LIMIT 1;
  IF current_snapshot IS NULL OR NEW.allocation_snapshot_id <> current_snapshot
    OR NEW.source_weekly_fee_version <> current_version
    OR NEW.gross_amount_cents <> current_gross
    OR NOT EXISTS (
      SELECT 1 FROM weekly_fee_allocation_snapshot snapshot
       WHERE snapshot.id = NEW.allocation_snapshot_id
         AND snapshot.snapshot_json = NEW.snapshot_json
    )
    OR NOT EXISTS (
      SELECT 1 FROM finance_refund_decision decision
       WHERE decision.finance_document_id = NEW.finance_document_id
         AND decision.decision = 'APPROVED'
         AND decision.posting_status IN ('POSTED','NO_BALANCE_CHANGE')
    )
    OR NOT EXISTS (
      SELECT 1 FROM finance_refund_submission_item item
       WHERE item.finance_document_id = NEW.finance_document_id
         AND item.weekly_fee_entry_id = NEW.weekly_fee_entry_id
    )
    OR COALESCE((
      SELECT decision.decided_at FROM finance_refund_decision decision
       WHERE decision.finance_document_id = NEW.finance_document_id
    ), '-infinity'::timestamptz) <> NEW.created_at
    OR EXISTS (
      SELECT 1 FROM finance_document_event event
       WHERE event.finance_document_id = NEW.finance_document_id
         AND event.event_type = 'REFUND_APPROVED'
    ) THEN
    RAISE EXCEPTION 'WEEKLY_FEE_REFUND_EFFECT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;


CREATE FUNCTION guard_finance_refund_approved_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_count bigint;
  effect_count bigint;
  total_gross bigint;
  decision_record finance_refund_decision%ROWTYPE;
  expected_decision text;
BEGIN
  IF NEW.event_type NOT IN ('REFUND_APPROVED','REFUND_REJECTED') THEN RETURN NEW; END IF;
  expected_decision := CASE NEW.event_type WHEN 'REFUND_APPROVED' THEN 'APPROVED' ELSE 'REJECTED' END;
  SELECT * INTO decision_record FROM finance_refund_decision
   WHERE finance_document_id = NEW.finance_document_id AND decision = expected_decision;
  IF decision_record.finance_document_id IS NULL
    OR NEW.actor_person_id <> decision_record.decided_by_person_id
    OR NEW.created_at <> decision_record.decided_at
    OR NEW.result_document_version <> decision_record.result_document_version
    OR NEW.ledger_event_id IS DISTINCT FROM decision_record.ledger_event_id
    OR EXISTS (
      SELECT 1 FROM finance_document_event prior
       WHERE prior.finance_document_id = NEW.finance_document_id
         AND prior.event_type = NEW.event_type
    ) THEN
    RAISE EXCEPTION 'FINANCE_REFUND_APPROVAL_EVENT_INVALID';
  END IF;
  IF expected_decision = 'REJECTED' THEN
    IF EXISTS (SELECT 1 FROM weekly_fee_refund_effect WHERE finance_document_id = NEW.finance_document_id) THEN
      RAISE EXCEPTION 'FINANCE_REFUND_APPROVAL_EVENT_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  SELECT count(*) INTO selected_count FROM finance_refund_submission_item
   WHERE finance_document_id = NEW.finance_document_id;
  SELECT count(*), COALESCE(sum(gross_amount_cents), 0) INTO effect_count, total_gross
    FROM weekly_fee_refund_effect WHERE finance_document_id = NEW.finance_document_id;
  IF selected_count = 0 OR effect_count <> selected_count
    OR total_gross <> decision_record.approved_gross_amount_cents
    OR EXISTS (
      SELECT 1 FROM finance_refund_submission_item item
      LEFT JOIN weekly_fee_refund_effect effect ON effect.weekly_fee_entry_id = item.weekly_fee_entry_id
      WHERE item.finance_document_id = NEW.finance_document_id AND effect.weekly_fee_entry_id IS NULL
    ) THEN
    RAISE EXCEPTION 'FINANCE_REFUND_APPROVAL_EVENT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refuse_finance_refund_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_REFUND_IMMUTABLE';
END;
$$;

CREATE TRIGGER finance_refund_approved_event_guard BEFORE INSERT ON finance_document_event
FOR EACH ROW EXECUTE FUNCTION guard_finance_refund_approved_event();
CREATE TRIGGER finance_refund_submission_guard BEFORE INSERT ON finance_refund_submission
FOR EACH ROW EXECUTE FUNCTION guard_finance_refund_submission();
CREATE TRIGGER finance_refund_submission_item_guard BEFORE INSERT ON finance_refund_submission_item
FOR EACH ROW EXECUTE FUNCTION guard_finance_refund_submission_item();
CREATE TRIGGER finance_refund_attachment_binding_guard BEFORE INSERT ON finance_refund_attachment_binding
FOR EACH ROW EXECUTE FUNCTION guard_finance_refund_attachment_binding();
CREATE TRIGGER finance_refund_decision_guard BEFORE INSERT ON finance_refund_decision
FOR EACH ROW EXECUTE FUNCTION guard_finance_refund_decision();
CREATE TRIGGER weekly_fee_refund_effect_guard BEFORE INSERT ON weekly_fee_refund_effect
FOR EACH ROW EXECUTE FUNCTION guard_weekly_fee_refund_effect();
CREATE TRIGGER finance_refund_submission_immutable BEFORE UPDATE OR DELETE ON finance_refund_submission
FOR EACH ROW EXECUTE FUNCTION refuse_finance_refund_mutation();
CREATE TRIGGER finance_refund_submission_item_immutable BEFORE UPDATE OR DELETE ON finance_refund_submission_item
FOR EACH ROW EXECUTE FUNCTION refuse_finance_refund_mutation();
CREATE TRIGGER finance_refund_attachment_binding_immutable BEFORE UPDATE OR DELETE ON finance_refund_attachment_binding
FOR EACH ROW EXECUTE FUNCTION refuse_finance_refund_mutation();
CREATE TRIGGER finance_refund_decision_immutable BEFORE UPDATE OR DELETE ON finance_refund_decision
FOR EACH ROW EXECUTE FUNCTION refuse_finance_refund_mutation();
CREATE TRIGGER weekly_fee_refund_effect_immutable BEFORE UPDATE OR DELETE ON weekly_fee_refund_effect
FOR EACH ROW EXECUTE FUNCTION refuse_finance_refund_mutation();
CREATE TRIGGER finance_refund_command_idempotency_immutable BEFORE UPDATE OR DELETE ON finance_refund_command_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_finance_refund_mutation();

CREATE INDEX finance_refund_submission_item_month_lookup
  ON finance_refund_submission_item(settlement_month, weekly_fee_entry_id);
CREATE INDEX finance_refund_attachment_binding_document_lookup
  ON finance_refund_attachment_binding(finance_document_id, stage, purpose);
CREATE INDEX finance_refund_decision_actor_lookup
  ON finance_refund_decision(decided_by_person_id, decided_at DESC, finance_document_id);
CREATE INDEX finance_refund_command_document_lookup
  ON finance_refund_command_idempotency(finance_document_id, created_at DESC);
CREATE INDEX weekly_fee_refund_effect_document_lookup
  ON weekly_fee_refund_effect(finance_document_id, created_at DESC);
