export type WeeklyFeeDraft = Readonly<{
  referralCaseId: string;
  teachingWeekId: string;
  venueId: string;
  settlementMonth: string;
  grossAmountCents: bigint;
  expectedVersion?: number;
}>;

export const validateWeeklyFeeDraft = (draft: WeeklyFeeDraft): readonly string[] => {
  const errors: string[] = [];
  if (draft.referralCaseId.trim() === "") errors.push("REFERRAL_CASE_REQUIRED");
  if (draft.teachingWeekId.trim() === "") errors.push("TEACHING_WEEK_REQUIRED");
  if (draft.venueId.trim() === "") errors.push("VENUE_REQUIRED");
  if (!/^\d{4}-\d{2}-01$/.test(draft.settlementMonth)) errors.push("SETTLEMENT_MONTH_MUST_BE_MONTH_START");
  if (draft.grossAmountCents < 0n) errors.push("GROSS_AMOUNT_NEGATIVE");
  if (draft.expectedVersion !== undefined && (
    !Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 0
  )) errors.push("EXPECTED_VERSION_INVALID");
  return errors;
};

export const assertValidWeeklyFeeDraft = (draft: WeeklyFeeDraft): WeeklyFeeDraft => {
  const errors = validateWeeklyFeeDraft(draft);
  if (errors.length > 0) throw new Error(`INVALID_WEEKLY_FEE:${errors.join(",")}`);
  return draft;
};
