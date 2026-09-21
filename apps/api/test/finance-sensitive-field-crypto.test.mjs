import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FinanceSensitiveFieldCrypto } from '../dist/finance-sensitive-field-crypto.js';

const context={documentId:'document-a',applicantPersonId:'person-a',sourceAccountId:'account-a',amountCents:'60000'};
const recipient={recipientName:'合成老师',bankAccount:' 0012 3400 ',bankName:'合成银行'};
test('收款快照保留原始文本，随机加密且绑定单据、账户与金额',()=>{
  const crypto=new FinanceSensitiveFieldCrypto('test',{test:randomBytes(32).toString('hex')});
  const first=crypto.encrypt(recipient,context),second=crypto.encrypt(recipient,context);
  assert.notEqual(first.ciphertext,second.ciphertext);
  assert.deepEqual(crypto.decrypt(first,context),recipient);
  assert.equal(first.bankAccountLast4,'400 ');
  for(const field of Object.keys(context))assert.throws(()=>crypto.decrypt(first,{...context,[field]:'other'}),/FINANCE_RECIPIENT_INTEGRITY_FAILED/);
  for(const field of ['nonce','authTag','ciphertext']){
    const corrupt={...first,[field]:(first[field][0]==='0'?'1':'0')+first[field].slice(1)};
    assert.throws(()=>crypto.decrypt(corrupt,context),/FINANCE_RECIPIENT_INTEGRITY_FAILED/);
  }
  assert.throws(()=>crypto.decrypt({...first,bankAccountLast4:'9999'},context),/FINANCE_RECIPIENT_INTEGRITY_FAILED/);
  assert.ok(!JSON.stringify(first).includes(recipient.bankAccount));
});
test('轮换密钥后可读历史并重算历史请求HMAC，缺密钥明确失败',()=>{
  const old=randomBytes(32).toString('hex'),next=randomBytes(32).toString('hex');
  const before=new FinanceSensitiveFieldCrypto('old',{old});
  const after=new FinanceSensitiveFieldCrypto('next',{old,next});
  const encrypted=before.encrypt(recipient,context);
  assert.deepEqual(after.decrypt(encrypted,context),recipient);
  assert.equal(after.requestHmac('fixed-request','old'),before.requestHmac('fixed-request'));
  assert.notEqual(after.requestHmac('fixed-request'),before.requestHmac('fixed-request'));
  assert.notEqual(before.requestHmac('changed-request'),before.requestHmac('fixed-request'));
  assert.throws(()=>new FinanceSensitiveFieldCrypto('next',{next}).decrypt(encrypted,context),/FINANCE_KEY_UNAVAILABLE/);
  assert.throws(()=>new FinanceSensitiveFieldCrypto('missing',{old}),/FINANCE_KEY_CONFIG_INVALID/);
});
test('拒绝空白或控制字符收款资料，不把银行卡当数字',()=>{
  const crypto=new FinanceSensitiveFieldCrypto('test',{test:randomBytes(32).toString('hex')});
  for(const bankAccount of ['', ' ', '123\n456', 123456])assert.throws(()=>crypto.encrypt({...recipient,bankAccount},context),/INVALID_INPUT/);
  const withoutBank={recipientName:'合成老师',bankAccount:'0000001'};
  assert.deepEqual(crypto.decrypt(crypto.encrypt(withoutBank,context),context),withoutBank);
});
