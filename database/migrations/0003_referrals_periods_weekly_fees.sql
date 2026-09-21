CREATE TABLE academic_year_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE academic_period (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academic_year_plan_id uuid NOT NULL REFERENCES academic_year_plan(id),
  label text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE teaching_week (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academic_period_id uuid NOT NULL REFERENCES academic_period(id),
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  week_kind text NOT NULL CHECK (week_kind IN ('REGULAR', 'WINTER_SPECIAL', 'SUMMER_SPECIAL')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  settlement_month date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on),
  CHECK (settlement_month = date_trunc('month', settlement_month)::date),
  UNIQUE (academic_period_id, sequence_no)
);

CREATE TABLE teacher_student_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_teacher_id uuid NOT NULL REFERENCES person(id),
  course_context_id text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referral_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_student_record_id uuid NOT NULL REFERENCES teacher_student_record(id),
  referrer_person_id uuid NOT NULL REFERENCES person(id),
  receiver_person_id uuid NOT NULL REFERENCES person(id),
  referrer_identity text NOT NULL CHECK (referrer_identity IN ('TEACHING_TEACHER', 'ACADEMIC_PLANNER')),
  status text NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'ARCHIVED', 'REACTIVATED')),
  submitted_at timestamptz NOT NULL,
  unaccepted_expires_at timestamptz,
  copied_from_referral_id uuid REFERENCES referral_case(id),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referral_case_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  event_type text NOT NULL CHECK (event_type IN ('SUBMITTED', 'ACCEPTED', 'ARCHIVED', 'REACTIVATED', 'COPIED')),
  actor_person_id uuid NOT NULL REFERENCES person(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE weekly_fee_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_case_id uuid NOT NULL REFERENCES referral_case(id),
  teaching_week_id uuid NOT NULL REFERENCES teaching_week(id),
  settlement_month date NOT NULL,
  gross_amount_cents bigint NOT NULL CHECK (gross_amount_cents >= 0),
  venue_id uuid NOT NULL REFERENCES venue(id),
  venue_owner_person_id uuid NOT NULL REFERENCES person(id),
  is_self_use_snapshot boolean NOT NULL,
  source_case_version bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES person(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (settlement_month = date_trunc('month', settlement_month)::date),
  UNIQUE (referral_case_id, teaching_week_id)
);

CREATE TABLE weekly_fee_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_fee_entry_id uuid NOT NULL REFERENCES weekly_fee_entry(id),
  event_type text NOT NULL CHECK (event_type IN ('CREATED', 'CORRECTED', 'VOIDED')),
  actor_person_id uuid NOT NULL REFERENCES person(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX referral_case_receiver_lookup ON referral_case (receiver_person_id, status, submitted_at);
CREATE INDEX referral_case_referrer_lookup ON referral_case (referrer_person_id, status, submitted_at);
CREATE INDEX weekly_fee_month_lookup ON weekly_fee_entry (settlement_month, teaching_week_id);
