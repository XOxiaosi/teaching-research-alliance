import test from 'node:test';
import assert from 'node:assert/strict';
import { TeacherApiClient, ApiClientError } from '../dist/index.js';
import { hasPermission, permissionScope, ENDPOINT_CONTRACTS } from '@teaching-research-alliance/contracts';

test('组织营收契约按总部、分区和校区授权，不扩基础或导师身份', () => {
  for (const [subject, scope] of [['SYSTEM_OWNER','GLOBAL'], ['SYSTEM_ADMIN','GLOBAL'], ['HEADQUARTERS_FINANCE','GLOBAL'], ['REGION_FINANCE','REGION'], ['CAMPUS_PRINCIPAL','CAMPUS']]) assert.equal(permissionScope(subject, 'VIEW_ORGANIZATION_REVENUE'), scope);
  for (const subject of ['TEACHING_TEACHER','ACADEMIC_PLANNER','PLANNING_MENTOR','TEACHING_MENTOR','GROUP_LEADER','VENUE_OWNER']) assert.equal(hasPermission(subject, 'VIEW_ORGANIZATION_REVENUE'), false);
  assert.equal(ENDPOINT_CONTRACTS.find(item => item.path === '/v1/organizations/revenue').requiresRoleContext, true);
});

test('组织营收客户端校验月份并仅传期间，服务端撤权清理当前角色', async () => {
  const calls = [];
  let denied = false;
  const context = { personId: 'reader', subject: 'REGION_FINANCE', scope: 'REGION', regionId: 'region' };
  const client = new TeacherApiClient({ transport: async request => {
    calls.push(request);
    if (request.path === '/v1/session') return { status: 200, body: { data: { sessionId: 'session', personId: 'reader', accountId: 'login', roleContexts: [context], currentRoleContext: context } } };
    return denied ? { status: 403, body: { error: { code: 'FORBIDDEN_SCOPE', message: 'FORBIDDEN_SCOPE' } } } : { status: 200, body: { data: { total: { effectiveGrossRevenueCents: '9007199254740993' } } } };
  } });
  await client.login({ phoneNormalized: '13800000000', password: 'password' });
  const range = { fromMonth: '2026-01-01', toMonth: '2026-09-01' };
  assert.equal((await client.getOrganizationRevenue(range)).total.effectiveGrossRevenueCents, '9007199254740993');
  assert.equal(calls[1].path, '/v1/organizations/revenue?fromMonth=2026-01-01&toMonth=2026-09-01');
  for (const filter of [{ ...range, fromMonth: '2026-13-01' }, { ...range, toMonth: '2025-09-01' }, { ...range, fromMonth: '2026-01-02' }]) await assert.rejects(client.getOrganizationRevenue(filter), error => error instanceof ApiClientError && error.code === 'INVALID_INPUT');
  assert.equal(calls.length, 2);
  denied = true;
  await assert.rejects(client.getOrganizationRevenue(range), error => error.code === 'FORBIDDEN_SCOPE');
  assert.equal(client.hasRoleContext, false);
});
