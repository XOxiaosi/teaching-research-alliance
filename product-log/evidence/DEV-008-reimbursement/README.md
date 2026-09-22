# DEV-008 普通报销申请与审核证据

范围为0020迁移、申请/人工审核/受限读取、精确原件绑定及共享客户端；没有资金执行或普通报销收入入账。阶段状态统一由[开发日志](../../PROJECT_LOG.md)维护，产品语义见[设计契约](../../../docs/REIMBURSEMENT_DESIGN.md)。

所有数据库测试使用本机PostgreSQL16和每测试独立临时schema，账号、资金及原件均为合成资料。HTTP验证监听本地随机端口，原件目录在源码树外，测试结束清理对应临时目录和schema；未触碰真实业务资料或银行。

- [首轮全量PostgreSQL回归](postgres-before-review-fixes.txt)：60/60通过，126.54秒。包括空库迁移、原有提现/采买/结算和新申请/审核/read/HTTP；此结果早于两项审核完整性补强，不冒充补强后的全量重跑。
- [补强后的聚焦复验](postgres-review-final.txt)：审核、受限读取及真实HTTP四项通过，10.02秒。损坏申请事实禁止终态、错误办理人或时间禁止封存；坏原件允许驳回；普通审核余额与账本始终不变。
- [首轮真实HTTP](http-initial.txt)：1/1通过，13.41秒；个人申请、原件实际上传/下载、总部审核、管理员只读、他人拒绝、跨年原键恢复及无账本写入。
- [契约与共享客户端](client-contracts.txt)：46/46通过；独立动作权限、字段白名单、冻结命令、原键重试、401/403清理、早期读取作废和跨会话拒绝。
- [迁移静态检查](migrations.txt)：20项迁移通过。
- [主工作区统一检查](check.txt)：111/111通过，15.18秒；包含同期小程序组件适配测试，源码类型检查覆盖工作区网页与小程序。该结果不替代普通报销网页浏览器及微信真机验收。

独立审查发现并修复：审核前冻结申请事实校验不足；数据库决定封口未绑定实际办理人与时间。主任务还移除未实现的通用审批旧端点，避免与实际普通报销批准/驳回接口冲突。修复期间类型收窄错误与测试共用账户污染均已修正后复验，不属于最终通过状态。

复跑：先运行`npm run build`；为本机合成数据库设置`DATABASE_URL`，执行`npm run test:postgres --workspace @teaching-research-alliance/api`。只复验补强可运行`node --test apps/api/test/integration/postgres-reimbursement-review-live.test.mjs apps/api/test/integration/postgres-reimbursements-read-live.test.mjs apps/api/test/integration/postgres-reimbursements-http-live.test.mjs`。实际内部划拨、跨财年收入P09、网页/微信交互与真实用户验收另行记录。
