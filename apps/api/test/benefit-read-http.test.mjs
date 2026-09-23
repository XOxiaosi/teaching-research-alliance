import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {handleRequest,createApiServer} from '../dist/main.js';
const at=new Date('2026-09-23T00:00:00Z');
const global={personId:'finance',subject:'HEADQUARTERS_FINANCE',scope:'GLOBAL'};
function setup(context=global){const calls=[];return {calls,services:{now:()=>at,sessions:{get:()=>({currentRoleContext:context})},weeklyFees:{},benefitReads:{listRoster:(...args)=>{calls.push(args);return {benefitMonth:args[1],items:[]};},getDetail:(...args)=>{calls.push(args);return {documentId:args[1],amountCents:'9007199254740993'};}}}};}
const request={method:'GET',path:'/v1/finance/benefit-roster',sessionId:'session',body:{},query:{month:'2026-09-01'}};
test('benefit reads bind server context and clock, reject unauthorized scopes and client scope inputs',async()=>{
 for(const subject of ['SYSTEM_OWNER','SYSTEM_ADMIN','HEADQUARTERS_FINANCE']) {const {services,calls}=setup({...global,subject});assert.equal((await handleRequest(request,services)).status,200);assert.deepEqual(calls,[[{...global,subject},'2026-09-01',at]]);}
 for(const context of [{...global,subject:'TEACHING_TEACHER',scope:'SELF'},{...global,subject:'REGION_FINANCE',scope:'REGION',regionId:'r'},{...global,regionId:'r'},{...global,campusId:'c'},{...global,venueId:'v'}]){const {services,calls}=setup(context);for(const req of [request,{...request,path:'/v1/finance/benefits/doc',query:{}}]) assert.equal((await handleRequest(req,services)).status,403);assert.equal(calls.length,0);}
 const {services,calls}=setup();assert.equal((await handleRequest({...request,sessionId:undefined},services)).status,401);
 for(const changed of [{query:{}},{query:{month:'2026-13-01'}},{query:{month:'2026-09-01',personId:'other'}},{body:{scope:'GLOBAL'}},{path:'/v1/finance/benefits/doc',query:{month:'2026-09-01'}}])assert.equal((await handleRequest({...request,...changed},services)).status,400);
 assert.equal(calls.length,0);
});
test('benefit detail keeps integer text and HTTP responses cannot be cached',async()=>{const {services,calls}=setup();const server=createApiServer(services);server.listen(0,'127.0.0.1');await once(server,'listening');try{const result=await fetch(`http://127.0.0.1:${server.address().port}/v1/finance/benefits/doc`,{headers:{authorization:'Bearer session'}});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');assert.deepEqual((await result.json()).data,{documentId:'doc',amountCents:'9007199254740993'});assert.deepEqual(calls,[[global,'doc']]);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
