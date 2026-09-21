CREATE TABLE finance_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_document_id uuid NOT NULL REFERENCES finance_document(id),
  purpose text NOT NULL CHECK (purpose IN ('SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT','INVOICE')),
  created_by_person_id uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE finance_attachment_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_attachment_id uuid NOT NULL REFERENCES finance_attachment(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL CHECK (status IN ('UPLOADING','READY','FAILED')),
  original_filename text NOT NULL,
  declared_media_type text NOT NULL CHECK (declared_media_type IN ('application/pdf','image/png','image/jpeg')),
  declared_size_bytes bigint NOT NULL CHECK (declared_size_bytes > 0),
  expected_sha256 text CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$'),
  detected_media_type text CHECK (detected_media_type IS NULL OR detected_media_type IN ('application/pdf','image/png','image/jpeg')),
  actual_size_bytes bigint CHECK (actual_size_bytes IS NULL OR actual_size_bytes > 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  failure_code text,
  uploaded_by_person_id uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  UNIQUE (finance_attachment_id, version_no),
  CHECK ((status = 'UPLOADING' AND detected_media_type IS NULL AND actual_size_bytes IS NULL AND sha256 IS NULL AND failure_code IS NULL AND ready_at IS NULL)
    OR (status = 'READY' AND detected_media_type = declared_media_type AND actual_size_bytes = declared_size_bytes AND sha256 IS NOT NULL AND failure_code IS NULL AND ready_at IS NOT NULL AND (expected_sha256 IS NULL OR expected_sha256 = sha256))
    OR (status = 'FAILED' AND detected_media_type IS NULL AND actual_size_bytes IS NULL AND sha256 IS NULL AND failure_code IS NOT NULL AND ready_at IS NULL))
);

CREATE TABLE finance_attachment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_attachment_version_id uuid NOT NULL REFERENCES finance_attachment_version(id),
  event_type text NOT NULL CHECK (event_type = 'RESERVED'),
  actor_person_id uuid NOT NULL REFERENCES person(id),
  result_version_no integer NOT NULL CHECK (result_version_no > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE finance_attachment_reservation_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  finance_attachment_id uuid NOT NULL REFERENCES finance_attachment(id),
  finance_attachment_version_id uuid NOT NULL REFERENCES finance_attachment_version(id),
  result_version_no integer NOT NULL CHECK (result_version_no > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, idempotency_key)
);

CREATE FUNCTION refuse_finance_attachment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINANCE_ATTACHMENT_IMMUTABLE'; END;
$$;
CREATE FUNCTION refuse_finance_attachment_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINANCE_ATTACHMENT_EVENT_IMMUTABLE'; END;
$$;
CREATE FUNCTION refuse_finance_attachment_reservation_idempotency_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINANCE_ATTACHMENT_RESERVATION_IDEMPOTENCY_IMMUTABLE'; END;
$$;
CREATE FUNCTION guard_finance_attachment_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FINANCE_ATTACHMENT_VERSION_IMMUTABLE'; END IF;
  IF OLD.status <> 'UPLOADING' THEN RAISE EXCEPTION 'FINANCE_ATTACHMENT_VERSION_IMMUTABLE'; END IF;
  IF NEW.finance_attachment_id IS DISTINCT FROM OLD.finance_attachment_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
    OR NEW.declared_media_type IS DISTINCT FROM OLD.declared_media_type
    OR NEW.declared_size_bytes IS DISTINCT FROM OLD.declared_size_bytes
    OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
    OR NEW.uploaded_by_person_id IS DISTINCT FROM OLD.uploaded_by_person_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'FINANCE_ATTACHMENT_VERSION_METADATA_IMMUTABLE'; END IF;
  IF NEW.status = 'UPLOADING' THEN RAISE EXCEPTION 'FINANCE_ATTACHMENT_VERSION_STATE_CONFLICT'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_attachment_immutable BEFORE UPDATE OR DELETE ON finance_attachment FOR EACH ROW EXECUTE FUNCTION refuse_finance_attachment_mutation();
CREATE TRIGGER finance_attachment_event_immutable BEFORE UPDATE OR DELETE ON finance_attachment_event FOR EACH ROW EXECUTE FUNCTION refuse_finance_attachment_event_mutation();
CREATE TRIGGER finance_attachment_reservation_idempotency_immutable BEFORE UPDATE OR DELETE ON finance_attachment_reservation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_finance_attachment_reservation_idempotency_mutation();
CREATE TRIGGER finance_attachment_version_mutation_guard BEFORE UPDATE OR DELETE ON finance_attachment_version FOR EACH ROW EXECUTE FUNCTION guard_finance_attachment_version_mutation();
CREATE INDEX finance_attachment_document_lookup ON finance_attachment (finance_document_id, created_at, id);
CREATE INDEX finance_attachment_version_attachment_lookup ON finance_attachment_version (finance_attachment_id, version_no);
