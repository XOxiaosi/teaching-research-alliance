-- DEV-009 compatibility and accounting-integrity hardening.  0023 is immutable:
-- this migration upgrades an already-live 0023 schema without rewriting history.

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
    IF OLD.kind='REIMBURSEMENT' AND OLD.status='PENDING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED') AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.kind='REFUND' AND OLD.status='PENDING_APPROVAL' AND NEW.status IN ('REFUNDED','REJECTED') AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
    IF OLD.kind='REIMBURSEMENT' THEN RAISE EXCEPTION 'FINANCE_DOCUMENT_REIMBURSEMENT_TRANSITION_INVALID'; END IF;
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

-- 0023 made todos immutable. Temporarily remove that trigger only for this
-- schema backfill, then restore the same immutability rule before continuing.
DROP TRIGGER finance_benefit_todo_immutable ON finance_benefit_todo;
ALTER TABLE finance_benefit_todo ADD COLUMN benefit_kind text;
ALTER TABLE finance_benefit_todo ADD COLUMN beneficiary_person_id uuid REFERENCES person(id);
ALTER TABLE finance_benefit_todo ADD COLUMN benefit_month date;
UPDATE finance_benefit_todo todo
SET benefit_kind=plan.benefit_kind,
    beneficiary_person_id=plan.beneficiary_person_id,
    benefit_month=plan.benefit_month
FROM finance_benefit_plan_version plan
WHERE plan.id=todo.plan_version_id;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM finance_benefit_todo
    GROUP BY benefit_kind,beneficiary_person_id,benefit_month
    HAVING COUNT(*)>1
  ) THEN
    RAISE EXCEPTION 'FINANCE_BENEFIT_TODO_LEGACY_DUPLICATE';
  END IF;
END;
$$;
ALTER TABLE finance_benefit_plan_version
  ADD CONSTRAINT finance_benefit_plan_business_identity UNIQUE (id,benefit_kind,beneficiary_person_id,benefit_month);
ALTER TABLE finance_benefit_todo
  ALTER COLUMN benefit_kind SET NOT NULL,
  ALTER COLUMN beneficiary_person_id SET NOT NULL,
  ALTER COLUMN benefit_month SET NOT NULL,
  ADD CONSTRAINT finance_benefit_todo_kind_check CHECK (benefit_kind IN ('SOCIAL_INSURANCE','HOUSING_FUND')),
  ADD CONSTRAINT finance_benefit_todo_month_check CHECK (benefit_month=date_trunc('month',benefit_month)::date),
  ADD CONSTRAINT finance_benefit_todo_business_key UNIQUE (benefit_kind,beneficiary_person_id,benefit_month),
  ADD CONSTRAINT finance_benefit_todo_plan_business_fk
    FOREIGN KEY (plan_version_id,benefit_kind,beneficiary_person_id,benefit_month)
    REFERENCES finance_benefit_plan_version(id,benefit_kind,beneficiary_person_id,benefit_month);
CREATE TRIGGER finance_benefit_todo_immutable BEFORE UPDATE OR DELETE ON finance_benefit_todo FOR EACH ROW EXECUTE FUNCTION refuse_salary_benefit_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cash_wage_plan_version WHERE planned_cash_cents<>planned_deduction_cents) THEN
    RAISE EXCEPTION 'CASH_WAGE_PLAN_LEGACY_AMOUNT_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM cash_wage_confirmation WHERE cash_paid_cents<=0 OR cash_paid_cents<>deduction_cents) THEN
    RAISE EXCEPTION 'CASH_WAGE_CONFIRMATION_LEGACY_AMOUNT_INVALID';
  END IF;
END;
$$;
ALTER TABLE cash_wage_plan_version
  ADD COLUMN applies_to_future_months boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT cash_wage_plan_amount_matches CHECK (planned_cash_cents=planned_deduction_cents);
ALTER TABLE cash_wage_confirmation
  ADD CONSTRAINT cash_wage_confirmation_cash_positive CHECK (cash_paid_cents>0),
  ADD CONSTRAINT cash_wage_confirmation_amount_matches CHECK (cash_paid_cents=deduction_cents),
  ADD COLUMN correction_of_finance_document_id uuid REFERENCES finance_document(id),
  ADD CONSTRAINT cash_wage_confirmation_correction_once UNIQUE (correction_of_finance_document_id);
