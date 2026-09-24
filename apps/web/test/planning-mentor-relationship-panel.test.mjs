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
const flush=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const props=node=>node[Object.keys(node).find(key=>key.startsWith("__reactProps$"))];
const session=(subject="PLANNING_MENTOR",scope="SELF")=>({sessionId:"session",accountId:"account",personId:"mentor",roleContexts:[],currentRoleContext:{personId:"mentor",subject,scope}});
const directory={mentorPersonId:"mentor",mentorNickname:"导师甲",managedPlanners:[{personId:"planner-1",nickname:"规划师甲",relationshipId:"relation-1",validFrom:"2026-09-20T16:00:00.000Z",validTo:null}],availablePlanners:[{personId:"planner-2",nickname:"规划师乙"}],currentWeeks:[{id:"week-1",startsOn:"2026-09-21",endsOn:"2026-09-27",settlementMonth:"2026-09-01"}]};
const preview={previewId:"preview-1",action:"ADD",mentorPersonId:"mentor",plannerPersonId:"planner-2",plannerNickname:"规划师乙",effectiveTeachingWeekId:"week-1",effectiveAt:"2026-09-20T16:00:00.000Z",nextBoundaryAt:null,consideredFeeCount:3,changedFeeCount:2,zeroShareFeeCount:1,excludedRefundCount:0,plannerDeltaCents:"-240",mentorDeltaCents:"240"};

test.before(async()=>{temp=await mkdtemp(resolve(import.meta.dirname,".planning-mentor-web-"));const out=resolve(temp,"panel.mjs");await build({entryPoints:[resolve(import.meta.dirname,"../src/planning-mentor-relationship-panel.tsx")],bundle:true,platform:"node",format:"esm",outfile:out,external:["react","react-dom","@teaching-research-alliance/client"]});Panel=(await import(out)).PlanningMentorRelationshipPanel;});
test.after(async()=>{await rm(temp,{recursive:true,force:true});});

async function mount(overrides={}){const dom=new JSDOM("<div id='host'></div>",{url:"http://localhost"});Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});const host=document.querySelector("#host"),root=createRoot(host);const locks=[],saved=[],invalidated=[];let current=session(),key="one";const client={hasRoleContext:true,listPlanningMentorRelationships:async()=>directory,previewPlanningMentorRelationshipChange:async()=>preview,createPlanningMentorRelationshipChangeSubmission:previewId=>({draft:{previewId},idempotencyKey:"stable-key"}),publishPlanningMentorRelationshipChange:async()=>({replay:false}),...overrides};const render=async()=>{await act(async()=>root.render(React.createElement(Panel,{client,session:current,sessionKey:key,onSaved:()=>saved.push(true),onInvalidated:()=>invalidated.push(true),onUnconfirmedChange:value=>locks.push(value)})));await flush();};await render();const button=text=>[...host.querySelectorAll("button")].find(node=>node.textContent===text);const change=async(label,value)=>{const node=host.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);await act(async()=>props(node).onChange({target:{value}}));};const fill=async()=>{await change("规划师","planner-2");await change("当前普通周","week-1");await change("变更原因","普通周纳入本人管理");};return{host,client,locks,saved,invalidated,button,fill,render,setSession:(next,nextKey="two")=>{current=next;key=nextKey;},close:async()=>{await act(async()=>root.unmount());dom.window.close();}};}

test("预览后发布，未知结果只复用原关系命令",async()=>{const first=deferred(),calls=[];const v=await mount({publishPlanningMentorRelationshipChange:command=>{calls.push(command);return calls.length===1?first.promise:Promise.resolve({replay:true});}});try{await v.fill();await act(async()=>v.button("生成关系影响预览").click());await flush();assert.match(v.host.textContent,/介绍池总额不增加/);await act(async()=>{const publish=v.button("确认发布关系变更");publish.click();publish.click();});assert.equal(calls.length,1);await act(async()=>first.reject(new Error("offline")));await flush();assert.equal(v.locks.at(-1),true);await act(async()=>v.host.querySelector("[data-planning-mentor-action='retry-publish']").click());await flush();assert.equal(calls.length,2);assert.strictEqual(calls[0],calls[1]);assert.equal(v.saved.length,1);}finally{await v.close();}});

test("旧身份迟到目录和权限失效不会保留关系数据",async()=>{const late=deferred();const v=await mount({listPlanningMentorRelationships:()=>late.promise});try{v.setSession(session("ACADEMIC_PLANNER"),"two");await v.render();await act(async()=>late.resolve(directory));await flush();assert.equal(v.host.textContent.includes("规划师甲"),false);assert.match(v.host.textContent,/切换到学业规划导师/);}finally{await v.close();}const denied=await mount({listPlanningMentorRelationships:async()=>{throw new ApiClientError(403,"FORBIDDEN_SCOPE");}});try{await flush();assert.equal(denied.invalidated.length,1);assert.match(denied.host.textContent,/身份已失效/);}finally{await denied.close();}});
