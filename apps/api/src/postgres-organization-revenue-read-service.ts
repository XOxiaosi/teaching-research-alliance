import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const INTEGER = /^-?\d+$/;
const SETTLEMENT_KEYS = ["referrer", "planningMentor", "groupLeader", "teachingMentor", "venue", "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"] as const;

export type OrganizationRevenueFilter = Readonly<{ fromMonth: string; toMonth: string }>;

export type OrganizationRevenueAmounts = Readonly<{
  recordedGrossRevenueCents: bigint;
  refundedGrossRevenueCents: bigint;
  effectiveGrossRevenueCents: bigint;
  campusManagementFeeCents: bigint;
}>;

export type OrganizationRevenueRead = Readonly<{
  scope: Readonly<{ scope: "GLOBAL" | "REGION" | "CAMPUS"; regionId?: string; campusId?: string }>;
  period: Readonly<{ fromMonth: string; toMonth: string; asOf: string; mode: "LATEST_EFFECTIVE_SNAPSHOT" }>;
  campuses: readonly Readonly<OrganizationRevenueAmounts & {
    campusId: string;
    campusName: string;
    attributedRegionId: string;
    attributedRegionName: string;
  }>[];
  regions: readonly Readonly<OrganizationRevenueAmounts & {
    regionId: string;
    regionName: string;
    regionFinanceIncomeCents?: bigint;
  }>[];
  total: Readonly<OrganizationRevenueAmounts & { regionFinanceIncomeCents?: bigint }>;
}>;

type FeeRow = Readonly<{
  fee_id: string;
  fee_version: string;
  gross_amount_cents: string;
  receiver_person_id: string;
  referrer_person_id: string;
  week_starts_on: string;
  snapshot_json: unknown;
  context_json: unknown;
  snapshot_source_version: string | null;
  refund_source_version: string | null;
  refund_gross_amount_cents: string | null;
}>;

type AssignmentRow = Readonly<{ id: string; campus_id: string; region_id: string; campus_name: string; region_name: string }>;
type CampusRegionRow = Readonly<{ campus_id: string; region_id: string; campus_name: string; region_name: string }>;
type PersonAssignmentHistoryRow = Readonly<AssignmentRow & { person_id: string; valid_from: string; valid_to: string | null }>;
type CampusAssignmentHistoryRow = Readonly<AssignmentRow & { valid_from: string; valid_to: string | null }>;
type FrozenCampusAccount = Readonly<{ campusId: string; accountId: string; accountCode: string }>;
type SettlementAccountRow = Readonly<{ id: string; owner_type: string; owner_id: string; account_code: string; status: string }>;

type Attribution = Readonly<{ campusId: string; regionId: string; campusName: string; regionName: string }>;
type MutableAmounts = { recordedGrossRevenueCents: bigint; refundedGrossRevenueCents: bigint; effectiveGrossRevenueCents: bigint; campusManagementFeeCents: bigint; regionFinanceIncomeCents: bigint };

const invalid = (): never => { throw new Error("INVALID_INPUT"); };
const unavailable = (): never => { throw new Error("ORGANIZATION_REVENUE_DATA_UNAVAILABLE"); };

const object = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as Readonly<Record<string, unknown>>;
};

const cents = (value: unknown): bigint => {
  if (typeof value !== "string" || !INTEGER.test(value)) unavailable();
  return BigInt(value as string);
};

const validMonth = (value: string): boolean => {
  if (!MONTH.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const nextMonth = (month: string): string => {
  const date = new Date(`${month}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
};

const normalizeFilter = (filter: OrganizationRevenueFilter): OrganizationRevenueFilter => {
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)
    || typeof filter.fromMonth !== "string" || typeof filter.toMonth !== "string"
    || !validMonth(filter.fromMonth) || !validMonth(filter.toMonth) || filter.fromMonth > filter.toMonth) invalid();
  return { fromMonth: filter.fromMonth, toMonth: filter.toMonth };
};

const scopeFor = (context: RoleContext): OrganizationRevenueRead["scope"] => {
  if (!UUID.test(context.personId)) invalid();
  const noAdditionalScope = context.regionId === undefined && context.campusId === undefined && context.venueId === undefined;
  if (["SYSTEM_OWNER", "SYSTEM_ADMIN", "HEADQUARTERS_FINANCE"].includes(context.subject)) {
    if (context.scope !== "GLOBAL" || !noAdditionalScope) throw new Error("FORBIDDEN_SCOPE");
    return { scope: "GLOBAL" };
  }
  if (context.subject === "REGION_FINANCE") {
    if (context.scope !== "REGION" || !UUID.test(context.regionId ?? "") || context.campusId !== undefined || context.venueId !== undefined) throw new Error("FORBIDDEN_SCOPE");
    return { scope: "REGION", regionId: context.regionId as string };
  }
  if (context.subject === "CAMPUS_PRINCIPAL") {
    if (context.scope !== "CAMPUS" || !UUID.test(context.campusId ?? "") || context.regionId !== undefined || context.venueId !== undefined) throw new Error("FORBIDDEN_SCOPE");
    return { scope: "CAMPUS", campusId: context.campusId as string };
  }
  throw new Error("FORBIDDEN_SCOPE");
};

const zero = (): MutableAmounts => ({
  recordedGrossRevenueCents: 0n,
  refundedGrossRevenueCents: 0n,
  effectiveGrossRevenueCents: 0n,
  campusManagementFeeCents: 0n,
  regionFinanceIncomeCents: 0n
});

const snapshotLines = (value: unknown): Readonly<{ campusManagementFeeCents: bigint; regionFinanceIncomeCents: bigint }> => {
  const snapshot = object(value);
  const lines = snapshot.lines;
  if (!Array.isArray(lines) || lines.length !== SETTLEMENT_KEYS.length) unavailable();
  const amounts = new Map<string, bigint>();
  for (const rawLine of lines as unknown[]) {
    const line = object(rawLine);
    if (typeof line.key !== "string" || !SETTLEMENT_KEYS.includes(line.key as (typeof SETTLEMENT_KEYS)[number]) || amounts.has(line.key)) unavailable();
    const amount = cents(line.cents);
    if (amount < 0n) unavailable();
    amounts.set(line.key as string, amount);
  }
  if (amounts.size !== SETTLEMENT_KEYS.length || SETTLEMENT_KEYS.some((key) => !amounts.has(key))) unavailable();
  return {
    campusManagementFeeCents: amounts.get("campusConsultation")!,
    regionFinanceIncomeCents: amounts.get("regionFinance")!
  };
};

const snapshotAccountCode = (value: unknown, key: "campusConsultation"): string => {
  const accountByKey = object(object(value).accountByKey);
  const code = accountByKey[key];
  if (typeof code !== "string" || code.length === 0) unavailable();
  return code as string;
};

const snapshotAssignment = (contextJson: unknown): Readonly<{ campusId: string; regionId: string }> | undefined => {
  const context = object(contextJson);
  // Snapshots created before organization attribution did not carry this object.
  // Their receiver identity is still resolvable against effective person history.
  if (context.organization === null || context.organization === undefined) return undefined;
  const organization = object(context.organization);
  const assignment = organization.receiverCampusAssignment;
  if (assignment === null || assignment === undefined) return undefined;
  const row = object(assignment);
  if (!UUID.test(row.campus_id as string) || !UUID.test(row.region_id as string) || !UUID.test(row.id as string)) unavailable();
  return { campusId: row.campus_id as string, regionId: row.region_id as string };
};

const businessAt = (contextJson: unknown): string => {
  const value = object(contextJson).businessAt;
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) unavailable();
  return value as string;
};

const snapshotReceiverAssignment = (contextJson: unknown): Readonly<{ campusId: string; regionId: string }> | undefined =>
  snapshotAssignment(contextJson);

const dateAtWeekStart = (weekStartsOn: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartsOn) || !Number.isFinite(new Date(`${weekStartsOn}T00:00:00+08:00`).getTime())) unavailable();
  return `${weekStartsOn}T00:00:00+08:00`;
};

const accountCampusIfPresent = (contextJson: unknown): FrozenCampusAccount | undefined => {
  if (contextJson === null || contextJson === undefined) return undefined;
  const context = object(contextJson);
  if (context.accounts === null || context.accounts === undefined) return undefined;
  const accounts = object(context.accounts);
  if (accounts.campusConsultation === null || accounts.campusConsultation === undefined) return undefined;
  return campusConsultationRecipient(contextJson);
};

const effectiveHistory = <Row extends { valid_from: string; valid_to: string | null }>(rows: readonly Row[], at: string): Row => {
  const point = new Date(at).getTime();
  const matches = rows.filter((row) => new Date(row.valid_from).getTime() <= point && (row.valid_to === null || point < new Date(row.valid_to).getTime()));
  if (matches.length !== 1) unavailable();
  return matches[0]!;
};

const campusConsultationRecipient = (contextJson: unknown): FrozenCampusAccount => {
  const context = object(contextJson);
  const accounts = object(context.accounts);
  const account = object(accounts.campusConsultation);
  if (account.ownerType !== "COMPANY" || !UUID.test(account.ownerId as string)
    || !UUID.test(account.accountId as string) || typeof account.accountCode !== "string" || account.accountCode.length === 0) unavailable();
  return { campusId: account.ownerId as string, accountId: account.accountId as string, accountCode: account.accountCode as string };
};

/**
 * Read-only F07 organization revenue roll-up. Gross F is attributed to the receiver's
 * business-period campus. Management and regional finance are separately read from the
 * effective allocation snapshot and never added to gross revenue.
 */
export class PostgresOrganizationRevenueReadService {
  public constructor(private readonly pool: PostgresPool) {}

  private async readOnly<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.release();
    }
  }

  public async get(context: RoleContext, filter: OrganizationRevenueFilter, at: Date): Promise<OrganizationRevenueRead> {
    if (!Number.isFinite(at.getTime())) invalid();
    const scope = scopeFor(context);
    const period = normalizeFilter(filter);
    return this.readOnly(async (client) => {
      const fees = await client.query<FeeRow>(
        `SELECT fee.id::text AS fee_id, fee.version::text AS fee_version, fee.gross_amount_cents::text AS gross_amount_cents,
                referral.receiver_person_id::text AS receiver_person_id, referral.referrer_person_id::text AS referrer_person_id,
                week.starts_on::text AS week_starts_on, snapshot.snapshot_json, snapshot.context_json,
                snapshot.source_weekly_fee_version::text AS snapshot_source_version,
                refund.source_weekly_fee_version::text AS refund_source_version,
                refund.gross_amount_cents::text AS refund_gross_amount_cents
           FROM weekly_fee_entry fee
           JOIN referral_case referral ON referral.id=fee.referral_case_id
           JOIN teaching_week week ON week.id=fee.teaching_week_id
           LEFT JOIN LATERAL (
             SELECT candidate.snapshot_json, candidate.context_json, candidate.source_weekly_fee_version
               FROM weekly_fee_allocation_snapshot candidate
              WHERE candidate.weekly_fee_entry_id=fee.id AND candidate.source_weekly_fee_version=fee.version
              ORDER BY candidate.sequence_no DESC
              LIMIT 1
           ) snapshot ON true
           LEFT JOIN weekly_fee_refund_effect refund ON refund.weekly_fee_entry_id=fee.id
          WHERE fee.settlement_month >= $1::date AND fee.settlement_month <= $2::date
          ORDER BY fee.id`,
        [period.fromMonth, period.toMonth]
      );
      // Resolve all business-period history in bounded set queries. Query count is
      // independent of the number of fee rows: fees, person history, campus history,
      // frozen accounts, then zero-campus rows.
      const candidates = fees.rows.map((row) => {
        if (!UUID.test(row.fee_id) || !UUID.test(row.receiver_person_id) || !UUID.test(row.referrer_person_id)
          || !INTEGER.test(row.fee_version)) unavailable();
        let invalidContext = false;
        const parseCandidate = <T>(read: () => T, fallback: T): T => {
          try { return read(); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "ORGANIZATION_REVENUE_DATA_UNAVAILABLE") throw error;
            invalidContext = true;
            return fallback;
          }
        };
        // The authoritative teaching week can locate a damaged external snapshot.
        // This fallback only determines scope; relevant damaged rows still fail below.
        const weekStart = dateAtWeekStart(row.week_starts_on);
        const businessTime = row.context_json === null || row.context_json === undefined
          ? weekStart : parseCandidate(() => businessAt(row.context_json), weekStart);
        const receiverSnapshot = row.context_json === null || row.context_json === undefined
          ? undefined : parseCandidate(() => snapshotReceiverAssignment(row.context_json), undefined);
        // An explicit zero management line has no referrer contribution. Otherwise
        // frozen account or business-period referrer history is a scope candidate.
        let candidateLines: ReturnType<typeof snapshotLines> | undefined;
        if (row.snapshot_json !== null && row.snapshot_json !== undefined) {
          candidateLines = parseCandidate(() => snapshotLines(row.snapshot_json), undefined);
        }
        const managementAccount = candidateLines?.campusManagementFeeCents === 0n
          ? undefined : parseCandidate(() => accountCampusIfPresent(row.context_json), undefined);
        if (candidateLines !== undefined && candidateLines.campusManagementFeeCents > 0n && managementAccount === undefined) invalidContext = true;
        return { row, businessTime, receiverSnapshot, candidateLines, managementAccount, invalidContext };
      });
      const lowerTime = candidates.reduce((lowest, candidate) => lowest === undefined || new Date(candidate.businessTime).getTime() < new Date(lowest).getTime() ? candidate.businessTime : lowest, undefined as string | undefined);
      const upperTime = candidates.reduce((highest, candidate) => highest === undefined || new Date(candidate.businessTime).getTime() > new Date(highest).getTime() ? candidate.businessTime : highest, undefined as string | undefined);
      const personIds = [...new Set(candidates.flatMap((candidate) => [
        ...(candidate.receiverSnapshot === undefined ? [candidate.row.receiver_person_id] : []),
        ...(candidate.candidateLines?.campusManagementFeeCents === 0n || candidate.managementAccount !== undefined ? [] : [candidate.row.referrer_person_id])
      ]))];
      const personHistoryRows = personIds.length === 0 ? [] : (await client.query<PersonAssignmentHistoryRow>(
        `SELECT assignment.person_id::text AS person_id, assignment.id::text AS id, assignment.campus_id::text AS campus_id,
                assignment.region_id::text AS region_id, campus.name AS campus_name, region.name AS region_name,
                assignment.valid_from::text AS valid_from, assignment.valid_to::text AS valid_to
           FROM person_campus_assignment assignment
           JOIN organization_unit campus ON campus.id=assignment.campus_id AND campus.unit_type='CAMPUS'
           JOIN organization_unit region ON region.id=assignment.region_id AND region.unit_type='REGION'
          WHERE assignment.person_id=ANY($1::uuid[]) AND assignment.valid_from <= $2::timestamptz
            AND (assignment.valid_to IS NULL OR assignment.valid_to > $3::timestamptz)`,
        [personIds, upperTime, lowerTime]
      )).rows;
      const persons = new Map<string, PersonAssignmentHistoryRow[]>();
      for (const row of personHistoryRows) persons.set(row.person_id, [...(persons.get(row.person_id) ?? []), row]);
      const personAt = (personId: string, businessTime: string): PersonAssignmentHistoryRow => effectiveHistory(persons.get(personId) ?? [], businessTime);
      const campusIds = [...new Set(candidates.flatMap((candidate) => {
        const receiverCampus = candidate.receiverSnapshot?.campusId ?? personAt(candidate.row.receiver_person_id, candidate.businessTime).campus_id;
        const managementCampus = candidate.candidateLines?.campusManagementFeeCents === 0n ? undefined
          : candidate.managementAccount?.campusId ?? personAt(candidate.row.referrer_person_id, candidate.businessTime).campus_id;
        return managementCampus === undefined ? [receiverCampus] : [receiverCampus, managementCampus];
      }))];
      const campusHistoryRows = campusIds.length === 0 ? [] : (await client.query<CampusAssignmentHistoryRow>(
        `SELECT assignment.id::text AS id, assignment.campus_id::text AS campus_id, assignment.region_id::text AS region_id,
                campus.name AS campus_name, region.name AS region_name, assignment.valid_from::text AS valid_from,
                assignment.valid_to::text AS valid_to
           FROM campus_region_assignment assignment
           JOIN organization_unit campus ON campus.id=assignment.campus_id AND campus.unit_type='CAMPUS'
           JOIN organization_unit region ON region.id=assignment.region_id AND region.unit_type='REGION'
          WHERE assignment.campus_id=ANY($1::uuid[]) AND assignment.valid_from <= $2::timestamptz
            AND (assignment.valid_to IS NULL OR assignment.valid_to > $3::timestamptz)`,
        [campusIds, upperTime, lowerTime]
      )).rows;
      const campusesById = new Map<string, CampusAssignmentHistoryRow[]>();
      for (const row of campusHistoryRows) campusesById.set(row.campus_id, [...(campusesById.get(row.campus_id) ?? []), row]);
      const campusAt = (campusId: string, businessTime: string): Attribution => {
        const row = effectiveHistory(campusesById.get(campusId) ?? [], businessTime);
        return { campusId: row.campus_id, regionId: row.region_id, campusName: row.campus_name, regionName: row.region_name };
      };
      const receiverAt = (candidate: (typeof candidates)[number]): Attribution => {
        const snapshot = candidate.receiverSnapshot;
        const fallback = snapshot === undefined ? personAt(candidate.row.receiver_person_id, candidate.businessTime) : undefined;
        const attribution = campusAt(snapshot?.campusId ?? fallback!.campus_id, candidate.businessTime);
        // The campus history still identifies the affected scope when the frozen
        // region UUID is wrong. Defer rejection until that scope has been selected.
        if ((snapshot?.regionId ?? fallback!.region_id) !== attribution.regionId) candidate.invalidContext = true;
        return attribution;
      };
      const managementCandidateAt = (candidate: (typeof candidates)[number]): Attribution | undefined =>
        candidate.candidateLines?.campusManagementFeeCents === 0n ? undefined
          : campusAt(candidate.managementAccount?.campusId ?? personAt(candidate.row.referrer_person_id, candidate.businessTime).campus_id, candidate.businessTime);
      const frozenAccountIds = [...new Set(candidates.flatMap((candidate) => candidate.managementAccount === undefined ? [] : [candidate.managementAccount.accountId]))];
      const accountRows = frozenAccountIds.length === 0 ? [] : (await client.query<SettlementAccountRow>(
        `SELECT id::text AS id, owner_type, owner_id::text AS owner_id, account_code, status
           FROM settlement_account WHERE id=ANY($1::uuid[])`, [frozenAccountIds]
      )).rows;
      const accountsById = new Map(accountRows.map((row) => [row.id, row]));
      const campusTotals = new Map<string, MutableAmounts & Attribution>();
      const regionTotals = new Map<string, MutableAmounts & { regionId: string; regionName: string }>();
      const include = (attribution: Attribution): boolean => scope.scope === "GLOBAL"
        || (scope.scope === "REGION" && attribution.regionId === scope.regionId)
        || (scope.scope === "CAMPUS" && attribution.campusId === scope.campusId);
      const campusFor = (attribution: Attribution): MutableAmounts & Attribution => {
        const campusKey = `${attribution.campusId}:${attribution.regionId}`;
        const campus = campusTotals.get(campusKey) ?? { ...zero(), ...attribution };
        campusTotals.set(campusKey, campus);
        return campus;
      };
      const regionFor = (attribution: Attribution): MutableAmounts & { regionId: string; regionName: string } => {
        const region = regionTotals.get(attribution.regionId) ?? { ...zero(), regionId: attribution.regionId, regionName: attribution.regionName };
        regionTotals.set(attribution.regionId, region);
        return region;
      };
      const addGross = (attribution: Attribution, amount: bigint, refunded: bigint): void => {
        if (!include(attribution)) return;
        const campus = campusFor(attribution);
        campus.recordedGrossRevenueCents += amount;
        campus.refundedGrossRevenueCents += refunded;
        campus.effectiveGrossRevenueCents += amount - refunded;
        const region = regionFor(attribution);
        region.recordedGrossRevenueCents += amount;
        region.refundedGrossRevenueCents += refunded;
        region.effectiveGrossRevenueCents += amount - refunded;
      };
      const addManagement = (attribution: Attribution, amount: bigint): void => {
        if (amount === 0n || !include(attribution)) return;
        campusFor(attribution).campusManagementFeeCents += amount;
        regionFor(attribution).campusManagementFeeCents += amount;
      };
      const addRegionIncome = (attribution: Attribution, amount: bigint): void => {
        if (amount === 0n || scope.scope === "CAMPUS" || !include(attribution)) return;
        regionFor(attribution).regionFinanceIncomeCents += amount;
      };

      for (const candidate of candidates) {
        const { row } = candidate;
        const receiverAttribution = receiverAt(candidate);
        const candidateManagement = managementCandidateAt(candidate);
        // A scoped caller validates only rows that can contribute either its gross F
        // or its own campus consultation income. If an attribution cannot be resolved,
        // the prefetch resolver fails closed instead of treating it as external.
        if (!include(receiverAttribution) && (candidateManagement === undefined || !include(candidateManagement))) continue;
        if (candidate.invalidContext) unavailable();
        const gross = cents(row.gross_amount_cents);
        if (gross < 0n || row.snapshot_source_version !== row.fee_version || row.snapshot_json === null || row.context_json === null) unavailable();
        const lines = snapshotLines(row.snapshot_json);
        const refunded = row.refund_source_version === null && row.refund_gross_amount_cents === null ? 0n : (() => {
          if (row.refund_source_version !== row.fee_version || row.refund_gross_amount_cents === null) unavailable();
          const value = cents(row.refund_gross_amount_cents);
          if (value !== gross) unavailable();
          return value;
        })();
        addGross(receiverAttribution, gross, refunded);
        // The consultation fee is company revenue for the frozen receiving campus
        // account, which may be a different campus and region than the fee receiver.
        if (refunded === 0n && lines.campusManagementFeeCents > 0n) {
          const account = candidate.managementAccount;
          if (account === undefined) unavailable();
          const frozen = account as FrozenCampusAccount;
          if (snapshotAccountCode(row.snapshot_json, "campusConsultation") !== frozen.accountCode) unavailable();
          const persisted = accountsById.get(frozen.accountId);
          if (persisted === undefined || persisted.owner_type !== "COMPANY" || persisted.owner_id !== frozen.campusId
            || persisted.account_code !== frozen.accountCode) unavailable();
          const managementAttribution = campusAt(frozen.campusId, candidate.businessTime);
          addManagement(managementAttribution, lines.campusManagementFeeCents);
        }
        // Regional finance is a separate allocation payable for the receiver's
        // business-period region, not a component of either campus gross total.
        if (refunded === 0n) addRegionIncome(receiverAttribution, lines.regionFinanceIncomeCents);
      }

      const zeroRows = await client.query<CampusRegionRow>(
        `SELECT DISTINCT assignment.campus_id::text AS campus_id, assignment.region_id::text AS region_id,
                campus.name AS campus_name, region.name AS region_name
           FROM campus_region_assignment assignment
           JOIN organization_unit campus ON campus.id=assignment.campus_id AND campus.unit_type='CAMPUS'
           JOIN organization_unit region ON region.id=assignment.region_id AND region.unit_type='REGION'
          WHERE assignment.valid_from < $2::timestamptz
            AND (assignment.valid_to IS NULL OR assignment.valid_to > $1::timestamptz)
          ORDER BY region_name, region_id, campus_name, campus_id`,
        [`${period.fromMonth}T00:00:00+08:00`, `${nextMonth(period.toMonth)}T00:00:00+08:00`]
      );
      for (const row of zeroRows.rows) {
        if (!UUID.test(row.campus_id) || !UUID.test(row.region_id)) unavailable();
        const attribution: Attribution = { campusId: row.campus_id, regionId: row.region_id, campusName: row.campus_name, regionName: row.region_name };
        if (!include(attribution)) continue;
        const campusKey = `${attribution.campusId}:${attribution.regionId}`;
        if (!campusTotals.has(campusKey)) campusTotals.set(campusKey, { ...zero(), ...attribution });
        if (!regionTotals.has(attribution.regionId)) regionTotals.set(attribution.regionId, { ...zero(), regionId: attribution.regionId, regionName: attribution.regionName });
      }
      const campuses = [...campusTotals.values()].sort((left, right) => left.regionName.localeCompare(right.regionName) || left.campusName.localeCompare(right.campusName) || left.campusId.localeCompare(right.campusId));
      const regions = [...regionTotals.values()].sort((left, right) => left.regionName.localeCompare(right.regionName) || left.regionId.localeCompare(right.regionId));
      const total = zero();
      for (const campus of campuses) {
        total.recordedGrossRevenueCents += campus.recordedGrossRevenueCents;
        total.refundedGrossRevenueCents += campus.refundedGrossRevenueCents;
        total.effectiveGrossRevenueCents += campus.effectiveGrossRevenueCents;
        total.campusManagementFeeCents += campus.campusManagementFeeCents;
      }
      for (const region of regions) total.regionFinanceIncomeCents += region.regionFinanceIncomeCents;
      const commonTotal = {
        recordedGrossRevenueCents: total.recordedGrossRevenueCents,
        refundedGrossRevenueCents: total.refundedGrossRevenueCents,
        effectiveGrossRevenueCents: total.effectiveGrossRevenueCents,
        campusManagementFeeCents: total.campusManagementFeeCents
      };
      const visibleRegions = scope.scope === "CAMPUS" ? [] : regions.map((region) => ({
        regionId: region.regionId,
        regionName: region.regionName,
        recordedGrossRevenueCents: region.recordedGrossRevenueCents,
        refundedGrossRevenueCents: region.refundedGrossRevenueCents,
        effectiveGrossRevenueCents: region.effectiveGrossRevenueCents,
        campusManagementFeeCents: region.campusManagementFeeCents,
        regionFinanceIncomeCents: region.regionFinanceIncomeCents
      }));
      return {
        scope,
        period: { ...period, asOf: at.toISOString(), mode: "LATEST_EFFECTIVE_SNAPSHOT" },
        campuses: campuses.map((campus) => ({
          campusId: campus.campusId,
          campusName: campus.campusName,
          attributedRegionId: campus.regionId,
          attributedRegionName: campus.regionName,
          recordedGrossRevenueCents: campus.recordedGrossRevenueCents,
          refundedGrossRevenueCents: campus.refundedGrossRevenueCents,
          effectiveGrossRevenueCents: campus.effectiveGrossRevenueCents,
          campusManagementFeeCents: campus.campusManagementFeeCents
        })),
        regions: visibleRegions,
        total: scope.scope === "CAMPUS" ? commonTotal : { ...commonTotal, regionFinanceIncomeCents: total.regionFinanceIncomeCents }
      };
    });
  }
}
