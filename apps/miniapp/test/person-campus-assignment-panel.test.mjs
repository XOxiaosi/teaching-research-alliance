import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
let temp;
test("Mini人员校区调整组件可独立构建并包含管理员边界提示",async()=>{temp=await mkdtemp(resolve(import.meta.dirname,".person-campus-mini-"));const out=resolve(temp,"panel.js");await build({entryPoints:[resolve(import.meta.dirname,"../src/pages/index/person-campus-assignment-panel.tsx")],bundle:true,platform:"node",format:"esm",outfile:out,external:["react","@tarojs/components","@teaching-research-alliance/client"]});const source=await readFile(resolve(import.meta.dirname,"../src/pages/index/person-campus-assignment-panel.tsx"),"utf8");assert.match(source,/person-campus-assignment-panel/);assert.match(source,/校区换分区/);assert.match(source,/组长、指导导师、规划导师和场地不变/);await rm(temp,{recursive:true,force:true})});
