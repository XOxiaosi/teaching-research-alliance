# 财务本人采买自动划拨

依据 [PRODUCT F08](../PRODUCT.md#f08提现报销付款与退款申请表4)；实现进度与验证仅在 [PROJECT_LOG](../product-log/PROJECT_LOG.md) 维护。本契约不将全部财务功能标为完成。

## 申请与执行

财务老师切到本人个人入口，建立 SELF_PURCHASE 草稿，填写正数金额、原因，并上传对应业务单据与申请截图。证据齐全且真实任职校验通过后，一次提交同时完成业务 COMPANY 账户扣豆、本人 PERSON 账户加豆及 COMPLETED 状态更新。

资金源由当时有效的总部财务任职与职责资金映射解析；个人收款账户由申请人本人解析。客户端不能指定他人、任意支出账户或收款账户。总部财务的管理视角不能代替个人视角提交；仅有个人入口也不意味着拥有财务任职。

业务账户允许负余额，不套用提现足额限制。处理记录明确为 SYSTEM_RULE，不伪造人工审批人；没有银行卡字段、银行调用或待人工转账步骤。

## 请求与读取

| 操作 | 路径 | 输入或权限 |
|---|---|---|
| 提交 | POST /v1/finance/drafts/:documentId/self-purchase-submit | expectedVersion、amountCents、reason、attachmentVersionIds、idempotencyKey |
| 本人记录 | GET /v1/finance/self-purchases/mine | 本人当前财年 |
| 管理记录 | GET /v1/finance/self-purchases/managed | 严格 GLOBAL 总部财务、管理员、开发者 |
| 单据详情 | GET /v1/finance/self-purchases/:documentId | 本人当前财年或上述管理范围 |

金额用十进制整数分字符串传输。必备附件为 SUPPORTING_DOCUMENT 与 APPLICATION_SCREENSHOT，可附 INVOICE；不能用 PAYMENT_RECEIPT 替代。绑定提交时选定的具体 READY 版本，读取原件校验成功后才能执行。

本人列表按完成时间限定北京时间财年；管理历史保留。成功命令使用相同键与规范化内容重试返回原结果，包括跨财年确认；新提交仍要求当前财年草稿与现任资格。相同键更改内容拒绝，不因重试再次划转。

## 原子性与锁顺序

命令锁和幂等检查后锁定本人草稿；真实任职、职责资金映射和业务主体按既定顺序锁定，再调用统一账本预锁一次取得两侧账户与余额。基金配置与采买共同遵守基金先于结算账户的顺序；不能先扣一侧再锁另一侧。

账本两条分录使用 selfPurchaseExpense、selfPurchaseIncome 分类。账本、两侧余额、不可变执行快照、精确附件绑定、单据状态、系统处理事件和幂等记录在同一事务提交；中途失败全部回滚。费用汇总须将这些分类纳入报销收支后，才能宣称 F11 汇总完整。

0017 增加专用执行与附件绑定表，保留已有提现状态转换。完成单据及执行记录不可直接改写。内部划拨撤销仍是既有需求，另用原单反向账本实现；本包不提供撤销端点，也不改变提现的不可自行撤回规则。
