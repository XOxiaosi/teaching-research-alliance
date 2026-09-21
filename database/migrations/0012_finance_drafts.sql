CREATE TABLE finance_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_person_id uuid NOT NULL REFERENCES person(id),
  kind text NOT NULL CHECK (kind IN ('WITHDRAWAL', 'REIMBURSEMENT', 'EXTERNAL_PAYMENT', 'REFUND', 'SELF_PURCHASE')),
  status text NOT NULL CONSTRAINT finance_document_status_draft_check CHECK (status = 'DRAFT'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE finance_document_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  event_type text NOT NULL CHECK (event_type = 'CREATED'),
  actor_person_id uuid NOT NULL REFERENCES person(id),
  result_document_version bigint NOT NULL CHECK (result_document_version > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE finance_draft_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  result_document_version bigint NOT NULL CHECK (result_document_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, idempotency_key)
);

CREATE FUNCTION refuse_finance_document_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_DOCUMENT_EVENT_IMMUTABLE';
END;
$$;

CREATE FUNCTION refuse_finance_draft_idempotency_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_DRAFT_IDEMPOTENCY_IMMUTABLE';
END;
$$;

CREATE TRIGGER finance_document_event_immutable
BEFORE UPDATE OR DELETE ON finance_document_event
FOR EACH ROW EXECUTE FUNCTION refuse_finance_document_event_mutation();

CREATE TRIGGER finance_draft_idempotency_immutable
BEFORE UPDATE OR DELETE ON finance_draft_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_finance_draft_idempotency_mutation();

CREATE INDEX finance_document_applicant_lookup
  ON finance_document (applicant_person_id, created_at DESC, id DESC);
