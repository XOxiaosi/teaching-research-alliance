import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { handleRequest, createApiServer } from '../dist/main.js';

const at = new Date('2026-09-23T00:00:00Z');
const global = { personId: 'reader', subject: 'SYSTEM_ADMIN', scope: 'GLOBAL' };
const query = { fromMonth: '2026-01-01', toMonth: '2026-09-01' };
const request = { method: 'GET', path: '/v1/organizations/revenue', sessionId: 'session', body: {}, query };
const setup = (context = global) => {
  const calls = [];
  return { calls, services: {
    sessions: { get: () => ({ currentRoleContext: context }) }, weeklyFees: {}, now: () => at,
    organizationRevenue: { get: (...args) => { calls.push(args); return { total: { effectiveGrossRevenueCents: 9007199254740993n } }; } }
  } };
};

test('组织营收读取只取当前会话范围，金额序列化保持整数精度且禁止缓存', async () => {
  const { calls, services } = setup();
  const server = createApiServer(services);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/organizations/revenue?fromMonth=2026-01-01&toMonth=2026-09-01`, { headers: { authorization: 'Bearer session' } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await result.json()).data.total.effectiveGrossRevenueCents, '9007199254740993');
    assert.deepEqual(calls, [[global, query, at]]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('组织营收拒绝普通角色及附加范围，允许指定的五类职责', async () => {
  for (const context of [
    ...['TEACHING_TEACHER', 'ACADEMIC_PLANNER', 'PLANNING_MENTOR', 'GROUP_LEADER', 'TEACHING_MENTOR', 'VENUE_OWNER'].map(subject => ({ ...global, subject })),
    { ...global, regionId: 'region' },
    { ...global, subject: 'REGION_FINANCE', scope: 'REGION' },
    { ...global, subject: 'REGION_FINANCE', scope: 'REGION', regionId: 'region', campusId: 'campus' },
    { ...global, subject: 'CAMPUS_PRINCIPAL', scope: 'CAMPUS', campusId: 'campus', venueId: 'venue' }
  ]) {
    const { calls, services } = setup(context);
    assert.equal((await handleRequest(request, services)).status, 403);
    assert.equal(calls.length, 0);
  }
  for (const context of [
    ...['SYSTEM_ADMIN', 'SYSTEM_OWNER', 'HEADQUARTERS_FINANCE'].map(subject => ({ ...global, subject })),
    { ...global, subject: 'REGION_FINANCE', scope: 'REGION', regionId: 'region' },
    { ...global, subject: 'CAMPUS_PRINCIPAL', scope: 'CAMPUS', campusId: 'campus' }
  ]) assert.equal((await handleRequest(request, setup(context).services)).status, 200);
});

test('组织营收白名单拒绝伪造范围和缺参，数据故障与服务不可用明确返回', async () => {
  const { calls, services } = setup();
  for (const changed of [
    { query: { ...query, regionId: 'other' } }, { query: { fromMonth: query.fromMonth } },
    { body: { campusId: 'other' } }, { body: { scope: 'GLOBAL' } }
  ]) assert.equal((await handleRequest({ ...request, ...changed }, services)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await handleRequest({ ...request, sessionId: undefined }, services)).status, 401);
  assert.equal((await handleRequest(request, { ...services, organizationRevenue: undefined })).status, 503);
  const failed = await handleRequest(request, { ...services, organizationRevenue: { get: () => { throw new Error('ORGANIZATION_REVENUE_DATA_UNAVAILABLE'); } } });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, 'ORGANIZATION_REVENUE_DATA_UNAVAILABLE');
});
