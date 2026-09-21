ALTER TABLE finance_withdrawal_attachment_binding
  ADD CONSTRAINT finance_withdrawal_attachment_binding_time_frozen_check
    CHECK (bound_at = created_at);

CREATE OR REPLACE FUNCTION guard_finance_withdrawal_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_kind text;
  document_status text;
  document_version bigint;
  document_applicant uuid;
  authorized_actor uuid;
  attachment_slot uuid;
BEGIN
  SELECT kind,status,version,applicant_person_id
    INTO document_kind,document_status,document_version,document_applicant
    FROM finance_document
   WHERE id = NEW.finance_document_id;
  IF document_kind IS DISTINCT FROM 'WITHDRAWAL'
    OR NEW.document_version <> document_version THEN
    RAISE EXCEPTION 'FINANCE_WITHDRAWAL_ATTACHMENT_INVALID';
  END IF;

  IF NEW.stage = 'SUBMISSION' THEN
    SELECT submitted_by_person_id INTO authorized_actor
      FROM finance_withdrawal_submission
     WHERE finance_document_id = NEW.finance_document_id;
    IF document_status <> 'PENDING_TRANSFER'
      OR authorized_actor IS NULL
      OR NEW.bound_by_person_id <> document_applicant
      OR NEW.bound_by_person_id <> authorized_actor
      OR EXISTS (
        SELECT 1 FROM finance_withdrawal_command_idempotency command
         WHERE command.finance_document_id = NEW.finance_document_id
           AND command.operation = 'SUBMIT'
           AND command.result_status = 'PENDING_TRANSFER'
      ) THEN
      RAISE EXCEPTION 'FINANCE_WITHDRAWAL_ATTACHMENT_INVALID';
    END IF;
  ELSIF NEW.stage = 'COMPLETION' THEN
    SELECT transferred_by_person_id INTO authorized_actor
      FROM finance_withdrawal_transfer
     WHERE finance_document_id = NEW.finance_document_id;
    IF document_status <> 'TRANSFERRED'
      OR authorized_actor IS NULL
      OR NEW.bound_by_person_id <> authorized_actor
      OR EXISTS (
        SELECT 1 FROM finance_withdrawal_command_idempotency command
         WHERE command.finance_document_id = NEW.finance_document_id
           AND command.operation = 'MARK_TRANSFERRED'
           AND command.result_status = 'TRANSFERRED'
      ) THEN
      RAISE EXCEPTION 'FINANCE_WITHDRAWAL_ATTACHMENT_INVALID';
    END IF;
  ELSE
    RAISE EXCEPTION 'FINANCE_WITHDRAWAL_ATTACHMENT_INVALID';
  END IF;

  SELECT version.finance_attachment_id INTO attachment_slot
    FROM finance_attachment_version version
    JOIN finance_attachment attachment ON attachment.id = version.finance_attachment_id
   WHERE version.id = NEW.finance_attachment_version_id
     AND attachment.finance_document_id = NEW.finance_document_id
     AND version.status = 'READY'
     AND attachment.purpose = NEW.purpose;
  IF attachment_slot IS NULL OR EXISTS (
    SELECT 1
      FROM finance_withdrawal_attachment_binding existing
      JOIN finance_attachment_version existing_version ON existing_version.id = existing.finance_attachment_version_id
     WHERE existing.finance_document_id = NEW.finance_document_id
       AND existing.stage = NEW.stage
       AND existing_version.finance_attachment_id = attachment_slot
  ) THEN
    RAISE EXCEPTION 'FINANCE_WITHDRAWAL_ATTACHMENT_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
