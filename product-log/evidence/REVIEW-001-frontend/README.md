# REVIEW-001 前端行为回归证据

本目录保存本轮前端行为验收截图。测试使用合成 PostgreSQL schema、独立 API 端口 3114、独立 Web 端口 5175；未连接真实业务库、真实账号或外部服务。

## 已执行命令

```sh
node --test apps/miniapp/test/venue-board-live.test.mjs apps/miniapp/test/refund-panel.test.mjs
ALLIANCE_SYNTHETIC_E2E=1 ALLIANCE_WEB_URL=http://127.0.0.1:5175 ALLIANCE_EVIDENCE_DIR=/tmp/teaching-research-alliance-evidence npx playwright test --config=/tmp/alliance-playwright.config.mjs zzzz-real-venue-directory.spec.mjs
```

## 覆盖行为

- 规划师登录后可到达学生推荐、我的提现、共享场地看板三个入口。
- 看板身份切换清空旧教学周和日期筛选；旧身份的延迟响应不会回填新身份界面。
- 退款同一学生课程可多选周费用，切换学生课程会清空旧选择。
- 教师、规划师、兼任财务教师视角真实登录后读取 `/v1/venues/visible`。

Playwright 使用系统 Chrome 的临时配置运行，项目默认 Playwright 配置未修改。截图仅证明合成数据下的本地交互，不代表真实用户验收、生产部署或真实资金流程。

## 主任务独立重跑

- `node --test apps/web/test/venue-board-isolation.test.mjs`：3/3，覆盖旧看板响应丢弃、身份切换清筛选、切场地/筛选清结果、403通知父会话。
- `node --test apps/miniapp/test/venue-board-live.test.mjs apps/miniapp/test/refund-panel.test.mjs`：6/6，真实React组件挂载，Taro控件由DOM适配；不等同微信真机。
- 上述Playwright目录/导航场景由主任务重跑1/1（7.2秒），日志 `/tmp/alliance-review-root-browser.log`，独立截图 `/tmp/alliance-review-root-browser/`。
- `npm run check`：150/150，无失败或跳过。此前因并行在写的工资查询服务类型错误失败，修复后重新完整执行通过，未排除任何测试。
- 父级目录加载的代际保护及刷新撤权清理已经独立源码复核；父级延迟目录请求与切身份组合尚无单独自动化用例，不将面板隔离测试扩大为所有并发路径已验收。

临时Playwright配置使用仓库 `apps/web/e2e` 为testDir，baseURL为 `http://127.0.0.1:5175`，单worker，headless模式，`launchOptions.executablePath`为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。API由已接入场地服务的 `scripts/dev-demo.mjs` 在本机3114端口运行，数据库使用随机测试schema，结束后应关闭这一演示进程以清理其schema和临时附件目录。
