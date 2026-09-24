import test from 'node:test';
import assert from 'node:assert/strict';
import { TeacherApiClient, ApiClientError } from '../dist/index.js';

const teacher = { personId: 'person-1', subject: 'TEACHER', scope: 'SELF' };
const session = { sessionId: 'session-1', accountId: 'account-1', personId: 'person-1', roleContexts: [teacher], currentRoleContext: teacher };

test('场地管理请求使用现有路由、版本和可复用命令键', async () => {
  const calls = [];
  const client = new TeacherApiClient({ transport: async request => {
    calls.push(request);
    return { status: 200, body: { data: request.path === '/v1/session' ? session : { id: 'venue-1', version: 2 } } };
  } });
  await client.login({ phoneNormalized: '13800000000', password: 'password' });
  await client.createVenue({ name: '北楼', makeDefault: true }, 'create-key');
  await client.renameVenue('venue-1', { name: '南楼', expectedVersion: 2 }, 'rename-key');
  await client.setVenueStatus('venue-1', { status: 'INACTIVE', expectedVersion: 2 }, 'status-key');
  await client.setDefaultVenue('venue-1', { expectedVersion: 2 }, 'default-key');
  await client.setVenuePermission('venue-1', { granteePersonId: 'person-2', canView: true, canWithdraw: false, expectedGrantId: null }, 'grant-key');
  assert.deepEqual(calls.slice(1).map(({ method, path }) => [method, path]), [
    ['POST', '/v1/venues'],
    ['PATCH', '/v1/venues/venue-1'],
    ['PATCH', '/v1/venues/venue-1'],
    ['POST', '/v1/venues/venue-1/default'],
    ['POST', '/v1/venues/venue-1/permissions'],
  ]);
  assert.deepEqual(calls[2].body, { name: '南楼', expectedVersion: 2, idempotencyKey: 'rename-key' });
  assert.deepEqual(calls[5].body, { granteePersonId: 'person-2', canView: true, canWithdraw: false, expectedGrantId: null, idempotencyKey: 'grant-key' });
  assert.ok(calls.slice(1).every(call => call.headers.authorization === 'Bearer session-1'));
});

test('场地管理拒绝非法版本，撤权后清除客户端当前角色', async () => {
  const calls = [];
  let revoked = false;
  const client = new TeacherApiClient({ transport: async request => {
    calls.push(request);
    if (request.path === '/v1/session') return { status: 200, body: { data: session } };
    return revoked
      ? { status: 403, body: { error: { code: 'FORBIDDEN_SCOPE', message: 'FORBIDDEN_SCOPE' } } }
      : { status: 200, body: { data: { id: 'venue-1', version: 2 } } };
  } });
  await client.login({ phoneNormalized: '13800000000', password: 'password' });
  await assert.rejects(client.renameVenue('venue-1', { name: '新名字', expectedVersion: 0 }, 'key'), error => error instanceof ApiClientError && error.code === 'INVALID_INPUT');
  assert.equal(calls.length, 1);
  revoked = true;
  await assert.rejects(client.setDefaultVenue('venue-1', { expectedVersion: 2 }, 'key'), error => error.code === 'FORBIDDEN_SCOPE');
  assert.equal(client.hasRoleContext, false);
});
