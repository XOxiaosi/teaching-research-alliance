import type { PermissionSubject } from "@teaching-research-alliance/contracts";
import type { Cents } from "./index.js";
import { DYNAMIC_TIERS, type DynamicTier } from "./rates.js";

export type RatePolicyValues = Readonly<{
  plannerBaseRateBasisPoints: bigint;
  teacherBaseRateBasisPoints: bigint;
  planningMentorWeightBasisPoints: bigint;
  groupLeaderRateBasisPoints: bigint;
  teachingMentorRateBasisPoints: bigint;
  venueRateBasisPoints: bigint;
  campusConsultationForPlannerRateBasisPoints: bigint;
  campusConsultationForTeacherRateBasisPoints: bigint;
  platformFinanceRateBasisPoints: bigint;
  regionFinanceRateBasisPoints: bigint;
  dynamicTiers: readonly DynamicTier[];
}>;

export type RatePolicyDraft = Readonly<RatePolicyValues & {
  effectiveFrom: string;
  reason: string;
}>;

export type RatePolicyVersion = Readonly<RatePolicyDraft & {
  version: number;
  publishedBy: "SYSTEM_OWNER" | "SYSTEM_ADMIN";
  publishedAt: string;
}>;

export type RatePolicyPreview = Readonly<{
  previewId: string;
  valid: boolean;
  errors: readonly string[];
  draft: RatePolicyDraft;
}>;

export type RateView = Readonly<{
  version: number;
  effectiveFrom: string;
  subject: PermissionSubject;
  visibleRates: Readonly<Record<string, bigint>>;
}>;

export const DEFAULT_RATE_POLICY_VALUES: RatePolicyValues = {
  plannerBaseRateBasisPoints: 1000n,
  teacherBaseRateBasisPoints: 1200n,
  planningMentorWeightBasisPoints: 2000n,
  groupLeaderRateBasisPoints: 600n,
  teachingMentorRateBasisPoints: 700n,
  venueRateBasisPoints: 500n,
  campusConsultationForPlannerRateBasisPoints: 200n,
  campusConsultationForTeacherRateBasisPoints: 0n,
  platformFinanceRateBasisPoints: 200n,
  regionFinanceRateBasisPoints: 100n,
  dynamicTiers: DYNAMIC_TIERS
};

const rateFields: readonly (keyof Omit<RatePolicyValues, "dynamicTiers">)[] = [
  "plannerBaseRateBasisPoints",
  "teacherBaseRateBasisPoints",
  "planningMentorWeightBasisPoints",
  "groupLeaderRateBasisPoints",
  "teachingMentorRateBasisPoints",
  "venueRateBasisPoints",
  "campusConsultationForPlannerRateBasisPoints",
  "campusConsultationForTeacherRateBasisPoints",
  "platformFinanceRateBasisPoints",
  "regionFinanceRateBasisPoints"
];

const isValidRate = (value: bigint): boolean => value >= 0n && value <= 10_000n;

const validateTiers = (tiers: readonly DynamicTier[]): readonly string[] => {
  const errors: string[] = [];
  if (tiers.length === 0) return ["DYNAMIC_TIERS_REQUIRED"];
  const labels = new Set<string>();
  tiers.forEach((tier, index) => {
    if (tier.label.trim() === "") errors.push(`DYNAMIC_TIER_LABEL_REQUIRED:${index}`);
    if (labels.has(tier.label)) errors.push(`DYNAMIC_TIER_LABEL_DUPLICATE:${tier.label}`);
    labels.add(tier.label);
    if (tier.adjustmentBasisPoints < -10_000n || tier.adjustmentBasisPoints > 10_000n) {
      errors.push(`DYNAMIC_TIER_ADJUSTMENT_INVALID:${index}`);
    }
    if (tier.minExclusive !== undefined && tier.maxInclusive !== undefined && tier.minExclusive >= tier.maxInclusive) {
      errors.push(`DYNAMIC_TIER_RANGE_INVALID:${index}`);
    }
    if (index === 0 && tier.minExclusive !== undefined) errors.push("DYNAMIC_TIER_FIRST_MIN_MUST_BE_OPEN");
    if (index === tiers.length - 1 && tier.maxInclusive !== undefined) errors.push("DYNAMIC_TIER_LAST_MAX_MUST_BE_OPEN");
    const previous = tiers[index - 1];
    if (previous !== undefined && (previous.maxInclusive === undefined || tier.minExclusive !== previous.maxInclusive)) {
      errors.push(`DYNAMIC_TIER_GAP_OR_OVERLAP:${index}`);
    }
  });
  return errors;
};

const totalFixed = (values: RatePolicyValues, campusRate: bigint): bigint =>
  values.groupLeaderRateBasisPoints +
  values.teachingMentorRateBasisPoints +
  values.venueRateBasisPoints +
  campusRate +
  values.platformFinanceRateBasisPoints +
  values.regionFinanceRateBasisPoints;

export const validateRatePolicyDraft = (draft: RatePolicyDraft): readonly string[] => {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom)) errors.push("EFFECTIVE_FROM_INVALID");
  if (draft.reason.trim() === "") errors.push("RATE_POLICY_REASON_REQUIRED");
  for (const field of rateFields) {
    if (!isValidRate(draft[field])) errors.push(`RATE_INVALID:${field}`);
  }
  errors.push(...validateTiers(draft.dynamicTiers));
  for (const tier of draft.dynamicTiers) {
    const plannerPool = draft.plannerBaseRateBasisPoints + tier.adjustmentBasisPoints;
    const teacherPool = draft.teacherBaseRateBasisPoints + tier.adjustmentBasisPoints;
    if (plannerPool < 0n || plannerPool > 10_000n) errors.push(`PLANNER_POOL_INVALID:${tier.label}`);
    if (teacherPool < 0n || teacherPool > 10_000n) errors.push(`TEACHER_POOL_INVALID:${tier.label}`);
    if (plannerPool + totalFixed(draft, draft.campusConsultationForPlannerRateBasisPoints) > 10_000n) {
      errors.push(`PLANNER_TOTAL_EXCEEDS_100:${tier.label}`);
    }
    if (teacherPool + totalFixed(draft, draft.campusConsultationForTeacherRateBasisPoints) > 10_000n) {
      errors.push(`TEACHER_TOTAL_EXCEEDS_100:${tier.label}`);
    }
  }
  return [...new Set(errors)];
};

const assertAdmin = (subject: PermissionSubject): "SYSTEM_OWNER" | "SYSTEM_ADMIN" => {
  if (subject !== "SYSTEM_OWNER" && subject !== "SYSTEM_ADMIN") throw new Error("FORBIDDEN_SCOPE");
  return subject;
};

const defaultPreviewIdFactory = (() => {
  let sequence = 0;
  return (): string => `rate-preview-synthetic-${++sequence}`;
})();

const defaultNow = (): string => new Date().toISOString();

export class RatePolicyService {
  private readonly previews = new Map<string, RatePolicyPreview>();
  private readonly history: RatePolicyVersion[];
  private readonly previewIdFactory: () => string;
  private readonly now: () => string;

  public constructor(options: Readonly<{
    initial?: RatePolicyVersion;
    previewIdFactory?: () => string;
    now?: () => string;
  }> = {}) {
    this.history = options.initial === undefined ? [] : [options.initial];
    this.previewIdFactory = options.previewIdFactory ?? defaultPreviewIdFactory;
    this.now = options.now ?? defaultNow;
  }

  public current(): RatePolicyVersion {
    const current = this.history.at(-1);
    if (current !== undefined) return current;
    return {
      ...DEFAULT_RATE_POLICY_VALUES,
      effectiveFrom: "2026-09-01",
      reason: "SYSTEM_DEFAULT",
      version: 0,
      publishedBy: "SYSTEM_OWNER",
      publishedAt: this.now()
    };
  }

  public preview(subject: PermissionSubject, draft: RatePolicyDraft): RatePolicyPreview {
    assertAdmin(subject);
    const errors = validateRatePolicyDraft(draft);
    const preview: RatePolicyPreview = {
      previewId: this.previewIdFactory(),
      valid: errors.length === 0,
      errors,
      draft
    };
    this.previews.set(preview.previewId, preview);
    return preview;
  }

  public publish(subject: PermissionSubject, previewId: string): RatePolicyVersion {
    const publishedBy = assertAdmin(subject);
    const preview = this.previews.get(previewId);
    if (preview === undefined) throw new Error("RATE_PREVIEW_NOT_FOUND");
    if (!preview.valid) throw new Error(`INVALID_RATE_POLICY:${preview.errors.join(",")}`);
    const next: RatePolicyVersion = {
      ...preview.draft,
      version: this.current().version + 1,
      publishedBy,
      publishedAt: this.now()
    };
    this.history.push(next);
    return next;
  }

  public historyVersions(subject: PermissionSubject): readonly RatePolicyVersion[] {
    assertAdmin(subject);
    return [...this.history];
  }

  public viewFor(subject: PermissionSubject): RateView {
    const current = this.current();
    if (subject === "SYSTEM_OWNER" || subject === "SYSTEM_ADMIN") return {
      version: current.version,
      effectiveFrom: current.effectiveFrom,
      subject,
      visibleRates: Object.fromEntries(rateFields.map((field) => [field, current[field]]))
    };
    const visibleRates: Record<string, bigint> = {};
    const expose = (field: keyof RatePolicyValues): void => { visibleRates[field] = current[field] as bigint; };
    if (subject === "ACADEMIC_PLANNER") {
      expose("plannerBaseRateBasisPoints");
      expose("planningMentorWeightBasisPoints");
      expose("campusConsultationForPlannerRateBasisPoints");
    } else if (subject === "TEACHING_TEACHER") {
      expose("teacherBaseRateBasisPoints");
      expose("groupLeaderRateBasisPoints");
      expose("teachingMentorRateBasisPoints");
      expose("venueRateBasisPoints");
      expose("platformFinanceRateBasisPoints");
      expose("regionFinanceRateBasisPoints");
    } else if (subject === "GROUP_LEADER") {
      expose("groupLeaderRateBasisPoints");
    } else if (subject === "TEACHING_MENTOR") {
      expose("teachingMentorRateBasisPoints");
    } else if (subject === "VENUE_OWNER") {
      expose("venueRateBasisPoints");
    } else if (subject === "CAMPUS_PRINCIPAL") {
      expose("campusConsultationForPlannerRateBasisPoints");
    } else if (subject === "REGION_FINANCE") {
      expose("regionFinanceRateBasisPoints");
    } else if (subject === "PLANNING_MENTOR") {
      expose("planningMentorWeightBasisPoints");
    }
    return { version: current.version, effectiveFrom: current.effectiveFrom, subject, visibleRates };
  }
}
