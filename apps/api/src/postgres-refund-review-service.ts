import { createHash, randomUUID } from "node:crypto";
import type { RoleContext } from "@teaching-research-alliance/contracts";
import { allocationDelta, postLedgerEvent, type LedgerDelta } from "@teaching-research-alliance/domain";
import { LocalAttachmentStore, type AttachmentMediaType } from "./local-attachment-store.js";
import { createPostgresLedgerTransaction, type PostgresClient, type PostgresPool } from "./postgres-ledger-repository.js";
import { prepareLedgerPosting } from "./postgres-ledger-locks.js";

export type RefundReviewDraft = Readonly<{ expectedVersion: number; reason: string }>;
export type RefundReviewResult = Readonly<{ id: string; status: "REFUNDED" | "REJECTED"; version: number; replay: boolean }>;
type Decision = "APPROVED" | "REJECTED";
type DocumentRow = { id: string; kind: string; status: string; applicant_person_id: string; version: string };
type SubmissionRow = { referral_case_id: string; student_record_id: string; result_document_version: string; source_document_version: string; reason: string; applicant_context_snapshot: unknown; submitted_by_person_id: string; submitted_at: string; created_at: string };
type SelectedRow = { id: string; submitted_fee_version: string; submitted_gross: string; submitted_week: string; submitted_month: string; version: string; gross: string; week: string; month: string; referral: string; student: string; receiver: string; refunded: boolean };
type SnapshotRow = { id: string; fee_id: string; source_version: string; gross: string; snapshot_json: unknown; context_json: unknown; run_id: string; sequence_no: string };
type Snapshot = { lines: { key: string; cents: bigint }[]; accountByKey: Record<string, string> };
type AccountFact = { id: string; ownerType: string; ownerId: string; code: string };
const keys = ["referrer", "planningMentor", "groupLeader", "teachingMentor", "venue", "campusConsultation", "platformFinance", "regionFinance", "teachingTeacher"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code = "FINANCE_REFUND_DATA_UNAVAILABLE"): never => { throw new Error(code); };
const object = (value: unknown): Record<string, unknown> => { if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(); return value as Record<string, unknown>; };
const string = (value: unknown): string => { if (typeof value !== "string") return fail(); return value; };
const cents = (value: unknown): bigint => { const text = string(value); if (!/^[0-9]+$/.test(text) || text.length > 19 || BigInt(text) > 9223372036854775807n) return fail(); return BigInt(text); };
const identifier = (value: unknown): string => { const text = string(value); if (!uuid.test(text)) return fail(); return text.toLowerCase(); };
const version = (value: string): number => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) return fail(); return number; };
const timestamp = (value: string): number => { const time = new Date(value).getTime(); if (!Number.isFinite(time)) return fail(); return time; };
const json = (value: unknown): string => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const hash = (value: unknown): string => createHash("sha256").update(json(value)).digest("hex");
const aggregate = (lines: readonly LedgerDelta[]): LedgerDelta[] => {
  const values = new Map<string, LedgerDelta>();
  for (const line of lines) { const key = JSON.stringify([line.accountKey, line.categoryKey]); values.set(key, { ...line, amountCents: (values.get(key)?.amountCents ?? 0n) + line.amountCents }); }
  return [...values.values()].filter(line => line.amountCents !== 0n).sort((a, b) => json([a.accountKey, a.categoryKey]).localeCompare(json([b.accountKey, b.categoryKey])));
};
const decode = (value: unknown, gross?: bigint): Snapshot => {
  const raw = object(value), map = object(raw.accountByKey);
  if (!Array.isArray(raw.lines) || raw.lines.length !== keys.length) return fail();
  const lines = raw.lines.map(item => { const line = object(item); return { key: string(line.key), cents: cents(line.cents) }; });
  if (new Set(lines.map(line => line.key)).size !== keys.length || lines.some(line => !keys.includes(line.key)) || Object.keys(map).some(key => !keys.includes(key))) return fail();
  const accountByKey: Record<string, string> = {};
  for (const [key, code] of Object.entries(map)) { accountByKey[key] = string(code); if (!accountByKey[key]!.trim()) return fail(); }
  if (lines.some(line => line.cents !== 0n && accountByKey[line.key] === undefined)) return fail();
  if (gross !== undefined && lines.reduce((sum, line) => sum + line.cents, 0n) !== gross) return fail();
  return { lines, accountByKey };
};

/** Approves the frozen fee selection using its latest effective allocation; cash repayment stays offline. */
export class PostgresRefundReviewService {
  public constructor(private readonly pool: PostgresPool, private readonly store: LocalAttachmentStore) {}
  public approve(context: RoleContext, id: string, draft: RefundReviewDraft, key: string, at: Date): Promise<RefundReviewResult> { return this.decide(context, id, draft, key, at, "APPROVED"); }
  public reject(context: RoleContext, id: string, draft: RefundReviewDraft, key: string, at: Date): Promise<RefundReviewResult> { return this.decide(context, id, draft, key, at, "REJECTED"); }

  private async decide(context: RoleContext, documentId: string, draft: RefundReviewDraft, key: string, at: Date, decision: Decision): Promise<RefundReviewResult> {
    if (context.subject !== "HEADQUARTERS_FINANCE" || context.scope !== "GLOBAL" || context.regionId !== undefined || context.campusId !== undefined || context.venueId !== undefined) fail("FORBIDDEN_SCOPE");
    if (!uuid.test(context.personId) || !uuid.test(documentId) || !Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1 || draft.expectedVersion >= Number.MAX_SAFE_INTEGER
      || !draft.reason.trim() || draft.reason.trim().length > 1000 || /[\x00-\x1f\x7f]/.test(draft.reason) || !key.trim() || key.length > 200 || /[\x00-\x1f\x7f]/.test(key) || !Number.isFinite(at.getTime())) fail("INVALID_INPUT");
    const actor = context.personId.toLowerCase(), id = documentId.toLowerCase(), reason = draft.reason.trim();
    const operation = decision === "APPROVED" ? "APPROVE" : "REJECT", status = decision === "APPROVED" ? "REFUNDED" : "REJECTED";
    const requestHash = hash(["refund.review.v1", operation, actor, id, draft.expectedVersion, reason]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`refund:${actor}:${operation}:${key}`]);
      const replay = (await client.query<{ request_hash: string; finance_document_id: string; result_status: string; result_document_version: string }>(
        "SELECT request_hash,finance_document_id::text,result_status,result_document_version::text FROM finance_refund_command_idempotency WHERE actor_person_id=$1 AND operation=$2 AND idempotency_key=$3", [actor, operation, key])).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) fail("IDEMPOTENCY_REPLAY");
        if (replay.finance_document_id !== id || replay.result_status !== status) fail();
        const result: RefundReviewResult = { id, status, version: version(replay.result_document_version), replay: true };
        await client.query("COMMIT"); return result;
      }
      const document = (await client.query<DocumentRow>("SELECT id::text,kind,status,applicant_person_id::text,version::text FROM finance_document WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!document || document.kind !== "REFUND") fail("FINANCE_DOCUMENT_NOT_FOUND");
      if (document!.status !== "PENDING_APPROVAL") fail("REFUND_STATE_CONFLICT");
      if (version(document!.version) !== draft.expectedVersion) fail("VERSION_CONFLICT");
      const submission = (await client.query<SubmissionRow>("SELECT referral_case_id::text,student_record_id::text,source_document_version::text,result_document_version::text,reason,applicant_context_snapshot,submitted_by_person_id::text,submitted_at::text,created_at::text FROM finance_refund_submission WHERE finance_document_id=$1", [id])).rows[0];
      if (!submission) fail();
      this.assertSubmission(document!, submission!, at);
      const months = (await client.query<{ month: string }>(`SELECT DISTINCT settlement_month::text AS "month" FROM finance_refund_submission_item WHERE finance_document_id=$1 ORDER BY "month"`, [id])).rows;
      if (months.length === 0) fail();
      for (const month of months) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`settlement-month:${month.month}`]);
      const fees = (await client.query<SelectedRow>(
        `SELECT fee.id::text,item.submitted_fee_version::text,item.submitted_gross_amount_cents::text submitted_gross,
                item.teaching_week_id::text submitted_week,item.settlement_month::text submitted_month,
                fee.version::text,fee.gross_amount_cents::text gross,fee.teaching_week_id::text week,fee.settlement_month::text AS "month",
                referral.id::text referral,referral.teacher_student_record_id::text student,referral.receiver_person_id::text receiver,
                EXISTS(SELECT 1 FROM weekly_fee_refund_effect effect WHERE effect.weekly_fee_entry_id=fee.id) refunded
           FROM finance_refund_submission_item item JOIN weekly_fee_entry fee ON fee.id=item.weekly_fee_entry_id
           JOIN referral_case referral ON referral.id=fee.referral_case_id WHERE item.finance_document_id=$1 ORDER BY fee.id FOR UPDATE OF fee`, [id])).rows;
      const count = (await client.query<{ count: string }>("SELECT count(*)::text count FROM finance_refund_submission_item WHERE finance_document_id=$1", [id])).rows[0];
      if (fees.length === 0 || String(fees.length) !== count?.count || fees.some(fee => fee.receiver !== document!.applicant_person_id || fee.referral !== submission!.referral_case_id || fee.student !== submission!.student_record_id || fee.month !== fee.submitted_month || fee.week !== fee.submitted_week || version(fee.version) < version(fee.submitted_fee_version))) fail();
      await this.verifySelectedVersions(client, fees);
      if (decision === "APPROVED" && fees.some(fee => fee.refunded)) fail("WEEKLY_FEE_REFUNDED");
      if (decision === "APPROVED") await this.verifyAttachments(client, document!, submission!);
      const snapshots: SnapshotRow[] = [], deltas: LedgerDelta[] = [], facts = new Map<string, AccountFact>();
      let gross = 0n, eventId: string | null = null;
      if (decision === "APPROVED") {
        for (const fee of fees) {
          const row = (await client.query<SnapshotRow>(
            `SELECT snapshot.id::text,snapshot.weekly_fee_entry_id::text fee_id,snapshot.source_weekly_fee_version::text source_version,
                    fee_version.gross_amount_cents::text gross,snapshot.snapshot_json,snapshot.context_json,snapshot.run_id::text,snapshot.sequence_no::text
               FROM weekly_fee_allocation_snapshot snapshot JOIN weekly_fee_entry_version fee_version ON fee_version.weekly_fee_entry_id=snapshot.weekly_fee_entry_id AND fee_version.version=snapshot.source_weekly_fee_version
              WHERE snapshot.weekly_fee_entry_id=$1 ORDER BY snapshot.sequence_no DESC LIMIT 1`, [fee.id])).rows[0];
          if (!row || row.source_version !== fee.version || row.gross !== fee.gross) fail();
          const decoded = decode(row!.snapshot_json, cents(fee.gross)), contextSnapshot = object(row!.context_json);
          if (contextSnapshot.feeEntryId !== fee.id || String(contextSnapshot.feeVersion) !== fee.version || contextSnapshot.receiverPersonId !== fee.receiver || contextSnapshot.settlementMonth !== fee.month) fail();
          const accounts = object(contextSnapshot.accounts);
          for (const [category, code] of Object.entries(decoded.accountByKey)) {
            const account = object(accounts[category]);
            const fact = { id: identifier(account.accountId), ownerId: identifier(account.ownerId), ownerType: string(account.ownerType), code };
            if (account.accountCode !== code || !["PERSON", "VENUE", "COMPANY"].includes(fact.ownerType)) fail();
            const previous = facts.get(code); if (previous && json(previous) !== json(fact)) fail(); facts.set(code, fact);
          }
          deltas.push(...allocationDelta(decoded.lines, [], decoded.accountByKey)); snapshots.push(row!); gross += cents(fee.gross);
        }
        await this.verifyHistoricalRuns(client, fees.map(fee => fee.id));
        const combined = aggregate(deltas);
        if (combined.length > 0) {
          const eventKey = `weekly-fee-refund:${id}`;
          for (const code of new Set(combined.map(line => line.accountKey))) {
            const fact = facts.get(code); if (!fact) fail();
            if (!(await client.query("SELECT 1 FROM account_balance_projection WHERE account_id=$1", [fact!.id])).rows.length) fail();
          }
          const prepared = await prepareLedgerPosting(client, eventKey, combined.map(line => line.accountKey));
          for (const account of prepared) { const fact = facts.get(account.accountCode); if (!fact || fact.id !== account.id || fact.ownerId !== account.ownerId || fact.ownerType !== account.ownerType) fail(); }
          const bound = createPostgresLedgerTransaction(client);
          const posted = await postLedgerEvent({ transaction: work => work(bound) }, { eventKey, eventType: "WEEKLY_FEE_REFUND", payloadHash: hash({ id, actor, reason, snapshots: snapshots.map(row => row.id), deltas: combined }), deltas: combined }, randomUUID);
          if (posted.status !== "POSTED") fail();
          eventId = posted.event.eventId;
          for (const account of prepared) { const delta = combined.filter(line => line.accountKey === account.accountCode).reduce((sum, line) => sum + line.amountCents, 0n); if (posted.balances[account.accountCode] !== account.balanceCents + delta) fail(); }
        } else if ((await client.query("SELECT 1 FROM ledger_event WHERE event_key=$1", [`weekly-fee-refund:${id}`])).rows.length) fail();
      }
      const nextVersion = draft.expectedVersion + 1;
      await client.query("UPDATE finance_document SET status=$2,version=$3,updated_at=$4 WHERE id=$1", [id, status, nextVersion, at]);
      await client.query("INSERT INTO finance_refund_command_idempotency(actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [actor, operation, key, requestHash, id, status, nextVersion, at]);
      const authorization = { reviewerPersonId: actor, reviewerSubjectCode: "HEADQUARTERS_FINANCE", reviewerScopeType: "GLOBAL", reviewerContextRegionId: null, reviewerContextCampusId: null, reviewerContextVenueId: null, submissionDocumentVersion: draft.expectedVersion, submissionSnapshot: submission!.applicant_context_snapshot };
      await client.query(`INSERT INTO finance_refund_decision(finance_document_id,source_document_version,result_document_version,decision,reason,decided_by_person_id,actor_subject_code,actor_scope_type,authorization_snapshot,decided_at,created_at,posting_status,ledger_event_id,approved_gross_amount_cents)
        VALUES($1,$2,$3,$4,$5,$6,'HEADQUARTERS_FINANCE','GLOBAL',$7::jsonb,$8,$8,$9,$10,$11)`, [id, draft.expectedVersion, nextVersion, decision, reason, actor, json(authorization), at, decision === "REJECTED" ? "REJECTED" : eventId ? "POSTED" : "NO_BALANCE_CHANGE", eventId, gross.toString()]);
      for (const snapshot of snapshots) await client.query("INSERT INTO weekly_fee_refund_effect(weekly_fee_entry_id,finance_document_id,allocation_snapshot_id,source_weekly_fee_version,gross_amount_cents,snapshot_json,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", [snapshot.fee_id, id, snapshot.id, snapshot.source_version, snapshot.gross, json(snapshot.snapshot_json), at]);
      await client.query("INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,ledger_event_id,details_json,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", [id, decision === "APPROVED" ? "REFUND_APPROVED" : "REFUND_REJECTED", actor, nextVersion, eventId, json({ reason, processingMode: "MANUAL", approvedGrossAmountCents: gross.toString() }), at]);
      await client.query("COMMIT"); return { id, status, version: nextVersion, replay: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { await client.release(); }
  }

  private assertSubmission(document: DocumentRow, submission: SubmissionRow, at: Date): void {
    if (submission.submitted_by_person_id !== document.applicant_person_id || version(submission.result_document_version) !== version(document.version) || version(submission.source_document_version) + 1 !== version(document.version)
      || !submission.reason.trim() || submission.reason.length > 1000 || /[\x00-\x1f\x7f]/.test(submission.reason) || timestamp(submission.submitted_at) !== timestamp(submission.created_at) || at.getTime() < timestamp(submission.submitted_at)) fail();
    const snapshot = object(submission.applicant_context_snapshot);
    const expectedKeys = ["applicantPersonId", "applicantContextSubject", "applicantContextScope", "applicantContextRegionId", "applicantContextCampusId", "applicantContextVenueId", "referralCaseId", "studentRecordId"];
    if (Object.keys(snapshot).length !== expectedKeys.length || expectedKeys.some(key => !(key in snapshot))
      || identifier(snapshot.referralCaseId) !== submission.referral_case_id || identifier(snapshot.studentRecordId) !== submission.student_record_id) fail();
    if (identifier(snapshot.applicantPersonId) !== document.applicant_person_id || snapshot.applicantContextSubject !== "TEACHING_TEACHER" || !["SELF", "REGION", "CAMPUS", "ASSOCIATED_TEACHERS", "MENTEES", "VENUE", "GLOBAL"].includes(string(snapshot.applicantContextScope))) fail();
    for (const key of ["applicantContextRegionId", "applicantContextCampusId", "applicantContextVenueId"]) if (snapshot[key] !== null) identifier(snapshot[key]);
  }

  private async verifySelectedVersions(client: PostgresClient, fees: readonly SelectedRow[]): Promise<void> {
    for (const fee of fees) {
      const original = (await client.query<{ gross: string; week: string; month: string }>("SELECT gross_amount_cents::text gross,teaching_week_id::text week,settlement_month::text AS \"month\" FROM weekly_fee_entry_version WHERE weekly_fee_entry_id=$1 AND version=$2", [fee.id, fee.submitted_fee_version])).rows[0];
      if (!original || original.gross !== fee.submitted_gross || original.week !== fee.submitted_week || original.month !== fee.submitted_month) fail();
    }
  }

  private async verifyAttachments(client: PostgresClient, document: DocumentRow, submission: SubmissionRow): Promise<void> {
    const rows = (await client.query<{ version_id: string; slot: string; purpose: string; attachment_purpose: string; owner_document: string; status: string; media: string; size: string; sha: string; document_version: string; bound_by: string }>(
      `SELECT version.id::text version_id,attachment.id::text slot,binding.purpose,attachment.purpose attachment_purpose,attachment.finance_document_id::text owner_document,
              version.status,version.detected_media_type media,version.actual_size_bytes::text size,version.sha256 sha,binding.document_version::text,binding.bound_by_person_id::text bound_by
         FROM finance_refund_attachment_binding binding JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
         JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id WHERE binding.finance_document_id=$1 AND binding.stage='SUBMISSION' FOR SHARE OF binding,version,attachment`, [document.id])).rows;
    if (rows.length < 2 || new Set(rows.map(row => row.slot)).size !== rows.length || ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT"].some(purpose => !rows.some(row => row.purpose === purpose)) || rows.some(row => row.status !== "READY" || row.purpose !== row.attachment_purpose || !["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"].includes(row.purpose) || row.owner_document !== document.id || row.bound_by !== document.applicant_person_id || row.document_version !== submission.result_document_version)) fail("FINANCE_ATTACHMENT_NOT_READY");
    for (const row of rows) {
      if (!["image/png", "image/jpeg", "application/pdf"].includes(row.media) || !Number.isSafeInteger(Number(row.size)) || Number(row.size) < 1 || !/^[0-9a-f]{64}$/.test(row.sha)) fail("ATTACHMENT_INTEGRITY_FAILED");
      try { await this.store.readVerified({ versionId: row.version_id, mediaType: row.media as AttachmentMediaType, sizeBytes: Number(row.size), sha256: row.sha }); } catch { fail("ATTACHMENT_INTEGRITY_FAILED"); }
    }
  }

  /** Whole runs aggregate several fees, so verify each run's full delta instead of pretending an entry belongs to one fee. */
  private async verifyHistoricalRuns(client: PostgresClient, feeIds: readonly string[]): Promise<void> {
    const runs = (await client.query<{ id: string; request_key: string; status: string; ledger_event_id: string | null }>(
      `SELECT DISTINCT run.id::text,run.request_key,run.status,run.ledger_event_id::text FROM settlement_calculation_run run
       JOIN weekly_fee_allocation_snapshot snapshot ON snapshot.run_id=run.id WHERE snapshot.weekly_fee_entry_id=ANY($1::uuid[]) ORDER BY run.id::text`, [feeIds])).rows;
    if (!runs.length) fail();
    for (const run of runs) {
      const rows = (await client.query<{ snapshot_json: unknown; previous: unknown | null; gross: string }>(
        `SELECT current.snapshot_json,previous.snapshot_json previous,fee_version.gross_amount_cents::text gross FROM weekly_fee_allocation_snapshot current
         JOIN weekly_fee_entry_version fee_version ON fee_version.weekly_fee_entry_id=current.weekly_fee_entry_id AND fee_version.version=current.source_weekly_fee_version
         LEFT JOIN LATERAL(SELECT earlier.snapshot_json FROM weekly_fee_allocation_snapshot earlier WHERE earlier.weekly_fee_entry_id=current.weekly_fee_entry_id AND earlier.sequence_no<current.sequence_no ORDER BY earlier.sequence_no DESC LIMIT 1) previous ON true WHERE current.run_id=$1`, [run.id])).rows;
      const expected = aggregate(rows.flatMap(row => { const next = decode(row.snapshot_json, cents(row.gross)), previous = row.previous === null ? { lines: [], accountByKey: {} } : decode(row.previous); return allocationDelta(previous.lines, next.lines, previous.accountByKey, next.accountByKey); }));
      if (!rows.length) fail();
      if (!expected.length) { if (run.status !== "NO_BALANCE_CHANGE" || run.ledger_event_id !== null) fail(); continue; }
      if (run.status !== "POSTED" || run.ledger_event_id === null) fail();
      const event = (await client.query<{ event_key: string; event_type: string }>("SELECT event_key,event_type FROM ledger_event WHERE id=$1", [run.ledger_event_id])).rows[0];
      if (event?.event_key !== `weekly-settlement:${run.request_key}` || event.event_type !== "WEEKLY_FEE_SETTLEMENT") fail();
      const actual = (await client.query<{ account_code: string; category_key: string; amount: string }>("SELECT account.account_code,entry.category_key,entry.amount_cents::text amount FROM ledger_entry entry JOIN settlement_account account ON account.id=entry.account_id WHERE entry.event_id=$1", [run.ledger_event_id])).rows;
      if (json(aggregate(actual.map(row => ({ accountKey: row.account_code, categoryKey: row.category_key, amountCents: BigInt(row.amount) })))) !== json(expected)) fail();
    }
  }
}
