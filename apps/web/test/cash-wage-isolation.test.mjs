import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClientError, RoleSelectionRequiredError } from '@teaching-research-alliance/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const dirs=[];
const modules=new Map();
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const role=(subject='HEADQUARTERS_FINANCE',extra={})=>({sessionId:'session',personId:'finance',currentRoleContext:{subject,scope:'GLOBAL',...extra}});
const record=(id='one')=>({documentId:id,teacherDisplayName:`教师${id}`,salaryMonth:'2026-09-01',cashPaidCents:'10000',deductionCents:'10000',status:'COMPLETED',balanceBeforeCents:'5000',balanceAfterCents:'-5000',paidAt:'2026-09-10T00:00:00Z',reason:`详情${id}`,attachments:[]});
const roster={salaryMonth:'2026-09-01',items:[]};
const page={items:[record('one'),record('two')],nextCursor:'next'};
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
async function load(surface){
 if(modules.has(surface))return modules.get(surface);
 const dir=await mkdtemp(resolve(import.meta.dirname,'.wage-isolation-'));dirs.push(dir);
 const plugins=surface==='mini'?[{name:'taro-test',setup(b){
 b.onResolve({filter:/^@tarojs\/components$/},()=>({path:'components',namespace:'stub'}));
 b.onResolve({filter:/^@tarojs\/taro$/},()=>({path:'taro',namespace:'stub'}));
 b.onResolve({filter:/\.\.\/\.\.\/services$/},()=>({path:'services',namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},({path})=>({loader:'js',contents:path==='components'?`import React from 'react'; export const View=({children,...p})=>React.createElement('div',p,children);export const Text=({children,...p})=>React.createElement('span',p,children);export const Button=({children,size,...p})=>React.createElement('button',p,children);export const Picker=({value,fields,onChange})=>React.createElement('button',{'data-month':value,'data-fields':fields,onClick:()=>onChange({detail:{value:'2026-10'}})},'切到十月');`:path==='services'?`export const downloadFinanceAttachmentToTemp=(...args)=>globalThis.wageDownload(...args);`:`export default {openDocument:(...args)=>globalThis.wageOpened.push(args),previewImage:(...args)=>globalThis.wageOpened.push(args)};`}));
 }}]:[];
 const entry=surface==='mini'?resolve(import.meta.dirname,'../../miniapp/src/pages/index/cash-wage-panel.tsx'):resolve(import.meta.dirname,'../src/cash-wage-panel.tsx');
 const out=resolve(dir,'panel.mjs');await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',outfile:out,external:['react','react-dom','@teaching-research-alliance/client'],plugins});
 const value=(await import(out)).CashWagePanel;modules.set(surface,value);return value;
}
async function mount(surface,client){
 const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.querySelector('#host');const root=createRoot(host);let invalidations=0;const Panel=await load(surface);let session=role();client.currentSession=session;
 const render=async(next=session,key='a')=>{session=next;client.currentSession=next;await act(async()=>root.render(React.createElement(Panel,{client,session,sessionKey:key,onInvalidated:()=>{invalidations++;}})));await flush();};
 await render();return {host,render,dom,invalidations:()=>invalidations,close:async()=>{await act(async()=>root.unmount());dom.window.close();}};
}
async function click(host,match){const target=[...host.querySelectorAll('button,div.venue-board-fee')].find(n=>n.textContent.includes(match));assert.ok(target,match);await act(async()=>target.click());await flush();}
const clientBase=()=>({listManagedCashWageRoster:async()=>roster,listManagedCashWageConfirmations:async()=>page,getManagedCashWageDetail:async id=>record(id),logout(){this.currentSession=null;}});
test.after(async()=>{for(const dir of dirs)await rm(dir,{recursive:true,force:true});});
for(const surface of ['web','mini']){
 test(`${surface} 工资详情竞争与分页独立，旧身份响应不得回填`,async()=>{
  const first=deferred(),second=deferred(),more=deferred();const client=clientBase();
  client.getManagedCashWageDetail=id=>id==='one'?first.promise:second.promise;
  client.listManagedCashWageConfirmations=input=>input.cursor?more.promise:Promise.resolve(page);
  const view=await mount(surface,client);
  try{
   await click(view.host,'教师one ·');await click(view.host,'教师two ·');await click(view.host,'加载更多');
   await act(async()=>second.resolve({...record('two'),reason:'当前详情'}));await flush();assert.ok(view.host.textContent.includes('教师two · 详情'));
   await act(async()=>first.resolve({...record('one'),reason:'旧详情'}));await flush();assert.equal(view.host.textContent.includes('教师one · 详情'),false);
   await act(async()=>more.resolve({items:[record('three')],nextCursor:null}));await flush();assert.ok(view.host.textContent.includes('教师three ·'));assert.ok(view.host.textContent.includes('-50'));
   const late=deferred();client.getManagedCashWageDetail=()=>late.promise;await click(view.host,'教师one ·');assert.equal(view.host.textContent.includes('教师two · 详情'),false);
   await view.render(role('TEACHING_TEACHER'),'teacher');await act(async()=>late.resolve(record('one')));await flush();assert.equal(view.host.textContent.includes('教师one'),false);
  }finally{await view.close();}
 });
 test(`${surface} 切换上下文后旧分页失败不污染新结果，窄范围财务不能读取`,async()=>{
  const late=deferred();const client=clientBase();let calls=0;client.listManagedCashWageConfirmations=input=>{calls++;return input.cursor?late.promise:Promise.resolve(page);};
  const view=await mount(surface,client);
  try{await click(view.host,'加载更多');await view.render(role('SYSTEM_ADMIN'),'admin');await act(async()=>late.reject(new Error('late')));await flush();assert.equal(view.host.textContent.includes('翻页读取失败'),false);const before=calls;await view.render(role('HEADQUARTERS_FINANCE',{campusId:'campus'}),'narrow');assert.equal(calls,before);assert.equal(view.host.textContent.includes('教师one'),false);}finally{await view.close();}
 });
}
test('mini 月选择仅传YYYY-MM-01，下载切换身份后不得打开原件或污染新页',async()=>{
 const download=deferred();globalThis.wageDownload=()=>download.promise;globalThis.wageOpened=[];const client=clientBase();const months=[];
 client.listManagedCashWageRoster=async month=>{months.push(month);return {...roster,salaryMonth:month};};
 client.getManagedCashWageDetail=async()=>({...record('one'),attachments:[{versionId:'file',originalFilename:'工资.pdf',mediaType:'application/pdf'}]});
 const view=await mount('mini',client);
 try{assert.equal(view.host.querySelector('[data-fields]').dataset.fields,'month');await click(view.host,'切到十月');assert.equal(months.at(-1),'2026-10-01');await click(view.host,'教师one ·');await click(view.host,'下载原件');await view.render(role('SYSTEM_ADMIN'),'new-admin');await act(async()=>download.resolve({status:200,temporaryPath:'/tmp/wage.pdf'}));await flush();assert.equal(globalThis.wageOpened.length,0);assert.equal(view.host.textContent.includes('原件下载失败'),false);}finally{await view.close();}
});

for(const surface of ['web','mini']){
 test(`${surface} 工资读取401/403清理已加载数据并通知父会话`,async()=>{
  for(const phase of ['initial','detail','page']){
   const client=clientBase();const denied=()=>{client.currentSession=null;client.hasRoleContext=false;return Promise.reject(phase==='page'?new RoleSelectionRequiredError('FORBIDDEN_SCOPE'):new ApiClientError(401,'UNAUTHENTICATED'));};
   if(phase==='initial')client.listManagedCashWageRoster=denied;
   const view=await mount(surface,client);
   try{if(phase==='detail'){client.getManagedCashWageDetail=denied;await click(view.host,'教师one ·');}if(phase==='page'){client.listManagedCashWageConfirmations=denied;await click(view.host,'加载更多');}assert.equal(view.invalidations(),1);assert.equal(view.host.textContent.includes('教师one'),false);assert.ok(view.host.textContent.includes('身份已失效'));}finally{await view.close();}
  }
 });
 test(`${surface} 工资凭证401清理详情并通知父会话`,async()=>{
  const client=clientBase();client.getManagedCashWageDetail=async()=>({...record('one'),attachments:[{versionId:'file',originalFilename:'工资.pdf',mediaType:'application/pdf'}]});
  const previousFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('',{status:401});globalThis.wageDownload=async()=>({status:401});
  const view=await mount(surface,client);
  try{await click(view.host,'教师one ·');await click(view.host,'下载原件');assert.equal(view.invalidations(),1);assert.equal(view.host.textContent.includes('教师one'),false);}finally{globalThis.fetch=previousFetch;await view.close();}
 });
}
