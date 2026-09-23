import type { RoleContext } from "@teaching-research-alliance/contracts";
import {
  assertValidWeeklyFeeDraft,
  type WeeklyFeeDraft
} from "@teaching-research-alliance/domain";

export type ReferralRecord = Readonly<{
  id: string;
  receiverPersonId: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "ARCHIVED" | "REACTIVATED";
}>;

export type TeachingWeekRecord = Readonly<{
  id: string;
  settlementMonth: string;
  status: "OPEN" | "LOCKED";
}>;

export type ActiveVenueRecord = Readonly<{
  id: string;
  status: "ACTIVE" | "INACTIVE";
}>;

export type WeeklyFeeRecord = Readonly<WeeklyFeeDraft & {
  entryKey: string;
  version: number;
  recordedByPersonId: string;
  idempotencyKey: string;
}>;

export type WeeklyFeeServiceOptions = Readonly<{
  referrals: readonly ReferralRecord[];
  teachingWeeks: readonly TeachingWeekRecord[];
  venues: readonly ActiveVenueRecord[];
}>;

const assertTeacher = (context: RoleContext): void => {
  if (context.subject !== "TEACHING_TEACHER") throw new Error("FORBIDDEN_SCOPE");
};

const sameDraft = (left: WeeklyFeeRecord, right: WeeklyFeeDraft): boolean =>
  left.referralCaseId === right.referralCaseId &&
  left.teachingWeekId === right.teachingWeekId &&
  left.venueId === right.venueId &&
  left.settlementMonth === right.settlementMonth &&
  left.grossAmountCents === right.grossAmountCents &&
  left.expectedVersion === right.expectedVersion;

export class WeeklyFeeService {
  private readonly referrals = new Map<string, ReferralRecord>();
  private readonly teachingWeeks = new Map<string, TeachingWeekRecord>();
  private readonly venues = new Map<string, ActiveVenueRecord>();
  private readonly current = new Map<string, WeeklyFeeRecord>();
  private readonly history: WeeklyFeeRecord[] = [];
  private readonly idempotency = new Map<string, WeeklyFeeRecord>();

  public constructor(options: WeeklyFeeServiceOptions) {
    for (const referral of options.referrals) this.referrals.set(referral.id, referral);
    for (const week of options.teachingWeeks) this.teachingWeeks.set(week.id, week);
    for (const venue of options.venues) this.venues.set(venue.id, venue);
  }

  public acceptReferral(context: RoleContext, referralId: string): ReferralRecord {
    assertTeacher(context);
    const referral = this.referrals.get(referralId);
    if (referral === undefined) throw new Error("REFERRAL_NOT_FOUND");
    if (referral.receiverPersonId !== context.personId) throw new Error("FORBIDDEN_SCOPE");
    if (referral.status === "REJECTED") throw new Error("REFERRAL_NOT_ACCEPTABLE");
    if (referral.status === "ACCEPTED") return referral;
    const accepted: ReferralRecord = { ...referral, status: "ACCEPTED" };
    this.referrals.set(referralId, accepted);
    return accepted;
  }

  public recordWeeklyFee(
    context: RoleContext,
    draft: WeeklyFeeDraft,
    idempotencyKey: string
  ): WeeklyFeeRecord {
    assertTeacher(context);
    if (idempotencyKey.trim() === "") throw new Error("INVALID_INPUT:IDEMPOTENCY_KEY_REQUIRED");
    const previousRequest = this.idempotency.get(idempotencyKey);
    if (previousRequest !== undefined) {
      if (!sameDraft(previousRequest, draft) || previousRequest.recordedByPersonId !== context.personId) {
        throw new Error("IDEMPOTENCY_REPLAY");
      }
      return previousRequest;
    }

    assertValidWeeklyFeeDraft(draft);
    const referral = this.referrals.get(draft.referralCaseId);
    if (referral === undefined) throw new Error("REFERRAL_NOT_FOUND");
    if (referral.receiverPersonId !== context.personId) {
      throw new Error("FORBIDDEN_SCOPE");
    }
    const entryKey = `${draft.referralCaseId}:${draft.teachingWeekId}`;
    const previous = this.current.get(entryKey);
    if (referral.status === "ARCHIVED" && previous === undefined) throw new Error("REFERRAL_ARCHIVED");
    if (draft.expectedVersion !== (previous?.version ?? 0)) throw new Error("VERSION_CONFLICT");
    const week = this.teachingWeeks.get(draft.teachingWeekId);
    if (week === undefined) throw new Error("TEACHING_WEEK_NOT_FOUND");
    if (week.status !== "OPEN") throw new Error("PERIOD_LOCKED");
    if (week.settlementMonth !== draft.settlementMonth) throw new Error("PERIOD_MONTH_MISMATCH");
    const venue = this.venues.get(draft.venueId);
    if (venue === undefined
      || (venue.status !== "ACTIVE" && (previous === undefined || previous.venueId !== draft.venueId))) {
      throw new Error("VENUE_NOT_ACTIVE");
    }

    const record: WeeklyFeeRecord = {
      ...draft,
      entryKey,
      version: (previous?.version ?? 0) + 1,
      recordedByPersonId: context.personId,
      idempotencyKey
    };
    this.current.set(entryKey, record);
    this.history.push(record);
    this.idempotency.set(idempotencyKey, record);
    return record;
  }

  public getCurrent(referralCaseId: string, teachingWeekId: string): WeeklyFeeRecord | undefined {
    return this.current.get(`${referralCaseId}:${teachingWeekId}`);
  }

  public listHistory(referralCaseId: string, teachingWeekId: string): readonly WeeklyFeeRecord[] {
    const entryKey = `${referralCaseId}:${teachingWeekId}`;
    return this.history.filter((record) => record.entryKey === entryKey);
  }
}
