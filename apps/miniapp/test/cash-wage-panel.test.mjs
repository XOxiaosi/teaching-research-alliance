import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import test from 'node:test';
const rootDir=resolve(import.meta.dirname,'..'); let bundle;
const plugin = {
  name: 'salary-taro',
  setup(b) {
    b.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: 'taro', namespace: 'salary' }));
    b.onLoad({ filter: /^taro$/, namespace: 'salary' }, () => ({ loader: 'js', contents: 'export default { downloadFile: async () => ({ statusCode: 200 }) };' }));
    b.onResolve({ filter: /^@tarojs\/components$/ }, () => ({ path: 'components', namespace: 'salary' }));
    b.onLoad({ filter: /.*/, namespace: 'salary' }, () => ({ loader: 'js', contents: `import React from 'react'; export const View=({children,...p})=>React.createElement('div',p,children); export const Text=({children,...p})=>React.createElement('span',p,children); export const Button=({children,...p})=>React.createElement('button',p,children); export const Picker=({children,range=[],value=0,onChange,...p})=>React.createElement('div',p,React.createElement('select',{value:String(value),onChange:(e)=>onChange?.({detail:{value:e.currentTarget.value}})},range.map((x,i)=>React.createElement('option',{key:i,value:String(i)},x))),children);` }));
  }
};
const panel=async()=>{if(bundle)return bundle;const dir=await mkdtemp(resolve(import.meta.dirname,'.cash-wage-'));const out=resolve(dir,'panel.mjs');await build({entryPoints:[resolve(rootDir,'src/pages/index/cash-wage-panel.tsx')],bundle:true,format:'esm',platform:'node',outfile:out,define:{__API_BASE_URL__:JSON.stringify('http://127.0.0.1:3100')},external:['react','@teaching-research-alliance/client'],plugins:[plugin]});bundle={dir,module:await import(`file://${out}?${Date.now()}`)};return bundle;};
const session=(subject,extra={})=>({sessionId:'s',accountId:'a',personId:'p',currentRoleContext:{subject,scope:'GLOBAL',...extra},roleContexts:[{subject,scope:'GLOBAL',...extra}]});
const roster={salaryMonth:'2026-09-01',items:[{teacherPersonId:'t',teacherDisplayName:'王老师',salaryMonth:'2026-09-01',plan:{id:'p',sourceMonth:'2026-09-01',version:1,plannedCashCents:'12345',plannedDeductionCents:'500',active:true,appliesToFutureMonths:false,reason:'计划',changedAt:'2026-09-01',changedByPersonId:'x'},todo:null,confirmedCashCents:'13000',confirmedDeductionCents:'500',remainingCashCents:'0',remainingDeductionCents:'0',overageCashCents:'655',overageDeductionCents:'0',status:'OVER_CONFIRMED'}]};
const history={items:[{documentId:'d',status:'COMPLETED',version:1,teacherPersonId:'t',teacherDisplayName:'王老师',todoId:null,salaryMonth:'2026-09-01',cashPaidCents:'10000',deductionCents:'500',balanceBeforeCents:null,balanceAfterCents:null,paidAt:'2026-09-20',reason:'已付',confirmedByPersonId:'x',confirmedByDisplayName:'财务',createdAt:'2026-09-20',attachmentCount:1,reversal:null,correctionOfDocumentId:null,correctionDocumentId:null}],nextCursor:null};
const detail={...history.items[0],plan:null,todo:null,attachments:[{versionId:'v',purpose:'SUPPORTING_DOCUMENT',originalFilename:'工资凭证.pdf',mediaType:'application/pdf',sizeBytes:1,sha256:'x'}]};
const flush=async()=>act(async()=>{await Promise.resolve();await new Promise(r=>setTimeout(r,0));});
test.after(async()=>{if(bundle)await rm(bundle.dir,{recursive:true,force:true});});
test('工资读页严格权限、超计划金额、详情和身份切换清理',async()=>{const {module}=await panel(); const {CashWagePanel}=module;const calls=[];const client={listManagedCashWageRoster:async m=>{calls.push(['roster',m]);return roster;},listManagedCashWageConfirmations:async x=>{calls.push(['history',x.month]);return history;},getManagedCashWageDetail:async()=>detail};const dom=new JSDOM('<div id=a></div>',{url:'http://localhost'});Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});const host=document.querySelector('#a');const root=createRoot(host);await act(async()=>root.render(React.createElement(CashWagePanel,{client,session:session('HEADQUARTERS_FINANCE'),sessionKey:'one'})));await flush();assert.ok(host.textContent.includes('123.45 元'));assert.ok(host.textContent.includes('超计划 6.55 元'));await act(async()=>root.render(React.createElement(CashWagePanel,{client,session:session('TEACHING_TEACHER'),sessionKey:'two'})));await flush();assert.ok(host.textContent.includes('当前身份没有读取总部工资数据的权限'));assert.equal(host.textContent.includes('王老师'),false);root.unmount();dom.window.close();});
