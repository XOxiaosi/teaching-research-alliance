import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {EXPORT_SCHEMA_REGISTRY} from '../dist/export-schema-registry.js';
import {FullBackupTransformer} from '../dist/full-backup-transformer.js';
import {FinanceSensitiveFieldCrypto} from '../../../packages/domain/dist/index.js';
import {createBackupCryptoAdapters} from '../dist/full-backup-crypto.js';
import {validateJsonTransform} from '../dist/full-backup-transform-schemas.js';
const fingerprint=({domain,value})=>createHmac('sha256',Buffer.alloc(32,7)).update(JSON.stringify([domain,value])).digest('hex');
test('unrecognized nested JSON cannot pass as a business anomaly',()=>{
 for(const [tableName,columnName,value] of [
  ['finance_refund_decision','authorization_snapshot',{submissionSnapshot:{password_hash:'synthetic-secret'}}],
  ['weekly_fee_allocation_snapshot','context_json',{relationships:{groupLeader:{token:'synthetic-secret'}}}],
  ['weekly_fee_allocation_snapshot','snapshot_json',{lines:[],accountByKey:{teacher:{token:'synthetic-secret'}}}],
 ]) assert.throws(()=>validateJsonTransform({tableName,columnName,raw:JSON.stringify(value),row:{}}),{message:'EXPORT_TRANSFORM_SCHEMA_GAP'});
});
test('account audit JSON rejects password material and discriminator mismatches',()=>{
 const secrets=['password','passwordHash','password_hash'];
 for(const secret of secrets){
  assert.throws(()=>validateJsonTransform({tableName:'audit_event',columnName:'after_json',raw:JSON.stringify({baseSubject:'TEACHER',scope:'SELF',[secret]:'synthetic-secret'}),row:{subject_type:'USER_ACCOUNT',action_code:'ACCOUNT_REGISTERED'}}),{message:'EXPORT_TRANSFORM_SCHEMA_GAP'});
  for(const columnName of ['before_json','after_json'])assert.throws(()=>validateJsonTransform({tableName:'audit_event',columnName,raw:JSON.stringify({authVersion:'2',[secret]:'synthetic-secret'}),row:{subject_type:'USER_ACCOUNT',action_code:'ACCOUNT_PASSWORD_RESET'}}),{message:'EXPORT_TRANSFORM_SCHEMA_GAP'});
 }
 assert.throws(()=>validateJsonTransform({tableName:'audit_event',columnName:'after_json',raw:JSON.stringify({authVersion:{password:'synthetic-secret'}}),row:{subject_type:'USER_ACCOUNT',action_code:'ACCOUNT_PASSWORD_RESET'}}),{message:'EXPORT_TRANSFORM_SCHEMA_GAP'});
 for(const row of [{subject_type:'PERSON',action_code:'ACCOUNT_REGISTERED'},{subject_type:'USER_ACCOUNT',action_code:'FUTURE_ACCOUNT_ACTION'}])assert.throws(()=>validateJsonTransform({tableName:'audit_event',columnName:'after_json',raw:JSON.stringify({baseSubject:'TEACHER',scope:'SELF'}),row}),{message:'EXPORT_TRANSFORM_SCHEMA_GAP'});
});
function input(tableName,exportOverrides={},transformOverrides={}){const table=EXPORT_SCHEMA_REGISTRY.find(t=>t.name===tableName);return {tableName,exportValues:Object.fromEntries(table.columns.filter(c=>c.disposition==='EXPORT').map(c=>[c.name,exportOverrides[c.name]??null])),transformValues:new Map(table.columns.filter(c=>c.disposition==='TRANSFORM').map(c=>[c.name,transformOverrides[c.name]??null]))};}
test('real recipient cryptography preserves business fields and rejects altered AAD or ciphertext without leaking values',async()=>{const crypto=new FinanceSensitiveFieldCrypto('synthetic',{synthetic:'a1'.repeat(32)});const aad={documentId:randomUUID(),applicantPersonId:randomUUID(),sourceAccountId:randomUUID(),amountCents:'12345'};const recipient={recipientName:'合成收款人',bankAccount:'001234567890123456',bankName:'合成银行'};const envelope=crypto.encrypt(recipient,aad);const row=input('finance_withdrawal_submission',{authorization_kind:"PERSON_OWNER",finance_document_id:aad.documentId,source_account_id:aad.sourceAccountId,amount_cents:aad.amountCents,bank_account_last4:envelope.bankAccountLast4},{authorization_snapshot:JSON.stringify({authorizationKind:"PERSON_OWNER",sourceAccountId:aad.sourceAccountId,personId:aad.applicantPersonId}),recipient_key_id:envelope.keyId,recipient_nonce:envelope.nonce,recipient_ciphertext:envelope.ciphertext,recipient_auth_tag:envelope.authTag});row.context={withdrawalRecipient:{applicantPersonId:aad.applicantPersonId}};const transformer=new FullBackupTransformer(createBackupCryptoAdapters(crypto));const result=await transformer.transformRow(row);assert.equal(result.values.recipient_name,recipient.recipientName);assert.equal(result.values.bank_account,recipient.bankAccount);assert.equal(result.values.bank_name,recipient.bankName);for(const key of ['recipient_key_id','recipient_nonce','recipient_ciphertext','recipient_auth_tag'])assert.equal(result.values[key],undefined);
 for(const changed of [{...row,context:{withdrawalRecipient:{applicantPersonId:randomUUID()}}},{...row,transformValues:new Map([...row.transformValues].map(([k,v])=>[k,k==='recipient_ciphertext'?'00'.repeat(16):v]))}])await assert.rejects(transformer.transformRow(changed),error=>{assert.equal(error.message,'EXPORT_RECIPIENT_DECRYPT_FAILED');assert.equal(error.message.includes(recipient.bankAccount),false);return true;});
});
test('weekly settlement event key cannot reintroduce a raw command key through ledger exports',async()=>{const raw='synthetic-user-command-secret';const eventKey=`weekly-settlement:${raw}`;const row=input('ledger_event',{id:randomUUID(),event_type:'WEEKLY_FEE_SETTLEMENT',payload_hash:'hash',created_at:'2026-09-23T00:00:00Z'},{event_key:eventKey});const transformer=new FullBackupTransformer({fingerprint});const result=await transformer.transformRow(row);assert.equal(result.values.event_key,undefined);assert.equal(result.values.event_key_fingerprint,fingerprint({domain:'full-backup-transform.v1:ledger_event:event_key',value:eventKey}));assert.equal(JSON.stringify(result).includes(raw),false);
 await assert.rejects(transformer.transformRow({...row,exportValues:{...row.exportValues,password_hash:'secret'}}),{message:'EXPORT_TRANSFORM_SCHEMA_GAP'});
 const unknown=input('finance_document_event',{event_type:'FUTURE_EVENT'},{details_json:null});await assert.rejects(transformer.transformRow(unknown),{message:'EXPORT_TRANSFORM_SCHEMA_GAP'});
});
