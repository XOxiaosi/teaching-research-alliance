CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE teacher_profile (
  person_id uuid PRIMARY KEY REFERENCES person(id),
  business_identity text NOT NULL CHECK (business_identity IN ('TEACHING_TEACHER', 'ACADEMIC_PLANNER')),
  region_id uuid REFERENCES organization_unit(id),
  campus_id uuid REFERENCES organization_unit(id),
  grade_subject text,
  employment_status text NOT NULL CHECK (employment_status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campus_region_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campus_id uuid NOT NULL REFERENCES organization_unit(id),
  region_id uuid NOT NULL REFERENCES organization_unit(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE person_campus_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES person(id),
  campus_id uuid NOT NULL REFERENCES organization_unit(id),
  region_id uuid NOT NULL REFERENCES organization_unit(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (person_id WITH =, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&)
);

CREATE TABLE person_relationship (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES person(id),
  relationship_type text NOT NULL CHECK (relationship_type IN ('CAMPUS_PRINCIPAL', 'GROUP_LEADER', 'TEACHING_MENTOR', 'PLANNING_MENTOR')),
  related_person_id uuid NOT NULL REFERENCES person(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  effective_scope text,
  created_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (teacher_id WITH =, relationship_type WITH =, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&)
);

CREATE TABLE venue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_person_id uuid NOT NULL REFERENCES person(id),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  default_for_owner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venue_permission_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venue(id),
  grantee_person_id uuid NOT NULL REFERENCES person(id),
  can_view boolean NOT NULL DEFAULT false,
  can_withdraw boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  granted_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (venue_id WITH =, grantee_person_id WITH =, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&)
);

CREATE INDEX teacher_profile_org_lookup ON teacher_profile (region_id, campus_id, employment_status);
CREATE INDEX person_relationship_lookup ON person_relationship (teacher_id, relationship_type, valid_from, valid_to);
CREATE INDEX venue_permission_lookup ON venue_permission_grant (venue_id, grantee_person_id, valid_from, valid_to);
CREATE INDEX person_campus_assignment_lookup ON person_campus_assignment (person_id, valid_from, valid_to);
ALTER TABLE campus_region_assignment
  ADD CONSTRAINT campus_region_assignment_no_overlap
  EXCLUDE USING gist (campus_id WITH =, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&);
CREATE UNIQUE INDEX one_default_venue_per_owner
  ON venue (owner_person_id)
  WHERE default_for_owner;
