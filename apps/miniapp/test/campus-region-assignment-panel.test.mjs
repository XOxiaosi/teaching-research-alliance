import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

test("Mini校区分区调整组件固定北京时间、提供权限和安全重试交互", async () => {
  const temp = await mkdtemp(resolve(import.meta.dirname, ".campus-region-mini-"));
  try {
    const source = await readFile(resolve(import.meta.dirname, "../src/pages/index/campus-region-assignment-panel.tsx"), "utf8");
    await build({ entryPoints: [resolve(import.meta.dirname, "../src/pages/index/campus-region-assignment-panel.tsx")], bundle: true, platform: "node", format: "esm", outfile: resolve(temp, "panel.mjs"), external: ["react", "@tarojs/components", "@teaching-research-alliance/client"] });
    assert.match(source, /\+08:00/);
    assert.match(source, /校区本身不变，校长、组长、教学导师、规划导师和场地保持不变/);
    assert.match(source, /目标分区与所选生效时段的原分区相同，无需重复调整/);
    assert.doesNotMatch(source, /currentRegionId === regionId/);
    assert.match(source, /使用原发布请求安全重试/);
    assert.match(source, /CAMPUS_REGION_SETTLEMENT_DATA_UNAVAILABLE/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
