import type { RoleContext } from "@teaching-research-alliance/contracts";
import type { PostgresClient, PostgresPool } from "./postgres-ledger-repository.js";
import { FinanceSensitiveFieldCrypto } from "./finance-sensitive-field-crypto.js";
import { financeYearBounds } from "./finance-year.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const personal=(context:RoleContext):boolean=>["TEACHER","TEACHING_TEACHER","ACADEMIC_PLANNER","PLANNING_MENTOR"].includes(context.subject)
  && ["SELF","REGION","CAMPUS","ASSOCIATED_TEACHERS","MENTEES","VENUE","GLOBAL"].includes(context.scope??"");
const globalReader=(context:RoleContext):boolean=>["HEADQUARTERS_FINANCE","SYSTEM_ADMIN","SYSTEM_OWNER"].includes(context.subject)
  && context.scope==="GLOBAL" && context.regionId===undefined && context.campusId===undefined && context.venueId===undefined;
type SummaryRow={id:string;applicant_person_id:string;applicant_name:string;status:string;version:string;amount_cents:string;
  source_account_id:string;source_owner_type:string;source_owner_id:string;venue_name:string|null;bank_account_last4:string;submitted_at:string};
type DetailRow=SummaryRow & {recipient_key_id:string;recipient_nonce:string;recipient_ciphertext:string;recipient_auth_tag:string};
const summaryColumns=`document.id::text AS id,document.applicant_person_id::text AS applicant_person_id,
 person.nickname AS applicant_name,document.status,document.version::text AS version,submission.amount_cents::text AS amount_cents,
 submission.source_account_id::text AS source_account_id,submission.source_owner_type,submission.source_owner_id::text AS source_owner_id,
 venue.name AS venue_name,submission.bank_account_last4,
 to_char(submission.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at`;
const fromTables=`FROM finance_document document
 JOIN finance_withdrawal_submission submission ON submission.finance_document_id=document.id
 JOIN person ON person.id=document.applicant_person_id
 LEFT JOIN venue ON submission.source_owner_type='VENUE' AND venue.id=submission.source_owner_id`;
const mapSummary=(row:SummaryRow)=>{
  if(![row.id,row.applicant_person_id,row.source_account_id,row.source_owner_id].every(id=>UUID.test(id))
    ||!Number.isSafeInteger(Number(row.version))||Number(row.version)<1
    ||!['PENDING_TRANSFER','TRANSFERRED','FINANCE_REVOKED'].includes(row.status)
    ||!['PERSON','VENUE'].includes(row.source_owner_type)||!/^[1-9][0-9]*$/.test(row.amount_cents)
    ||!Number.isFinite(new Date(row.submitted_at).getTime())||typeof row.bank_account_last4!=='string'
    ||row.bank_account_last4.length>4||/[\x00-\x1f\x7f]/.test(row.bank_account_last4)
    ||(row.source_owner_type==='VENUE'&&row.venue_name===null))throw new Error('FINANCE_WITHDRAWAL_DATA_UNAVAILABLE');
  return {id:row.id,applicantPersonId:row.applicant_person_id,applicantName:row.applicant_name,
  status:row.status,version:Number(row.version),amountCents:row.amount_cents,sourceAccountId:row.source_account_id,
  sourceType:row.source_owner_type,...(row.source_owner_type==='VENUE'?{venueId:row.source_owner_id,venueName:row.venue_name}:{}),
  bankAccountLast4:row.bank_account_last4,submittedAt:row.submitted_at};
};

export class PostgresWithdrawalReadService {
  public constructor(private readonly pool:PostgresPool,private readonly crypto:FinanceSensitiveFieldCrypto){}

  public async listSources(context:RoleContext,at:Date){
    if(!personal(context))throw new Error("FORBIDDEN_SCOPE");
    if(!Number.isFinite(at.getTime()))throw new Error("INVALID_INPUT");
    const client=await this.pool.connect();
    try{
      const result=await client.query<{id:string;owner_type:string;owner_id:string;label:string;balance_cents:string}>(
        `SELECT account.id::text AS id,account.owner_type,account.owner_id::text AS owner_id,
          CASE WHEN account.owner_type='PERSON' THEN person.nickname ELSE venue.name END AS label,
          COALESCE(balance.balance_cents,0)::text AS balance_cents
         FROM settlement_account account
         LEFT JOIN person ON account.owner_type='PERSON' AND person.id=account.owner_id
         LEFT JOIN venue ON account.owner_type='VENUE' AND venue.id=account.owner_id
         LEFT JOIN account_balance_projection balance ON balance.account_id=account.id
         WHERE account.status='ACTIVE' AND (
           (account.owner_type='PERSON' AND account.owner_id=$1::uuid) OR
           (account.owner_type='VENUE' AND (venue.owner_person_id=$1::uuid OR EXISTS(
             SELECT 1 FROM venue_permission_grant permission WHERE permission.venue_id=venue.id
               AND permission.grantee_person_id=$1::uuid AND permission.can_withdraw
               AND permission.valid_from<=$2::timestamptz AND (permission.valid_to IS NULL OR $2::timestamptz<permission.valid_to)
           )))) ORDER BY account.owner_type,account.id`,[context.personId,at.toISOString()]);
      return result.rows.map(row=>({accountId:row.id,sourceType:row.owner_type,label:row.label,balanceCents:row.balance_cents,
        ...(row.owner_type==='VENUE'?{venueId:row.owner_id}:{})}));
    }finally{await client.release();}
  }

  public async listOwn(context:RoleContext,at:Date){
    if(!personal(context))throw new Error("FORBIDDEN_SCOPE");
    const bounds=financeYearBounds(at);
    return this.list(`document.applicant_person_id=$1::uuid AND submission.submitted_at>=$2::timestamptz AND submission.submitted_at<$3::timestamptz`,[context.personId,bounds.start,bounds.end]);
  }
  public async listPending(context:RoleContext){
    if(!globalReader(context)||context.subject!=="HEADQUARTERS_FINANCE")throw new Error("FORBIDDEN_SCOPE");
    return this.list(`document.status='PENDING_TRANSFER'`,[]);
  }
  public async listManaged(context:RoleContext){
    if(!globalReader(context))throw new Error("FORBIDDEN_SCOPE");
    return this.list("true",[]);
  }
  private async list(condition:string,parameters:readonly unknown[]){
    const client=await this.pool.connect();
    try{return (await client.query<SummaryRow>(`SELECT ${summaryColumns} ${fromTables}
      WHERE document.kind='WITHDRAWAL' AND ${condition} ORDER BY submission.submitted_at,document.id`,parameters)).rows.map(mapSummary);
    }finally{await client.release();}
  }

  public async getDetail(context:RoleContext,documentId:string,at:Date){
    if(!UUID.test(documentId)||!Number.isFinite(at.getTime()))throw new Error("INVALID_INPUT");
    const client=await this.pool.connect();let open=false;
    try{
      await client.query("BEGIN");open=true;
      const audit=async(action:string,reason:string)=>client.query(
        `INSERT INTO audit_event(actor_person_id,action_code,subject_type,subject_id,after_json,reason,created_at)
         VALUES($1::uuid,$2,'FINANCE_WITHDRAWAL',$3::uuid,jsonb_build_object('contextSubject',$4::text),$5,$6::timestamptz)`,
        [context.personId,action,documentId,context.subject,reason,at.toISOString()]);
      const fail=async(code:string,reason:string):Promise<never>=>{
        await audit(code.endsWith('_UNAVAILABLE')?"WITHDRAWAL_DETAIL_INTEGRITY_FAILED":"WITHDRAWAL_DETAIL_DENIED",reason);
        await client.query("COMMIT");open=false;throw new Error(code);
      };
      if(!personal(context)&&!globalReader(context))return await fail("FORBIDDEN_SCOPE","FORBIDDEN_SCOPE");
      const bounds=financeYearBounds(at);
      const result=await client.query<DetailRow>(`SELECT ${summaryColumns},submission.recipient_key_id,
        submission.recipient_nonce,submission.recipient_ciphertext,submission.recipient_auth_tag ${fromTables}
        WHERE document.id=$1::uuid AND document.kind='WITHDRAWAL'
          AND ($2::boolean OR (document.applicant_person_id=$3::uuid AND submission.submitted_at>=$4::timestamptz
            AND submission.submitted_at<$5::timestamptz)) FOR SHARE OF document`,[documentId,globalReader(context),context.personId,bounds.start,bounds.end]);
      const row=result.rows[0];
      if(!row)return await fail("FINANCE_DOCUMENT_NOT_FOUND","NOT_FOUND_OR_FORBIDDEN");
      let recipient;
      try{recipient=this.crypto.decrypt({keyId:row.recipient_key_id,nonce:row.recipient_nonce,ciphertext:row.recipient_ciphertext,
        authTag:row.recipient_auth_tag,bankAccountLast4:row.bank_account_last4},
        {documentId:row.id,applicantPersonId:row.applicant_person_id,sourceAccountId:row.source_account_id,amountCents:row.amount_cents});
      }catch{return await fail("FINANCE_RECIPIENT_UNAVAILABLE","RECIPIENT_DECRYPTION_FAILED");}
      let summary,attachments;
      try{summary=mapSummary(row);attachments=await this.boundAttachments(client,row.id,row.status);}
      catch(error){
        if(error instanceof Error&&error.message==='FINANCE_WITHDRAWAL_DATA_UNAVAILABLE')return await fail(error.message,'WITHDRAWAL_DATA_INVALID');
        throw error;
      }
      await audit("WITHDRAWAL_DETAIL_READ","AUTHORIZED_RECIPIENT_READ");
      await client.query("COMMIT");open=false;
      return {...summary,recipient,attachments};
    }catch(error){if(open)await client.query("ROLLBACK");throw error;}
    finally{await client.release();}
  }
  private async boundAttachments(client:PostgresClient,documentId:string,status:string){
    const result=await client.query<{stage:string;purpose:string;actual_purpose:string;status:string;version_id:string;original_filename:string;media_type:string|null;size_bytes:string|null;sha256:string|null}>(
      `SELECT binding.stage,binding.purpose,attachment.purpose AS actual_purpose,version.status,version.id::text AS version_id,version.original_filename,
        version.detected_media_type AS media_type,version.actual_size_bytes::text AS size_bytes,version.sha256
       FROM finance_withdrawal_attachment_binding binding
       JOIN finance_attachment_version version ON version.id=binding.finance_attachment_version_id
       JOIN finance_attachment attachment ON attachment.id=version.finance_attachment_id
       WHERE binding.finance_document_id=$1::uuid ORDER BY binding.stage,binding.purpose,version.id`,[documentId]);
    if(['SUPPORTING_DOCUMENT','APPLICATION_SCREENSHOT'].some(purpose=>!result.rows.some(row=>row.stage==='SUBMISSION'&&row.purpose===purpose))
      ||(status==='TRANSFERRED'&&!result.rows.some(row=>row.stage==='COMPLETION'&&row.purpose==='PAYMENT_RECEIPT')))
      throw new Error('FINANCE_WITHDRAWAL_DATA_UNAVAILABLE');
    return result.rows.map(row=>{
      if(row.status!=='READY'||row.actual_purpose!==row.purpose||!row.media_type||!['application/pdf','image/png','image/jpeg'].includes(row.media_type)
        ||row.size_bytes===null||!Number.isSafeInteger(Number(row.size_bytes))||Number(row.size_bytes)<1
        ||!row.sha256||!/^[0-9a-f]{64}$/.test(row.sha256))throw new Error('FINANCE_WITHDRAWAL_DATA_UNAVAILABLE');
      return {stage:row.stage,purpose:row.purpose,versionId:row.version_id,originalFilename:row.original_filename,
        mediaType:row.media_type,sizeBytes:Number(row.size_bytes),sha256:row.sha256};
    });
  }
}
