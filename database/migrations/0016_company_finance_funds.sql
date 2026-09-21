CREATE TABLE company_finance_fund (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind = 'HEADQUARTERS_FINANCE_OPERATING'),
  fund_code text NOT NULL UNIQUE CHECK (fund_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0 AND length(display_name) <= 200),
  organization_unit_id uuid REFERENCES organization_unit(id),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version bigint NOT NULL CHECK (version > 0),
  created_by_person_id uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE company_finance_fund_assignment (
  id uuid PRIMARY KEY,
  fund_id uuid NOT NULL REFERENCES company_finance_fund(id),
  duty_subject text NOT NULL CHECK (duty_subject = 'HEADQUARTERS_FINANCE'),
  scope_type text NOT NULL CHECK (scope_type = 'GLOBAL'),
  scope_id uuid,
  responsibility_code text NOT NULL CHECK (responsibility_code = 'FINANCE_OPERATING_SOURCE'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_by_person_id uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL,
  CHECK (scope_id IS NULL),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    duty_subject WITH =,
    scope_type WITH =,
    responsibility_code WITH =,
    tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
  )
);

CREATE TABLE company_finance_fund_command_idempotency (
  actor_person_id uuid NOT NULL REFERENCES person(id),
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('CREATE', 'ASSIGN', 'SET_STATUS')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_person_id, idempotency_key)
);

CREATE FUNCTION guard_company_finance_fund_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unit_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COMPANY_FUND_IMMUTABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.organization_unit_id IS NOT NULL THEN
      SELECT unit_type INTO unit_kind FROM organization_unit WHERE id = NEW.organization_unit_id;
      IF unit_kind IS DISTINCT FROM 'HEADQUARTERS' THEN
        RAISE EXCEPTION 'COMPANY_FUND_ORGANIZATION_INVALID';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.fund_code IS DISTINCT FROM OLD.fund_code
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.organization_unit_id IS DISTINCT FROM OLD.organization_unit_id
    OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'COMPANY_FUND_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.status NOT IN ('ACTIVE', 'INACTIVE')
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'COMPANY_FUND_STATUS_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_company_finance_fund_assignment_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COMPANY_FUND_ASSIGNMENT_IMMUTABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.valid_to IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.fund_id IS DISTINCT FROM OLD.fund_id
    OR NEW.duty_subject IS DISTINCT FROM OLD.duty_subject
    OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
    OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
    OR NEW.responsibility_code IS DISTINCT FROM OLD.responsibility_code
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.valid_to IS NULL
    OR NEW.valid_to <= OLD.valid_from THEN
    RAISE EXCEPTION 'COMPANY_FUND_ASSIGNMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refuse_company_finance_fund_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'COMPANY_FUND_COMMAND_IDEMPOTENCY_IMMUTABLE';
END;
$$;

CREATE TRIGGER company_finance_fund_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON company_finance_fund
FOR EACH ROW EXECUTE FUNCTION guard_company_finance_fund_mutation();

CREATE TRIGGER company_finance_fund_assignment_mutation_guard
BEFORE UPDATE OR DELETE ON company_finance_fund_assignment
FOR EACH ROW EXECUTE FUNCTION guard_company_finance_fund_assignment_mutation();

CREATE TRIGGER company_finance_fund_command_immutable
BEFORE UPDATE OR DELETE ON company_finance_fund_command_idempotency
FOR EACH ROW EXECUTE FUNCTION refuse_company_finance_fund_command_mutation();

CREATE INDEX company_finance_fund_assignment_current_lookup
  ON company_finance_fund_assignment (duty_subject, scope_type, responsibility_code, valid_from, valid_to);
CREATE INDEX company_finance_fund_assignment_fund_history_lookup
  ON company_finance_fund_assignment (fund_id, valid_from DESC);
