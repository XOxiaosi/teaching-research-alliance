-- GAP-003: a teaching referral may be closed after acceptance. The lifecycle
-- remains append-only and existing history continues to use its original rows.

ALTER TABLE referral_case
  DROP CONSTRAINT referral_case_status_check,
  ADD CONSTRAINT referral_case_status_check
    CHECK (status IN ('PENDING', 'ACCEPTED', 'ARCHIVED', 'REACTIVATED', 'COMPLETED'));

ALTER TABLE referral_case_event
  DROP CONSTRAINT referral_case_event_event_type_check,
  ADD CONSTRAINT referral_case_event_event_type_check
    CHECK (event_type IN ('SUBMITTED', 'ACCEPTED', 'ARCHIVED', 'REACTIVATED', 'COMPLETED', 'COPIED'));

ALTER TABLE referral_lifecycle_idempotency
  DROP CONSTRAINT referral_lifecycle_idempotency_operation_check,
  DROP CONSTRAINT referral_lifecycle_idempotency_result_status_check,
  ADD CONSTRAINT referral_lifecycle_idempotency_operation_check
    CHECK (operation IN ('ARCHIVE', 'REACTIVATE', 'COMPLETE')),
  ADD CONSTRAINT referral_lifecycle_idempotency_result_status_check
    CHECK (result_status IN ('ARCHIVED', 'REACTIVATED', 'COMPLETED')),
  ADD CONSTRAINT referral_lifecycle_idempotency_operation_result_check
    CHECK (
      (operation = 'ARCHIVE' AND result_status = 'ARCHIVED')
      OR (operation = 'REACTIVATE' AND result_status = 'REACTIVATED')
      OR (operation = 'COMPLETE' AND result_status = 'COMPLETED')
    );
