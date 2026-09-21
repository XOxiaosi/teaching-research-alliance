# DEV-010 网页周费用优先验收证据

2026-09-21，独立本地合成数据库，API 3114，网页 5174，真实 Chrome。此目录是固定证据附件，当前执行状态只维护在 [PROJECT_LOG](../../PROJECT_LOG.md)。

- [基础检查](check.txt)：本次工作区 TypeScript 构建及60项测试通过。
- [迁移静态检查](db-check.txt)：10个迁移通过；前端包不据此宣称重跑了全部数据库集成。
- [网页生产构建](build-web.txt)：通过。
- [浏览器测试](browser.txt)：2项端到端场景通过；每项包含多步行为断言。
- [小程序开发构建](build-miniapp.txt)：仅验证共享依赖兼容，不等于开发工具或真机通过。
- [桌面周费页面](desktop-weekly-fee.png)、[手机周费页面](mobile-weekly-fee.png)、[教师工作台](desktop-workspace.png)、[推荐页面](desktop-referrals.png)。全部为合成资料。

自动化源码：[weekly-fee.spec.mjs](../../../apps/web/e2e/weekly-fee.spec.mjs)。运行方法：[网页说明](../../../apps/web/README.md)。

真实API行为：0豆、空白/负数/多小数拒绝、累计1000→1200且余额720→864、服务器已成功但响应丢失后同键重试、另一写入者导致409、推荐创建与本人列表、注销后401。故障注入：保存后个人概览读取失败、HTTP403、首次期间读取失败与成功返回空列表。手机验收是390px浏览器视口，不是微信真机。

独立审查两项有效问题（旧余额误显示、缺少保存版本凭证）已修复，版本基线由选择记录时捕获。最终已验证结果来自主Agent实跑，不以子Agent自报或历史check作为本次证据。
