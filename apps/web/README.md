# 网页端

教师登录后默认进入“周费用录入”，其次为教师工作台、学生推荐；其他身份按已有权限显示入口。使用 React、Vite、Tailwind CSS 及本地 shadcn/ui Button/Card，组件来源与许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

## 本地运行

先按项目根 [README](../../README.md) 启动 `dev:demo`。它只使用显式指定的本地合成数据库，每次创建独立 schema；正常停止清理该 schema，不使用真实资料。合成账号由脚本打印，服务默认端口 3100。

```sh
npm run dev --workspace @teaching-research-alliance/web -- --port 5174 --strictPort
```

网页默认代理本机 3100 API。与其他任务并行时，设置 `DEMO_API_ORIGIN=http://127.0.0.1:3114` 指向自己启动的演示服务，避免共享演示资料。网页生产构建使用 `npm run build:web`。

## 浏览器验收

需要本机 Google Chrome、已启动的网页和本项目 `scripts/dev-demo.mjs` 合成演示服务。浏览器测试会写入演示费用和推荐，请使用专用的临时数据库，不能连接真实业务库。首轮使用新启动的演示 schema；同一演示环境可重复运行，测试定位固定合成学生并显式覆盖其累计费用。

```sh
ALLIANCE_SYNTHETIC_E2E=1 ALLIANCE_WEB_URL=http://127.0.0.1:5174 npm run test:browser --workspace @teaching-research-alliance/web
```

测试拒绝非本机网页地址。覆盖首屏顺序、0/空白/非法金额、1000→1200差额余额、已落库但响应丢失的同键重试、保存成功后读取失败、另一写入者造成的版本冲突、推荐创建与发送列表、手机390px宽度、服务端注销后的401、403界面清理及读取失败/真正空期间的区分。403与部分读失败使用明确的HTTP故障注入；其他保存与余额检查通过本地真实API和PostgreSQL。截图保存在 [本次验收证据](../../product-log/evidence/DEV-010-weekly-first)。微信真机和用户验收另行记录。
