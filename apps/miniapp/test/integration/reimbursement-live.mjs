import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TeacherApiClient } from '@teaching-research-alliance/client';

// This mounts actual React/Taro application code, but does not emulate a WeChat device.
assert.equal(process.env.ALLIANCE_SYNTHETIC_E2E, '1', 'Disposable local synthetic API required');
const api = process.env.ALLIANCE_MINI_API_URL;
assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname));
const testDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const miniapp = resolve(testDirectory, '..');
const temporary = await mkdtemp(resolve(testDirectory, '.reimbursement-live-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=', 'base64');
const pngBytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
const trace = { submits: [], reviews: [], uploadedVersions: [], downloadedVersions: [] };
let dropSubmit = true;
let dropReview = true;
let downloaded = null;
let busy = false;
let unknown = false;
let invalidations = 0;
const clients = [];
let root;
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const container = dom.window.document.querySelector('#app');
globalThis.__miniappTaro = {
  request: async ({ url, method = 'GET', header = {}, data }) => {
    const path = new URL(url).pathname;
    const response = await fetch(url, { method, headers: { ...header, ...(data instanceof ArrayBuffer ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: data instanceof ArrayBuffer ? data : JSON.stringify(data) }) });
    const body = await response.json();
    if (path.endsWith('/reimbursement-submit')) {
      trace.submits.push({ body: data, result: body.data, status: response.status });
      if (response.ok && dropSubmit) { dropSubmit = false; throw new Error('SYNTHETIC_LOST_SUBMIT_RESPONSE'); }
    }
    if (/\/reimbursements\/[^/]+\/approve$/.test(path)) {
      trace.reviews.push({ body: data, result: body.data, status: response.status });
      if (response.ok && dropReview) { dropReview = false; throw new Error('SYNTHETIC_LOST_REVIEW_RESPONSE'); }
    }
    if (/attachment-uploads\/[^/]+\/content$/.test(path) && response.ok) trace.uploadedVersions.push(body.data.versionId);
    return { statusCode: response.status, data: body };
  },
  showActionSheet: async () => ({ tapIndex: 0 }),
  chooseImage: async () => ({ tempFilePaths: ['wxfile://synthetic-original.png'] }),
  getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: pngBytes }) }),
  downloadFile: async ({ url, header }) => {
    const response = await fetch(url, { headers: header });
    downloaded = Buffer.from(await response.arrayBuffer());
    if (response.ok) trace.downloadedVersions.push(new URL(url).pathname.split('/').at(-2));
    return { statusCode: response.status, tempFilePath: response.ok ? 'wxfile://synthetic-download.png' : undefined };
  },
  previewImage: async () => { assert.deepEqual(downloaded, png); },
  openDocument: async () => { throw new Error('PNG_EXPECTED'); }
};

const adapter = { name: 'live-taro-adapter', setup(plugin) {
  plugin.onResolve({ filter: /^@tarojs\/(taro|components)$/ }, args => ({ path: args.path, namespace: 'taro-adapter' }));
  plugin.onLoad({ filter: /.*/, namespace: 'taro-adapter' }, args => ({ loader: 'js', contents: args.path.endsWith('/taro')
    ? 'export default new Proxy({}, {get: (_, key) => (...args) => globalThis.__miniappTaro[key](...args)});'
    : `import React from 'react';
       export const View=({children,...props})=>React.createElement('div',props,children);
       export const Text=({children,...props})=>React.createElement('span',props,children);
       export const Image=({src,...props})=>React.createElement('img',{...props,src});
       export const Button=({children,...props})=>React.createElement('button',props,children);
       export const Input=({maxlength,onInput,...props})=>React.createElement('input',{...props,onInput:e=>onInput?.({detail:{value:e.currentTarget.value}})});
       export const Textarea=({maxlength,onInput,...props})=>React.createElement('textarea',{...props,maxLength:maxlength,onInput:e=>onInput?.({detail:{value:e.currentTarget.value}})});
       export const Picker=({children,range,value,onChange,disabled})=>React.createElement('div',{},React.createElement('select',{value,disabled,onChange:e=>onChange?.({detail:{value:e.currentTarget.value}})},range.map((x,i)=>React.createElement('option',{key:i,value:i},x))),children);`
  }));
} };
const wait = async (predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    await act(async () => { await new Promise(done => setTimeout(done, 25)); });
    if (predicate()) return;
  }
  throw new Error(`WAIT_FAILED: ${label}\n${container.textContent}`);
};
const button = (label, scope = container) => [...scope.querySelectorAll('button')].find(node => node.textContent === label);
const click = async node => {
  assert.ok(node, 'button exists'); assert.equal(node.disabled, false);
  await act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await wait(() => !busy, 'action finishes');
};
const input = async (node, value) => {
  assert.ok(node); assert.equal(node.disabled, false);
  await act(async () => { node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
try {
  const entry = resolve(temporary, 'entry.ts');
  await writeFile(entry, `export {ReimbursementPanel} from ${JSON.stringify(resolve(miniapp, 'src/pages/index/reimbursement-panel.tsx'))};\nexport {taroTransport} from ${JSON.stringify(resolve(miniapp, 'src/services.ts'))};`);
  const output = resolve(temporary, 'bundle.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'node', external: ['react', '@teaching-research-alliance/client'], define: { __API_BASE_URL__: JSON.stringify(api) }, plugins: [adapter], loader: { '.css': 'empty' } });
  const { ReimbursementPanel, taroTransport } = await import(pathToFileURL(output).href);
  const login = async (phone, subject) => {
    const client = new TeacherApiClient({ transport: taroTransport }); clients.push(client);
    await client.login({ phoneNormalized: phone, password: 'Local-demo-only-2026' });
    if (client.currentSession?.currentRoleContext?.subject !== subject) await client.switchRole(subject);
    return client;
  };
  const mount = async (client, mode) => {
    if (root) await act(async () => root.unmount());
    busy = false; unknown = false;
    root = createRoot(container);
    await act(async () => root.render(React.createElement(ReimbursementPanel, { client, session: client.currentSession, mode,
      onBusyChange: value => { busy = value; }, onUnconfirmedChange: value => { unknown = value; }, onInvalidated: () => { invalidations++; }
    })));
    await wait(() => Boolean(button('刷新报销记录')) && !button('刷新报销记录').disabled, 'initial load');
  };
  const teacher = await login('13800000001', 'TEACHING_TEACHER');
  const before = await teacher.getOwnOverview();
  await mount(teacher, 'personal');
  await click(button('新建报销申请'));
  await input(container.querySelector('input'), '39.17');
  const reason = `MINI_REIMBURSE_LIVE_${Date.now()}`;
  await input(container.querySelector('[placeholder="说明本次报销用途"]'), reason);
  await click(button('选择申请截图'));
  await click(button('上传已选图片（1张）'));
  await wait(() => container.textContent.includes('已就绪申请截图 1 张'), 'READY application screenshot');
  await click(button('确认提交报销申请'));
  assert.equal(unknown, true); assert.equal(container.querySelector('input').disabled, true);
  assert.equal(button('刷新报销记录').disabled, true);
  await click(button('安全重试原报销申请'));
  assert.equal(unknown, false);
  assert.equal(trace.submits.length, 2); assert.deepEqual(trace.submits[0].body, trace.submits[1].body);
  assert.equal(trace.submits[1].result.replay, true);
  const documentId = trace.submits[1].result.id;
  assert.deepEqual(trace.submits[0].body.attachmentVersionIds.slice().sort(), trace.uploadedVersions.slice().sort());
  const afterSubmit = await teacher.getOwnOverview();
  assert.equal(afterSubmit.balanceCents, before.balanceCents);
  assert.deepEqual(afterSubmit.currentYearIncomeByCategory, before.currentYearIncomeByCategory);

  const finance = await login('13800000003', 'HEADQUARTERS_FINANCE');
  await mount(finance, 'managed');
  await wait(() => [...container.querySelectorAll('.student-row')].some(row => row.textContent.includes('39.17')), 'managed list');
  const managed = await finance.listManagedReimbursements();
  const index = managed.documents.findIndex(item => item.id === documentId);
  assert.ok(index >= 0);
  const row = [...container.querySelectorAll('.student-row')][index];
  await click(button('查看报销详情', row));
  assert.ok(container.textContent.includes(reason));
  await click(button('打开报销申请截图'));
  assert.equal(trace.downloadedVersions.length, 1);
  await click(button('批准报销申请'));
  assert.equal(unknown, true); assert.equal(container.querySelector('[placeholder="可选：填写审核依据或驳回原因"]').disabled, true);
  await click(button('安全重试原审核操作'));
  assert.equal(unknown, false); assert.equal(trace.reviews.length, 2);
  assert.deepEqual(trace.reviews[0].body, trace.reviews[1].body); assert.equal(trace.reviews[1].result.replay, true);
  assert.ok(container.textContent.includes('审核通过·待划拨'));
  assert.equal(button('批准报销申请'), undefined);
  const detail = await teacher.getReimbursementDetail(documentId);
  const afterReview = await teacher.getOwnOverview();
  assert.equal(detail.status, 'APPROVED'); assert.equal(detail.reason, reason);
  assert.equal(afterReview.balanceCents, before.balanceCents);
  assert.deepEqual(afterReview.currentYearIncomeByCategory, before.currentYearIncomeByCategory);
  assert.equal(invalidations, 0);
  console.log(JSON.stringify({ baseline: '980089c / reimbursement API 690001e', validation: 'React/Taro HTTP adapter against local synthetic PostgreSQL API; not WeChat device', documentId, reason, before, afterSubmit, afterReview, detail, trace }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ failureView: container.textContent, trace }, null, 2));
  throw error;
} finally {
  if (root) await act(async () => root.unmount());
  for (const client of clients) { try { await client.endSession(); } catch {} }
  dom.window.close();
  await rm(temporary, { recursive: true, force: true });
}
