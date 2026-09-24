import test from 'node:test';
import assert from 'node:assert/strict';
import {TeacherApiClient} from '../dist/index.js';

const globalContext = {
  personId: 'finance-person',
  subject: 'HEADQUARTERS_FINANCE',
  scope: 'GLOBAL',
};

const supportingDocument = {
  versionId: 'attachment-supporting',
  purpose: 'SUPPORTING_DOCUMENT',
  originalFilename: 'invoice.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 900719925,
  sha256: 'a'.repeat(64),
};
const applicationScreenshot = {
  versionId: 'attachment-screenshot',
  purpose: 'APPLICATION_SCREENSHOT',
  originalFilename: 'application.png',
  mediaType: 'image/png',
  sizeBytes: 1024,
  sha256: 'b'.repeat(64),
};
const completedPosting = {
  documentId: 'bonus-completed',
  status: 'COMPLETED',
  version: 2,
  projectNo: 3,
  projectName: '历史项目名称',
  amountCents: '9007199254740993',
  reason: '项目奖金',
  grantedAt: '2026-09-23T10:00:00.123456Z',
  grantedByPersonId: 'grantor',
  grantedByCurrentDisplayName: '当前发放人',
  recipient: {
    personId: 'recipient',
    currentDisplayName: null,
    accountId: 'recipient-account',
    accountCode: 'PERSON-recipient',
  },
  source: {
    fundId: 'fund',
    currentFundCode: 'FUND-01',
    currentDisplayName: '当前基金名',
    accountId: 'fund-account',
    accountCode: 'COMPANY-fund',
  },
  reversal: null,
  canReverse: true,
};
const reversedPosting = {
  ...completedPosting,
  documentId: 'bonus-reversed',
  status: 'REVERSED',
  version: 3,
  grantedByCurrentDisplayName: null,
  reversal: {
    documentId: 'reversal-document',
    version: 2,
    reason: '更正原因',
    reversedAt: '2026-09-23T11:00:00.654321Z',
    reversedByPersonId: 'reverser',
    reversedByCurrentDisplayName: null,
  },
  canReverse: false,
};
const reversedDetail = {
  ...reversedPosting,
  reversal: {
    ...reversedPosting.reversal,
    attachments: [applicationScreenshot, supportingDocument],
  },
  originalAttachments: [supportingDocument, applicationScreenshot],
};

async function setup(context = globalContext, status = 200) {
  const calls = [];
  const client = new TeacherApiClient({
    transport: async (request) => {
      calls.push(request);
      if (request.path === '/v1/session') {
        return {
          status: 200,
          body: {
            data: {
              sessionId: 'session',
              accountId: 'account',
              personId: 'finance-person',
              roleContexts: [context],
              currentRoleContext: context,
            },
          },
        };
      }
      if (status !== 200) {
        return {
          status,
          body: {
            error: {
              code: status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN_SCOPE',
              message: 'denied',
            },
          },
        };
      }
      return {
        status: 200,
        body: {
          data: request.path.startsWith('/v1/finance/project-bonuses/')
            ? reversedDetail
            : {items: [completedPosting, reversedPosting], nextCursor: 'next-cursor'},
        },
      };
    },
  });
  await client.login({phoneNormalized: '13800000000', password: 'password'});
  return {client, calls};
}

test('project-bonus history client preserves historical display markers, cents, and detail attachments', async () => {
  const {client, calls} = await setup();
  const page = await client.listManagedProjectBonuses({
    cursor: 'a+b /=',
    limit: 25,
  });
  const detail = await client.getManagedProjectBonusDetail('document /?');

  assert.deepEqual(page, {
    items: [completedPosting, reversedPosting],
    nextCursor: 'next-cursor',
  });
  assert.equal(page.items[0].amountCents, '9007199254740993');
  assert.equal(page.items[0].projectName, '历史项目名称');
  assert.equal(page.items[0].recipient.currentDisplayName, null);
  assert.equal(page.items[0].canReverse, true);
  assert.deepEqual(detail, reversedDetail);
  assert.deepEqual(detail.reversal.attachments, [applicationScreenshot, supportingDocument]);
  assert.deepEqual(detail.originalAttachments, [supportingDocument, applicationScreenshot]);
  assert.equal(
    calls[1].path,
    '/v1/finance/project-bonuses?cursor=a%2Bb%20%2F%3D&limit=25',
  );
  assert.equal(calls[2].path, '/v1/finance/project-bonuses/document%20%2F%3F');
});

test('project-bonus history client validates bounded list inputs before transport', async () => {
  const {client, calls} = await setup();
  for (const input of [
    {cursor: '   '},
    {cursor: 'a'.repeat(401)},
    {limit: 0},
    {limit: 101},
    {limit: 1.5},
  ]) {
    await assert.rejects(client.listManagedProjectBonuses(input));
  }
  await assert.rejects(client.getManagedProjectBonusDetail('  '));
  assert.equal(calls.length, 1);
});

test('project-bonus history client requires strict GLOBAL finance management and clears revoked contexts', async () => {
  for (const context of [
    {...globalContext, subject: 'SYSTEM_ADMIN'},
    {...globalContext, subject: 'SYSTEM_OWNER'},
  ]) {
    const {client, calls} = await setup(context);
    await client.listManagedProjectBonuses();
    await client.getManagedProjectBonusDetail('document');
    assert.equal(calls.length, 3);
  }
  for (const context of [
    {...globalContext, subject: 'TEACHING_TEACHER', scope: 'SELF'},
    {...globalContext, regionId: 'region'},
    {...globalContext, campusId: 'campus'},
    {...globalContext, venueId: 'venue'},
  ]) {
    const {client, calls} = await setup(context);
    await assert.rejects(client.listManagedProjectBonuses());
    await assert.rejects(client.getManagedProjectBonusDetail('document'));
    assert.equal(calls.length, 1);
  }
  for (const status of [401, 403]) {
    const {client} = await setup(globalContext, status);
    await assert.rejects(client.getManagedProjectBonusDetail('document'));
    if (status === 401) assert.equal(client.currentSession, null);
    else assert.equal(client.hasRoleContext, false);
  }
});
