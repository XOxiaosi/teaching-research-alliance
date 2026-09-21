CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname text NOT NULL UNIQUE,
  legal_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL UNIQUE REFERENCES person(id),
  phone_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  login_status text NOT NULL CHECK (login_status IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_type text NOT NULL CHECK (unit_type IN ('HEADQUARTERS', 'REGION', 'CAMPUS', 'GROUP')),
  name text NOT NULL,
  parent_id uuid REFERENCES organization_unit(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_type, name)
);

CREATE TABLE settlement_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL CHECK (owner_type IN ('PERSON', 'COMPANY', 'VENUE')),
  owner_id uuid NOT NULL,
  account_code text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE role_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES person(id),
  subject_code text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('GLOBAL', 'REGION', 'CAMPUS', 'ASSOCIATED_TEACHERS', 'MENTEES', 'VENUE', 'SELF')),
  scope_id uuid,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_person_id uuid REFERENCES person(id),
  action_code text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  before_json jsonb,
  after_json jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX role_assignment_lookup ON role_assignment (person_id, subject_code, valid_from, valid_to);
CREATE INDEX audit_event_subject ON audit_event (subject_type, subject_id, created_at);
