# DEV-010 网页提现与周费首屏验证

本包以网页真实可操作为范围：教师默认周费用第一项；个人提现草稿/来源/两类原件/记录；总部财务待转账、回执确认及撤回返还。采用既有 shadcn/ui 基础，无新依赖。所有资料来自独立本地合成数据库，银行账户为测试文本，没有执行银行转账。

## 环境与命令

- macOS / 本机 Chrome，专用 PostgreSQL 16 合成容器 `alliance-weekly-ui-check`，每次演示使用新独立 schema。
- API `127.0.0.1:3114`；最终浏览器在构建预览 `127.0.0.1:5175` 执行，避免并行后端编译触发 Vite HMR 清空浏览器状态。日常网页开发仍为 `127.0.0.1:5174`。
- 原件存放脚本创建的源码树外临时目录，敏感字段密钥仅该演示生命周期内生成一次。
- `npm run check` → [check.txt](check.txt)；`npm run db:check` → [db-check.txt](db-check.txt)；`npm run build:web` → [build-web.txt](build-web.txt)。
- `ALLIANCE_SYNTHETIC_E2E=1 ALLIANCE_WEB_URL=http://127.0.0.1:5175 ALLIANCE_EVIDENCE_DIR=/Users/xiaosi/Developer/active/apps/teaching-research-alliance/product-log/evidence/DEV-010-withdrawal npm run test:browser --workspace @teaching-research-alliance/web` → [browser.txt](browser.txt)。完整套件必须从新演示 schema 执行，提现的真实扣返会改变余额。

## 验证行为

- 既有录费回归：教师默认页面与导航第一项、金额校验、累计更正、差额账务、响应丢失同键重试、保存和刷新区分、实际并发版本冲突、推荐、手机布局、身份失效。
- 新提现：真实 PNG 原件上传；字节已保存但响应丢失后读取 READY 而不重复创建；重新登录恢复附件且需重新填写银行卡；提现结果未知锁定字段和身份、原 key 重试只扣一次；列表仅卡号末四位；390px无横向溢出。
- 总部：真实合成登录、按需完整详情、原件下载、要求线下确认和回执、完成响应丢失后同键重试；另一申请撤回仅返还其原扣款金额；教师只见本人入口。
- 显式故障注入：预留409明确拒绝后解锁文件；余额不足409保留申请文本并提示超出可用金额；原件403清理银行卡和登录状态。故障注入不冒充真实权限撤销或银行行为。
- 独立静态审查发现预留错误死锁、余额不足误当版本变化两项，修复后复核；主验收补充两项浏览器回归。

## 图片

- [教师录费首屏](desktop-weekly-fee.png)
- [手机录费首屏](mobile-weekly-fee.png)
- [个人桌面](personal-desktop.png)
- [个人手机](personal-mobile.png)
- [财务待转账详情](finance-detail.png)

## 限制与失败记录

最初浏览器失败包括支出来源的精确标签缺失、测试 PNG 样本不可读、下载测试误选另一附件和开发服务器 HMR 整页刷新；分别补齐 aria-label、生成可解码 PNG、按文件名定位、改构建预览后重验，没有降低业务断言。

本包不代表 F08 全部完成：同槽附件版本编辑入口、一般报销/付款页面、完整财务字段（如办理人/完成时间）的展示尚待相应契约和界面接入。真实资金、生产环境、微信真机及用户最终验收未执行。截图中的转账确认只是本地合成测试操作。
