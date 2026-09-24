import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError } from "@teaching-research-alliance/client";
let Panel; let temp;
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0))}); const props=n=>n[Object.keys(n).find(k=>k.startsWith("__reactProps$"))];
const session=(subject="SYSTEM_ADMIN")=>({sessionId:"s",accountId:"a",personId:"admin",roleContexts:[],currentRoleContext:{subject,scope:"GLOBAL",personId:"admin"}});
const directory={teachers:[{personId:"teacher",nickname:"老师甲",currentMentorPersonId:null,currentMentorNickname:null,currentRelationshipId:null},{personId:"teacher2",nickname:"老师乙",currentMentorPersonId:null,currentMentorNickname:null,currentRelationshipId:null}],mentors:[{personId:"mentor",nickname:"导师乙",eligibleTeacherPersonIds:null},{personId:"directed",nickname:"定向导师",eligibleTeacherPersonIds:["teacher"]}],currentWeeks:[{id:"week",startsOn:"2026-09-21",endsOn:"2026-09-27",settlementMonth:"2026-09-01"},{id:"week2",startsOn:"2026-09-28",endsOn:"2026-10-04",settlementMonth:"2026-10-01"}]};
const preview={previewId:"preview",action:"ADD",teacherPersonId:"teacher",sourceRelatedPersonId:null,sourceRelatedNickname:null,newRelatedPersonId:"mentor",newRelatedNickname:"导师乙",effectiveTeachingWeekId:"week",effectiveThroughTeachingWeekId:null,effectiveAt:"2026-09-21T00:00:00.000Z",nextBoundaryAt:null,consideredFeeCount:2,movedFeeCount:2,zeroShareFeeCount:0,excludedRefundCount:0,movedAmountCents:"1200"};
test.before(async()=>{temp=await mkdtemp(resolve(import.meta.dirname,".teaching-mentor-web-"));const out=resolve(temp,"panel.mjs");await build({entryPoints:[resolve(import.meta.dirname,"../src/teaching-mentor-change-panel.tsx")],bundle:true,platform:"node",format:"esm",outfile:out,external:["react","react-dom","@teaching-research-alliance/client"]});Panel=(await import(out)).TeachingMentorChangePanel}); test.after(async()=>{await rm(temp,{recursive:true,force:true})});
async function mount(overrides={}){const dom=new JSDOM("<div id='host'></div>",{url:"http://localhost"});Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});const host=document.querySelector("#host"),root=createRoot(host),calls=[];const client={hasRoleContext:true,listTeachingMentorRelationshipCandidates:async()=>directory,previewTeachingMentorRelationshipChange:async d=>{calls.push(d);return preview},createTeachingMentorRelationshipChangeSubmission:id=>({draft:{previewId:id},idempotencyKey:"key"}),publishTeachingMentorRelationshipChange:async()=>({replay:false}),...overrides};await act(async()=>root.render(React.createElement(Panel,{client,session:session(),sessionKey:"one",onInvalidated:()=>calls.push("invalid")})));await flush();const input=async(label,value)=>{const n=host.querySelector(`[aria-label="${label}"]`);await act(async()=>props(n).onChange({target:{value}}))};return{host,calls,input,close:async()=>{await act(async()=>root.unmount());dom.window.close()}}}
test("预览后未知发布复用同一提交并保留草稿",async()=>{let attempts=0;const ui=await mount({publishTeachingMentorRelationshipChange:async command=>{assert.equal(command.idempotencyKey,"key");if(++attempts===1)throw new Error("offline");return {replay:true}}});try{await ui.input("授课老师","teacher"); assert.match(ui.host.querySelector("select[aria-label='教学导师']").textContent,/定向导师/); await ui.input("教学导师","mentor");await ui.input("生效普通周","week");await ui.input("变更原因","导师调整");await act(async()=>[...ui.host.querySelectorAll("button")].find(n=>n.textContent==="生成教学导师变更预览").click());await flush();assert.match(ui.host.textContent,/替换|新增/);await act(async()=>[...ui.host.querySelectorAll("button")].find(n=>n.textContent==="确认发布教学导师变更").click());await flush();assert.match(ui.host.textContent,/结果未确认/);await act(async()=>ui.host.querySelector("[data-teaching-mentor-action='retry-publish']").click());await flush();assert.equal(attempts,2);assert.match(ui.host.textContent,/教学导师变更已确认/)}finally{await ui.close()}});
test("401/403与迟到目录不泄露旧数据",async()=>{let resolveLate;const late=new Promise(r=>{resolveLate=r});let reads=0;const ui=await mount({listTeachingMentorRelationshipCandidates:()=>++reads===1?late:Promise.resolve(directory)});try{resolveLate(directory);await flush();assert.match(ui.host.textContent,/老师甲/)}finally{await ui.close()}const denied=await mount({listTeachingMentorRelationshipCandidates:async()=>{throw new ApiClientError(403,"FORBIDDEN_SCOPE")}});try{assert.match(denied.host.textContent,/身份已失效/)}finally{await denied.close()}});

test("结束普通周包含开始周，开始周后移会清空过早结束周", async () => {
  const ui = await mount();
  try {
    await ui.input("生效普通周", "week");
    const through = ui.host.querySelector("select[aria-label='结束普通周']");
    assert.match(through.textContent, /2026-09-21/);
    await act(async () => props(through).onChange({ target: { value: "week" } }));
    await act(async () => props(ui.host.querySelector("select[aria-label='生效普通周']")).onChange({ target: { value: "week2" } }));
    assert.equal(through.value, "");
  } finally { await ui.close(); }
});

test("切换授课老师会清空旧定向导师且禁止提交旧候选", async () => {
  const calls = []; const ui = await mount({ previewTeachingMentorRelationshipChange: async (draft) => { calls.push(draft); return preview; } });
  try { await ui.input("授课老师", "teacher"); await ui.input("教学导师", "directed"); await ui.input("生效普通周", "week"); await ui.input("变更原因", "导师调整"); await ui.input("授课老师", "teacher2"); assert.equal(ui.host.querySelector("select[aria-label='教学导师']").value, ""); await act(async () => [...ui.host.querySelectorAll("button")].find((node) => node.textContent === "生成教学导师变更预览").click()); await flush(); assert.equal(calls.length, 0); assert.match(ui.host.textContent, /请选择授课老师、教学导师和普通周/); } finally { await ui.close(); }
});
