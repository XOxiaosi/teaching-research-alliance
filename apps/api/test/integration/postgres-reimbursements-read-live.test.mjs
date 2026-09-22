import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresReimbursementReadService } from "../../dist/postgres-reimbursement-read-service.js";
import { createTestDatabase } from "./postgres-test-database.mjs";

const at = new Date("2026-09-21T04:00:00.000Z");
const personal = (personId, subject = "TEACHING_TEACHER", scope = "SELF", extra = {}) => ({ personId, subject, scope, ...extra });
const managed = (personId, subject = "HEADQUARTERS_FINANCE", extra = {}) => ({ personId, subject, scope: "GLOBAL", ...extra });
const digest = "a".repeat(64);

const insertPerson = async (pool, id, label) => {
  await pool.query(
    "INSERT INTO person(id,nickname,legal_name,status) VALUES($1::uuid,$2,'合成测试人员','ACTIVE')",
    [id, `reimbursement-${label}-${id}`]
  );
};

const insertPersonAccount = async (pool, personId) => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO settlement_account(id,owner_type,owner_id,account_code,status) VALUES($1::uuid,'PERSON',$2::uuid,$3,'ACTIVE')",
    [id, personId, `person:${personId}`]
  );
  await pool.query("INSERT INTO account_balance_projection(account_id,balance_cents) VALUES($1::uuid,777)", [id]);
  return id;
};

const seedReimbursement = async (pool, {
  applicantId, destinationAccountId, applicantContext, submittedAt, status, reason, reviewerId, decisionReason
}) => {
  const documentId = randomUUID();
  const attachmentVersions = [];
  const purposes = ["SUPPORTING_DOCUMENT", "APPLICATION_SCREENSHOT", "INVOICE"];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO finance_document(id,applicant_person_id,kind,status,version,created_at,updated_at)
       VALUES($1::uuid,$2::uuid,'REIMBURSEMENT','DRAFT',1,$3::timestamptz,$3::timestamptz)`,
      [documentId, applicantId, submittedAt.toISOString()]
    );
    await client.query(
      `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
       VALUES($1::uuid,'CREATED',$2::uuid,1,$3::timestamptz)`,
      [documentId, applicantId, submittedAt.toISOString()]
    );
    for (const purpose of purposes) {
      const attachmentId = randomUUID();
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO finance_attachment(id,finance_document_id,purpose,created_by_person_id,created_at)
         VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::timestamptz)`,
        [attachmentId, documentId, purpose, applicantId, submittedAt.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_attachment_version(
           id,finance_attachment_id,version_no,status,original_filename,declared_media_type,declared_size_bytes,
           expected_sha256,detected_media_type,actual_size_bytes,sha256,failure_code,uploaded_by_person_id,created_at,ready_at
         ) VALUES($1::uuid,$2::uuid,1,'READY',$3,'image/png',64,$4,'image/png',64,$4,NULL,$5::uuid,$6::timestamptz,$6::timestamptz)`,
        [versionId, attachmentId, `${purpose}.png`, digest, applicantId, submittedAt.toISOString()]
      );
      attachmentVersions.push({ attachmentId, versionId, purpose });
    }
    await client.query(
      "UPDATE finance_document SET status='PENDING_APPROVAL',version=2,updated_at=$2::timestamptz WHERE id=$1::uuid",
      [documentId, submittedAt.toISOString()]
    );
    const applicantSnapshot = {
      applicantPersonId: applicantId,
      applicantContextSubject: applicantContext.subject,
      applicantContextScope: applicantContext.scope,
      applicantContextRegionId: applicantContext.regionId ?? null,
      applicantContextCampusId: applicantContext.campusId ?? null,
      applicantContextVenueId: applicantContext.venueId ?? null,
      destinationAccountId
    };
    await client.query(
      `INSERT INTO finance_reimbursement_submission(
         finance_document_id,source_document_version,result_document_version,destination_account_id,amount_cents,reason,
         applicant_context_snapshot,submitted_by_person_id,submitted_at,created_at
       ) VALUES($1::uuid,1,2,$2::uuid,12345,$3,$4::jsonb,$5::uuid,$6::timestamptz,$6::timestamptz)`,
      [documentId, destinationAccountId, reason, JSON.stringify(applicantSnapshot), applicantId, submittedAt.toISOString()]
    );
    for (const attachment of attachmentVersions) {
      await client.query(
        `INSERT INTO finance_reimbursement_attachment_binding(
           finance_document_id,stage,purpose,finance_attachment_version_id,document_version,bound_by_person_id,bound_at,created_at
         ) VALUES($1::uuid,'SUBMISSION',$2,$3::uuid,2,$4::uuid,$5::timestamptz,$5::timestamptz)`,
        [documentId, attachment.purpose, attachment.versionId, applicantId, submittedAt.toISOString()]
      );
    }
    await client.query(
      `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
       VALUES($1::uuid,'REIMBURSEMENT_SUBMITTED',$2::uuid,2,$3::timestamptz)`,
      [documentId, applicantId, submittedAt.toISOString()]
    );
    await client.query(
      `INSERT INTO finance_reimbursement_command_idempotency(
         actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at
       ) VALUES($1::uuid,'SUBMIT',$2,$3,$4::uuid,'PENDING_APPROVAL',2,$5::timestamptz)`,
      [applicantId, `submit-${documentId}`, digest, documentId, submittedAt.toISOString()]
    );

    if (status === "APPROVED" || status === "REJECTED") {
      const decidedAt = new Date(submittedAt.getTime() + 60_000);
      const operation = status === "APPROVED" ? "APPROVE" : "REJECT";
      const eventType = status === "APPROVED" ? "REIMBURSEMENT_APPROVED" : "REIMBURSEMENT_REJECTED";
      await client.query(
        "UPDATE finance_document SET status=$2,version=3,updated_at=$3::timestamptz WHERE id=$1::uuid",
        [documentId, status, decidedAt.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_reimbursement_command_idempotency(
           actor_person_id,operation,idempotency_key,request_hash,finance_document_id,result_status,result_document_version,created_at
         ) VALUES($1::uuid,$2,$3,$4,$5::uuid,$6,3,$7::timestamptz)`,
        [reviewerId, operation, `${operation.toLowerCase()}-${documentId}`, digest, documentId, status, decidedAt.toISOString()]
      );
      const authorization = {
        reviewerPersonId: reviewerId,
        reviewerSubjectCode: "HEADQUARTERS_FINANCE",
        reviewerScopeType: "GLOBAL",
        reviewerContextRegionId: null,
        reviewerContextCampusId: null,
        reviewerContextVenueId: null,
        submissionDocumentVersion: 2,
        submissionSnapshot: applicantSnapshot
      };
      await client.query(
        `INSERT INTO finance_reimbursement_decision(
           finance_document_id,source_document_version,result_document_version,decision,reason,decided_by_person_id,
           actor_subject_code,actor_scope_type,authorization_snapshot,decided_at,created_at
         ) VALUES($1::uuid,2,3,$2,$3,$4::uuid,'HEADQUARTERS_FINANCE','GLOBAL',$5::jsonb,$6::timestamptz,$6::timestamptz)`,
        [documentId, status, decisionReason, reviewerId, JSON.stringify(authorization), decidedAt.toISOString()]
      );
      await client.query(
        `INSERT INTO finance_document_event(finance_document_id,event_type,actor_person_id,result_document_version,created_at)
         VALUES($1::uuid,$2,$3::uuid,3,$4::timestamptz)`,
        [documentId, eventType, reviewerId, decidedAt.toISOString()]
      );
    }
    await client.query("COMMIT");
    return { documentId, attachmentVersions, applicantSnapshot };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

test("普通报销读取仅开放本人当前财年和严格全局管理，并对申请、决定和附件损坏关闭失败", async () => {
  const db = await createTestDatabase(process.env.DATABASE_URL);
  const { pool } = db;
  const [teacherId, plannerId, mentorId, otherId, hqId, adminId, ownerId] = Array.from({ length: 7 }, () => randomUUID());
  try {
    for (const [id, label] of [[teacherId, "teacher"], [plannerId, "planner"], [mentorId, "mentor"], [otherId, "other"],
      [hqId, "hq"], [adminId, "admin"], [ownerId, "owner"]]) await insertPerson(pool, id, label);
    const teacherAccountId = await insertPersonAccount(pool, teacherId);
    const plannerAccountId = await insertPersonAccount(pool, plannerId);
    const mentorAccountId = await insertPersonAccount(pool, mentorId);
    await insertPersonAccount(pool, otherId);
    await pool.query(
      `INSERT INTO role_assignment(person_id,subject_code,scope_type,scope_id,valid_from,created_by)
       VALUES($1::uuid,'HEADQUARTERS_FINANCE','GLOBAL',NULL,'2026-01-01',$2::uuid)`,
      [hqId, adminId]
    );

    const teacherContext = personal(teacherId);
    const plannerContext = personal(plannerId, "ACADEMIC_PLANNER", "CAMPUS", { campusId: randomUUID() });
    const mentorContext = personal(mentorId, "PLANNING_MENTOR", "ASSOCIATED_TEACHERS");
    const pending = await seedReimbursement(pool, {
      applicantId: teacherId, destinationAccountId: teacherAccountId, applicantContext: teacherContext,
      submittedAt: at, status: "PENDING_APPROVAL", reason: "教师普通报销", reviewerId: hqId
    });
    const approvedAt = new Date("2026-09-22T04:00:00.000Z");
    const approved = await seedReimbursement(pool, {
      applicantId: plannerId, destinationAccountId: plannerAccountId, applicantContext: plannerContext,
      submittedAt: approvedAt, status: "APPROVED", reason: "规划师普通报销", reviewerId: hqId, decisionReason: "单据真实，批准"
    });
    const rejected = await seedReimbursement(pool, {
      applicantId: mentorId, destinationAccountId: mentorAccountId, applicantContext: mentorContext,
      submittedAt: new Date("2026-09-23T04:00:00.000Z"), status: "REJECTED", reason: "导师普通报销",
      reviewerId: hqId, decisionReason: "用途不符合报销范围"
    });
    const old = await seedReimbursement(pool, {
      applicantId: teacherId, destinationAccountId: teacherAccountId, applicantContext: teacherContext,
      submittedAt: new Date("2026-08-31T15:59:59.999Z"), status: "APPROVED", reason: "旧财年普通报销",
      reviewerId: hqId, decisionReason: "旧财年批准"
    });

    const reads = new PostgresReimbursementReadService(pool);
    assert.deepEqual(await reads.listOwn(teacherContext, at), { documents: [{
      id: pending.documentId, status: "PENDING_APPROVAL", version: 2, amountCents: "12345", reason: "教师普通报销",
      applicantPersonId: teacherId, applicantDisplayName: `reimbursement-teacher-${teacherId}`, submittedAt: at.toISOString()
    }] });
    assert.equal((await reads.listOwn(plannerContext, at)).documents[0].id, approved.documentId);
    assert.equal((await reads.listOwn(mentorContext, at)).documents[0].id, rejected.documentId);
    assert.deepEqual(await reads.listOwn(personal(otherId), at), { documents: [] });
    await assert.rejects(reads.listOwn(managed(hqId), at), /FORBIDDEN_SCOPE/);

    for (const context of [managed(hqId), managed(adminId, "SYSTEM_ADMIN"), managed(ownerId, "SYSTEM_OWNER")]) {
      const documents = (await reads.listManaged(context)).documents;
      assert.equal(documents.length, 4);
      assert.ok(documents.some((document) => document.id === old.documentId), "全局管理保留旧财年记录");
    }
    await assert.rejects(reads.listManaged(managed(hqId, "HEADQUARTERS_FINANCE", { regionId: randomUUID() })), /FORBIDDEN_SCOPE/);
    await assert.rejects(reads.listManaged({ personId: hqId, subject: "HEADQUARTERS_FINANCE", scope: "REGION", regionId: randomUUID() }), /FORBIDDEN_SCOPE/);

    const pendingDetail = await reads.getDetail(teacherContext, pending.documentId, at);
    assert.equal(pendingDetail.attachments.length, 3);
    assert.equal(pendingDetail.decision, undefined);
    assert.equal(pendingDetail.management, undefined);
    assert.deepEqual(pendingDetail.attachments.map((attachment) => attachment.purpose).sort(),
      ["APPLICATION_SCREENSHOT", "INVOICE", "SUPPORTING_DOCUMENT"]);
    const approvedOwn = await reads.getDetail(plannerContext, approved.documentId, at);
    assert.deepEqual(approvedOwn.decision, {
      decision: "APPROVED", reason: "单据真实，批准", decidedAt: new Date(approvedAt.getTime() + 60_000).toISOString()
    });
    assert.equal(approvedOwn.management, undefined);
    const approvedManaged = await reads.getDetail(managed(hqId), approved.documentId, at);
    assert.deepEqual(approvedManaged.management, {
      destinationAccountId: plannerAccountId, submittedByPersonId: plannerId,
      applicantContextSubject: "ACADEMIC_PLANNER", applicantContextScope: "CAMPUS",
      applicantContextCampusId: plannerContext.campusId,
      decidedByPersonId: hqId, decisionActorSubject: "HEADQUARTERS_FINANCE", decisionActorScope: "GLOBAL"
    });
    assert.deepEqual((await reads.getDetail(mentorContext, rejected.documentId, at)).decision, {
      decision: "REJECTED", reason: "用途不符合报销范围", decidedAt: new Date("2026-09-23T04:01:00.000Z").toISOString()
    });
    await assert.rejects(reads.getDetail(personal(otherId), pending.documentId, at), /FINANCE_DOCUMENT_NOT_FOUND/);
    await assert.rejects(reads.getDetail(teacherContext, old.documentId, at), /FINANCE_DOCUMENT_NOT_FOUND/);
    assert.equal((await reads.getDetail(managed(adminId, "SYSTEM_ADMIN"), old.documentId, at)).id, old.documentId);

    const balances = await pool.query(
      "SELECT account_id::text AS id,balance_cents::text AS balance FROM account_balance_projection WHERE account_id=ANY($1::uuid[]) ORDER BY account_id",
      [[teacherAccountId, plannerAccountId, mentorAccountId]]
    );
    assert.deepEqual([...new Set(balances.rows.map((row) => row.balance))], ["777"], "申请和人工审核均不得改变余额");
    assert.equal((await pool.query("SELECT count(*)::text AS count FROM ledger_event WHERE event_key LIKE 'reimbursement:%'")).rows[0].count, "0");

    await assert.rejects(
      pool.query("UPDATE finance_reimbursement_submission SET amount_cents=1 WHERE finance_document_id=$1::uuid", [pending.documentId]),
      /FINANCE_REIMBURSEMENT_IMMUTABLE/
    );
    await assert.rejects(
      pool.query("UPDATE finance_reimbursement_decision SET reason='篡改' WHERE finance_document_id=$1::uuid", [approved.documentId]),
      /FINANCE_REIMBURSEMENT_IMMUTABLE/
    );

    await pool.query("ALTER TABLE finance_reimbursement_decision DISABLE TRIGGER USER");
    const originalAuthorization = (await pool.query(
      "SELECT authorization_snapshot FROM finance_reimbursement_decision WHERE finance_document_id=$1::uuid", [approved.documentId]
    )).rows[0].authorization_snapshot;
    await pool.query(
      `UPDATE finance_reimbursement_decision
          SET authorization_snapshot=jsonb_set(authorization_snapshot,'{reviewerSubjectCode}','\"SYSTEM_ADMIN\"'::jsonb,true)
        WHERE finance_document_id=$1::uuid`, [approved.documentId]
    );
    await assert.rejects(reads.getDetail(managed(hqId), approved.documentId, at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await assert.rejects(reads.listManaged(managed(hqId)), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await pool.query(
      "UPDATE finance_reimbursement_decision SET authorization_snapshot=$2::jsonb WHERE finance_document_id=$1::uuid",
      [approved.documentId, JSON.stringify(originalAuthorization)]
    );
    await pool.query("ALTER TABLE finance_reimbursement_decision ENABLE TRIGGER USER");

    const screenshotVersion = pending.attachmentVersions.find((attachment) => attachment.purpose === "APPLICATION_SCREENSHOT").versionId;
    await pool.query("ALTER TABLE finance_reimbursement_attachment_binding DISABLE TRIGGER USER");
    await pool.query(
      "UPDATE finance_reimbursement_attachment_binding SET document_version=99 WHERE finance_attachment_version_id=$1::uuid", [screenshotVersion]
    );
    await assert.rejects(reads.getDetail(teacherContext, pending.documentId, at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await assert.rejects(reads.listOwn(teacherContext, at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await pool.query(
      "UPDATE finance_reimbursement_attachment_binding SET document_version=2 WHERE finance_attachment_version_id=$1::uuid", [screenshotVersion]
    );
    await pool.query("ALTER TABLE finance_reimbursement_attachment_binding ENABLE TRIGGER USER");

    await pool.query("ALTER TABLE finance_document DISABLE TRIGGER USER");
    await pool.query("UPDATE finance_document SET version=77 WHERE id=$1::uuid", [pending.documentId]);
    await assert.rejects(reads.getDetail(teacherContext, pending.documentId, at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await assert.rejects(reads.listOwn(teacherContext, at), /FINANCE_REIMBURSEMENT_DATA_UNAVAILABLE/);
    await pool.query("UPDATE finance_document SET version=2 WHERE id=$1::uuid", [pending.documentId]);
    await pool.query("ALTER TABLE finance_document ENABLE TRIGGER USER");

    const audits = await pool.query(
      "SELECT action_code,reason FROM audit_event WHERE subject_type='FINANCE_REIMBURSEMENT' ORDER BY created_at,action_code"
    );
    assert.ok(audits.rows.some((event) => event.action_code === "REIMBURSEMENT_DETAIL_READ"));
    assert.ok(audits.rows.some((event) => event.action_code === "REIMBURSEMENT_DETAIL_DENIED" && event.reason === "NOT_FOUND_OR_FORBIDDEN"));
    assert.ok(audits.rows.some((event) => event.action_code === "REIMBURSEMENT_DETAIL_INTEGRITY_FAILED"));
  } finally {
    await db.close();
  }
});
