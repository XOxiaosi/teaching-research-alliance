-- DEV-009: cash wages, project bonuses and finance-funded benefits keep their own
-- business records.  They share the immutable finance-document attachment store,
-- but do not reuse reimbursement semantics.

ALTER TABLE finance_document DROP CONSTRAINT finance_document_kind_check;
ALTER TABLE finance_document
  ADD CONSTRAINT finance_document_kind_check CHECK (kind IN (
    'WITHDRAWAL','REIMBURSEMENT','EXTERNAL_PAYMENT','REFUND','SELF_PURCHASE',
    'CASH_WAGE','PROJECT_BONUS','FINANCE_BENEFIT'
  ));

ALTER TABLE finance_document DROP CONSTRAINT finance_document_status_check;
ALTER TABLE finance_document
  ADD CONSTRAINT finance_document_status_check CHECK (
    (kind = 'WITHDRAWAL' AND status IN ('DRAFT','PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED')) OR
    (kind = 'SELF_PURCHASE' AND status IN ('DRAFT','COMPLETED','REVERSED')) OR
    (kind = 'REIMBURSEMENT' AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED')) OR
    (kind = 'REFUND' AND status IN ('DRAFT','PENDING_APPROVAL','REFUNDED','REJECTED')) OR
    (kind IN ('CASH_WAGE','PROJECT_BONUS','FINANCE_BENEFIT') AND status IN ('DRAFT','COMPLETED','REVERSED')) OR
    (kind = 'EXTERNAL_PAYMENT' AND status = 'DRAFT')
  );

ALTER TABLE finance_document_event DROP CONSTRAINT finance_document_event_event_type_check;
ALTER TABLE finance_document_event
  ADD CONSTRAINT finance_document_event_event_type_check CHECK (event_type IN (
    'CREATED','SUBMITTED','TRANSFERRED','REVOKED','AUTO_COMPLETED','TRANSFER_REVERSED',
    'REIMBURSEMENT_SUBMITTED','REIMBURSEMENT_APPROVED','REIMBURSEMENT_REJECTED',
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
  IF OLD.kind IN ('REIMBURSEMENT','REFUND') THEN
    IF OLD.status='DRAFT' AND NEW.status='DRAFT' AND NEW.version IN (OLD.version,OLD.version+1) THEN RETURN NEW; END IF;
    IF OLD.status='DRAFT' AND NEW.status='PENDING_APPROVAL' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.status='PENDING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED','REFUNDED') AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'FINANCE_DOCUMENT_REVIEW_TRANSITION_INVALID';
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

CREATE TABLE cash_wage_plan_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_person_id uuid NOT NULL REFERENCES person(id),
  salary_month date NOT NULL CHECK (salary_month = date_trunc('month', salary_month)::date),
  version_no integer NOT NULL CHECK (version_no > 0),
  planned_cash_cents bigint NOT NULL CHECK (planned_cash_cents >= 0),
  planned_deduction_cents bigint NOT NULL CHECK (planned_deduction_cents >= 0),
  active boolean NOT NULL,
  changed_by_person_id uuid NOT NULL REFERENCES person(id),
  changed_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  UNIQUE (teacher_person_id,salary_month,version_no)
);

CREATE TABLE cash_wage_todo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_person_id uuid NOT NULL REFERENCES person(id),
  salary_month date NOT NULL CHECK (salary_month = date_trunc('month', salary_month)::date),
  plan_version_id uuid NOT NULL REFERENCES cash_wage_plan_version(id),
  generated_at timestamptz NOT NULL,
  UNIQUE (teacher_person_id,salary_month)
);

CREATE TABLE finance_benefit_plan_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benefit_kind text NOT NULL CHECK (benefit_kind IN ('SOCIAL_INSURANCE','HOUSING_FUND')),
  beneficiary_person_id uuid NOT NULL REFERENCES person(id),
  benefit_month date NOT NULL CHECK (benefit_month = date_trunc('month', benefit_month)::date),
  version_no integer NOT NULL CHECK (version_no > 0),
  execution_day integer NOT NULL CHECK (execution_day BETWEEN 1 AND 31),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  source_fund_id uuid NOT NULL REFERENCES company_finance_fund(id),
  active boolean NOT NULL,
  changed_by_person_id uuid NOT NULL REFERENCES person(id),
  changed_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  UNIQUE (benefit_kind,beneficiary_person_id,benefit_month,version_no)
);

CREATE TABLE finance_benefit_todo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id uuid NOT NULL UNIQUE REFERENCES finance_benefit_plan_version(id),
  generated_at timestamptz NOT NULL
);

CREATE TABLE salary_benefit_attachment_binding (
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  finance_attachment_version_id uuid NOT NULL UNIQUE REFERENCES finance_attachment_version(id),
  purpose text NOT NULL CHECK (purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT')),
  document_version bigint NOT NULL CHECK (document_version > 0),
  bound_by_person_id uuid NOT NULL REFERENCES person(id),
  bound_at timestamptz NOT NULL,
  PRIMARY KEY(finance_document_id,finance_attachment_version_id)
);

CREATE TABLE cash_wage_confirmation (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  todo_id uuid REFERENCES cash_wage_todo(id),
  teacher_person_id uuid NOT NULL REFERENCES person(id),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  salary_month date NOT NULL CHECK (salary_month = date_trunc('month', salary_month)::date),
  cash_paid_cents bigint NOT NULL CHECK (cash_paid_cents >= 0),
  deduction_cents bigint NOT NULL CHECK (deduction_cents > 0),
  paid_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  confirmed_by_person_id uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE project_bonus_transfer (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  project_no integer NOT NULL CHECK (project_no BETWEEN 1 AND 10),
  project_name text NOT NULL CHECK (length(btrim(project_name)) BETWEEN 1 AND 200),
  recipient_person_id uuid NOT NULL REFERENCES person(id),
  destination_account_id uuid NOT NULL REFERENCES settlement_account(id),
  source_fund_id uuid NOT NULL REFERENCES company_finance_fund(id),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  granted_by_person_id uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE finance_benefit_execution (
  finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  todo_id uuid NOT NULL UNIQUE REFERENCES finance_benefit_todo(id),
  plan_version_id uuid NOT NULL REFERENCES finance_benefit_plan_version(id),
  source_fund_id uuid NOT NULL REFERENCES company_finance_fund(id),
  source_account_id uuid NOT NULL REFERENCES settlement_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  executed_by_person_id uuid NOT NULL REFERENCES person(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL
);

CREATE TABLE salary_benefit_reversal (
  reversal_finance_document_id uuid PRIMARY KEY REFERENCES finance_document(id),
  original_finance_document_id uuid NOT NULL UNIQUE REFERENCES finance_document(id),
  original_ledger_event_id uuid NOT NULL REFERENCES ledger_event(id),
  reversal_ledger_event_id uuid NOT NULL UNIQUE REFERENCES ledger_event(id),
  reversed_by_person_id uuid NOT NULL REFERENCES person(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL
);

CREATE TABLE salary_benefit_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  operation text NOT NULL CHECK (operation IN ('CREATE_DOCUMENT','SET_WAGE_PLAN','GENERATE_WAGE_TODOS','CONFIRM_WAGE','GRANT_BONUS','SET_BENEFIT_PLAN','GENERATE_BENEFIT_TODOS','CONFIRM_BENEFIT','REVERSE_POSTING')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(actor_person_id,operation,idempotency_key)
);

CREATE FUNCTION guard_salary_benefit_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc_applicant uuid; doc_version bigint; slot_id uuid;
BEGIN
  SELECT applicant_person_id,version INTO doc_applicant,doc_version FROM finance_document
   WHERE id=NEW.finance_document_id AND kind IN ('CASH_WAGE','PROJECT_BONUS','FINANCE_BENEFIT') AND status='COMPLETED';
  IF doc_applicant IS NULL OR doc_applicant<>NEW.bound_by_person_id OR doc_version<>NEW.document_version
    OR NOT EXISTS (SELECT 1 FROM finance_attachment a JOIN finance_attachment_version v ON v.finance_attachment_id=a.id
      WHERE a.finance_document_id=NEW.finance_document_id AND v.id=NEW.finance_attachment_version_id AND v.status='READY' AND a.purpose=NEW.purpose) THEN
    RAISE EXCEPTION 'SALARY_BENEFIT_ATTACHMENT_INVALID';
  END IF;
  SELECT finance_attachment_id INTO slot_id FROM finance_attachment_version WHERE id=NEW.finance_attachment_version_id;
  IF slot_id IS NULL OR EXISTS (SELECT 1 FROM salary_benefit_attachment_binding b JOIN finance_attachment_version v ON v.id=b.finance_attachment_version_id WHERE b.finance_document_id=NEW.finance_document_id AND v.finance_attachment_id=slot_id) THEN RAISE EXCEPTION 'SALARY_BENEFIT_ATTACHMENT_INVALID'; END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION refuse_salary_benefit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SALARY_BENEFIT_IMMUTABLE'; END; $$;
CREATE TRIGGER salary_benefit_attachment_binding_guard BEFORE INSERT ON salary_benefit_attachment_binding FOR EACH ROW EXECUTE FUNCTION guard_salary_benefit_attachment_binding();
CREATE TRIGGER cash_wage_plan_version_immutable BEFORE UPDATE OR DELETE ON cash_wage_plan_version FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER cash_wage_todo_immutable BEFORE UPDATE OR DELETE ON cash_wage_todo FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER finance_benefit_plan_version_immutable BEFORE UPDATE OR DELETE ON finance_benefit_plan_version FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER finance_benefit_todo_immutable BEFORE UPDATE OR DELETE ON finance_benefit_todo FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER salary_benefit_attachment_binding_immutable BEFORE UPDATE OR DELETE ON salary_benefit_attachment_binding FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER cash_wage_confirmation_immutable BEFORE UPDATE OR DELETE ON cash_wage_confirmation FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER project_bonus_transfer_immutable BEFORE UPDATE OR DELETE ON project_bonus_transfer FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER finance_benefit_execution_immutable BEFORE UPDATE OR DELETE ON finance_benefit_execution FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER salary_benefit_reversal_immutable BEFORE UPDATE OR DELETE ON salary_benefit_reversal FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();
CREATE TRIGGER salary_benefit_command_immutable BEFORE UPDATE OR DELETE ON salary_benefit_command_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();

CREATE INDEX cash_wage_plan_due_lookup ON cash_wage_plan_version(salary_month,teacher_person_id,version_no DESC);
CREATE INDEX finance_benefit_plan_due_lookup ON finance_benefit_plan_version(benefit_month,execution_day,benefit_kind,beneficiary_person_id,version_no DESC);
