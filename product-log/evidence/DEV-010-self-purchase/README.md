# DEV-010 网页财务本人采买与业务账户配置证据

范围对应 PRODUCT F08/F11/F13：保留教师周费首项，新增本人采买、管理只读记录和管理员业务账户配置，个人概览显示报销收入并保留零值隐藏。使用既有 shadcn/ui 和原件上传组件，没有新增依赖。

## 环境与真实行为

专用本地 PostgreSQL 16 容器 `alliance-weekly-ui-check`，API3114每次新建独立19迁移合成schema，网页使用冻结构建预览5175。采用后端新增的合成管理员、兼任教师的HQ账号；没有真实资料、银行调用或部署。原件在源码树外演示临时目录。

1. 管理员通过页面从零创建业务账户，响应丢失后原key重试仅一账户；第一次职责映射expectedAssignmentId=null。真实第二写入者改状态后，原表单409重读并清确认，不自动提交新版本；重新选择后启用成功。
2. 财务切个人视角填写87.65豆、原因、两份真实PNG。提交结果丢失后字段冻结，跨页保持原key，身份切换受阻；重试确认成功但列表读取失败时仍明确“结果已确认”，没有再次划拨。
3. 原件下载比对实际字节；个人概览增加87.65豆并出现报销收入。管理视角只读，无银行卡、二次人工审批或撤销按钮。配置入口仅全局管理员/开发者，HQ实际配置GET被403拒绝；普通老师不显示财务专用入口。
4. 独立只读PG核验源账户余额-8765分，只有一笔COMPANY selfPurchaseExpense -8765及一笔PERSON selfPurchaseIncome +8765，验证允许负余额和不重复划拨。核验脚本数据库直连仅SELECT，API登录/切换/注销会创建和更新合成验证会话，不改业务资金。
5. 资格失效403以及刷新session后移除HQ角色使用显式HTTP故障注入，验证专项提示、旧表单清理，以及仍有教师角色时返回录费首屏；不将故障注入宣称真实任职撤销。

## 输出

最终统一检查100/100、浏览器7/7（1.5分钟）、网页构建714ms、19迁移检查通过；最后一轮后再次执行账本核验，结果一致。聚焦文件为此前两场景验证，最终结果以完整browser.txt为准。

- [统一代码检查](check.txt)
- [网页构建](build-web.txt)
- [迁移静态检查](db-check.txt)
- [采买聚焦浏览器](browser-focused.txt)
- [完整浏览器回归](browser.txt)
- [真实账本只读核验](ledger-readback.json)
- [管理员配置页面](company-funds.png)
- [手机采买表单](purchase-mobile.png)
- [采买完成详情](purchase-completed.png)

复跑：新演示schema启动后，以 `ALLIANCE_SYNTHETIC_E2E=1 ALLIANCE_WEB_URL=http://127.0.0.1:5175 ALLIANCE_EVIDENCE_DIR=/Users/xiaosi/Developer/active/apps/teaching-research-alliance/product-log/evidence/DEV-010-self-purchase npm run test:browser --workspace @teaching-research-alliance/web` 执行；随后设置显式本地 `ALLIANCE_DEMO_DATABASE_URL` 并运行 `apps/web/e2e/read-self-purchase-ledger.mjs`。来源见[网页说明](../../../apps/web/README.md)。本包截图单独保存，不覆盖旧提现/录费证据。

## 审查与边界

个人采买与配置分别由独立Agent实现，第三Agent只读审查未发现P1/P2阻断；主Agent核对类型、真实浏览器、图片及PG证据，并补修刷新任职后原采买页失去入口却停留空页的问题。测试首次提示定位过宽（同页三条finance-notice），改为精确role=alert；完整回归发现旧提现列表选择器同时匹配隐藏采买列表，限定到提现区域。两处均保留业务断言并重跑。

本包不提供采买撤销动作，仅兼容REVERSED只读状态；管理记录已接入授权昵称字段显示申请人；公司配置DTO没有余额字段，界面没有猜测余额。全部验证为合成环境，完整一般报销/付款、真实任职变更、真机、真实用户验收和上线仍未完成。日志由后端主任务统一整合，本证据附件不另维护动态进度。

## 末端校验提示修复

后端任务独立复核手机截图发现：金额从0改为87.65后仍显示旧的金额错误。现将本地校验与服务错误分开，修改字段只清除该字段的本地校验；未知划拨结果和服务拒绝不随输入变更消失。新浏览器断言验证改原因保留金额错误、改金额清除错误，以及未知结果继续提示。手机截图已更新并人工查看，旧错误不再残留。

本次在新合成schema重跑受影响真实采买主场景，1/1通过（总56.6秒）；覆盖原键重试、原件下载、真实版本冲突和报销收入。网页重建1.61秒、网页单独无输出类型检查通过，业务账本再次只读核验一组-8765/+8765。此前完整7/7结果保留，上述修复后没有重复全部7项。

- [修复后采买聚焦验证](browser-validation-fix.txt)
- [修复后网页构建](build-web-validation-fix.txt)
- [修复后类型检查](typecheck-validation-fix-final.txt)
- [修复后账本核验](ledger-validation-fix.json)

类型检查首次使用`--incremental false`与composite项目不兼容而失败，原结果保留在[typecheck-validation-fix.txt](typecheck-validation-fix.txt)；随后改为`npx tsc -p apps/web/tsconfig.json --noEmit --tsBuildInfoFile /tmp/alliance-web-validation-fix.tsbuildinfo`通过，不修改项目配置、不写共享构建产物。浏览器命令在前述完整命令后追加`-- self-purchase.spec.mjs --grep '管理员业务账户'`。
