-- GAP-009 / P43: ordinary reimbursement review opinions are optional.
-- Existing non-empty opinions and all attachment bindings remain immutable.

ALTER TABLE finance_reimbursement_decision
  DROP CONSTRAINT finance_reimbursement_decision_reason_check,
  ADD CONSTRAINT finance_reimbursement_decision_reason_check
    CHECK (length(btrim(reason)) <= 1000);
