# 网页端

教师登录后默认进入“周费用录入”，其次为教师工作台、学生推荐、我的提现；其他身份按已有权限显示入口。使用 React、Vite、Tailwind CSS 及本地 shadcn/ui Button/Card，组件来源与许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

## 本地运行

先按项目根 [README](../../README.md) 启动 `dev:demo`。它只使用显式指定的本地合成数据库，每次创建独立 schema；正常停止清理该 schema，不使用真实资料。合成账号由脚本打印，服务默认端口 3100。

```sh
npm run dev --workspace @teaching-research-alliance/web -- --port 5174 --strictPort
```

网页默认代理本机 3100 API。与其他任务并行时，设置 `DEMO_API_ORIGIN=http://127.0.0.1:3114` 指向自己启动的演示服务，避免共享演示资料。网页生产构建使用 `npm run build:web`。

## 浏览器验收

需要本机 Google Chrome、已启动的网页和本项目 `scripts/dev-demo.mjs` 合成演示服务。浏览器测试会写入演示费用、推荐和提现，请使用专用的临时数据库，不能连接真实业务库。每次完整运行都使用新启动的演示 schema，避免前次提现影响期望余额；测试会真实写入合成记录。

```sh
ALLIANCE_SYNTHETIC_E2E=1 ALLIANCE_WEB_URL=http://127.0.0.1:5174 npm run test:browser --workspace @teaching-research-alliance/web
```

测试拒绝非本机网页地址。覆盖首屏顺序、0/空白/非法金额、1000→1200差额余额、已落库但响应丢失的同键重试、保存成功后读取失败、另一写入者造成的版本冲突、推荐创建与发送列表、手机390px宽度、服务端注销后的401、403界面清理及读取失败/真正空期间的区分。403与部分读失败使用明确的HTTP故障注入；其他保存与余额检查通过本地真实API和PostgreSQL。截图保存在 [本次验收证据](../../product-log/evidence/DEV-010-weekly-first)。微信真机和用户验收另行记录。

## 提现页面

个人入口提供个人/具体场地来源、申请草稿、业务单据与申请截图上传和恢复、提现记录及按需收款详情。总部财务 GLOBAL 身份提供待转账/历史、受限原件下载、付款回执、线下转账确认及财务撤回。提交、办理和上传遇到结果不确定时保留原请求安全重试；身份切换前先确认这些操作。银行卡只在本次表单和按需详情中显示，不保存到本地存储。

完整浏览器套件还覆盖真实附件、刷新恢复、提交及确认回执丢失、扣豆/返还、列表脱敏、未授权入口隐藏和390px布局。预留明确拒绝与余额不足提示使用显式HTTP故障注入，其他上述流程调用真实本地API；银行字段均为合成测试文本，未调用银行。下载与截图证据见[提现验收](../../product-log/evidence/DEV-010-withdrawal/README.md)。

本包未提供同一附件槽的新版本编辑入口、全部报销/付款页面或真实资金流程；上传新原件会保留旧原件，不覆盖。演示附件存放在脚本创建的源码树外临时目录，随该演示生命周期清理。

并行开发验收可先构建，再在 apps/web 运行 `DEMO_API_ORIGIN=http://127.0.0.1:3114 npx vite preview --host 127.0.0.1 --port 5175 --strictPort`，将 `ALLIANCE_WEB_URL` 指向5175。使用 `ALLIANCE_EVIDENCE_DIR` 指定本次录费回归截图目录，避免覆盖旧检查点证据。
