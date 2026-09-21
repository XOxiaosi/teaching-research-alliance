ALTER TABLE finance_attachment_event
  ADD COLUMN error_code text;

ALTER TABLE finance_attachment_event
  DROP CONSTRAINT finance_attachment_event_event_type_check,
  ADD CONSTRAINT finance_attachment_event_type_check
    CHECK (event_type IN ('RESERVED','READY','FAILED')),
  ADD CONSTRAINT finance_attachment_event_error_code_check
    CHECK ((event_type = 'FAILED' AND error_code IS NOT NULL)
      OR (event_type IN ('RESERVED','READY') AND error_code IS NULL));

CREATE INDEX finance_attachment_event_version_lookup
  ON finance_attachment_event (finance_attachment_version_id, created_at, id);
