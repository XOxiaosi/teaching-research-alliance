# 普通报销申请与审核

依据 [PRODUCT F08](../PRODUCT.md#f08提现报销付款与退款申请表4)。执行状态及验证统一见 [PROJECT_LOG](../product-log/PROJECT_LOG.md)。本设计只覆盖申请与人工审核；实际内部划拨与跨财年收入归属依赖 [P09](../product-log/ISSUES.md#p09普通报销跨财年归属)。

## 状态与账户

个人入口创建 REIMBURSEMENT 草稿，提交正数金额、原因、业务单据和申请截图后进入 PENDING_APPROVAL。收款方固定为申请人的 PERSON 账户，由服务端解析；前端不能指定他人账户、支出业务账户或银行卡。

严格 GLOBAL 总部财务可以批准或驳回，得到 APPROVED 或 REJECTED；两者都必须填写原因。管理员、开发者可查看管理记录，本包未提供代替总部财务审核的接口。财务老师本人的普通报销也先从个人身份提交，再切总部财务办理；专门的 SELF_PURCHASE 自动划拨保持独立。

提交、批准、驳回均不生成账本分录、不更改余额。APPROVED 表示人工审核通过，不等于划拨完成；不得据此在个人收入中加豆。本包没有新增审核后撤回、重开或执行接口。

## 接口

| 操作 | 请求 | 输入或范围 |
|---|---|---|
| 提交 | POST /v1/finance/drafts/:documentId/reimbursement-submit | expectedVersion、amountCents、reason、attachmentVersionIds、idempotencyKey |
| 批准 | POST /v1/finance/reimbursements/:documentId/approve | expectedVersion、reason、idempotencyKey |
| 驳回 | POST /v1/finance/reimbursements/:documentId/reject | expectedVersion、reason、idempotencyKey |
| 本人记录 | GET /v1/finance/reimbursements/mine | 本人提交、当前北京时间财年 |
| 管理记录 | GET /v1/finance/reimbursements/managed | 严格GLOBAL总部财务、管理员、开发者 |
| 单据详情 | GET /v1/finance/reimbursements/:documentId | 本人当前财年或上述管理范围 |

金额以十进制整数分字符串传输；所有写请求使用字段白名单。客户端冻结申请、审核决定、角色范围和幂等键；未知结果用原请求重试，成功写入使较早发出的读取结果失效。批准和驳回是不同命令，不能把一份冻结命令切换成另一决定。

## 证据、并发与读取

提交绑定用户选中的精确 READY 原件版本；每个槽只能选一个版本，必有 SUPPORTING_DOCUMENT 和 APPLICATION_SCREENSHOT，可附 INVOICE。服务端校验文件实际字节及元数据，绑定后不能追加或替换。批准再次校验绑定原件；驳回不依赖损坏原件能否打开，以便终止无法通过审核的申请。

操作级命令锁后先核对幂等结果，再锁单据和版本；相同键与内容返回原成功结果，变更内容拒绝。同一单据批准与驳回互斥，状态、决策快照、事件和幂等记录同事务提交，末端失败全部回滚。跨财年原键可以确认原成功结果，新申请仍要求当前财年。

本人记录按 submitted_at 限定当前财年；管理角色可查历史。附件列表与原件读取使用相同业务时间边界，提交草稿创建时间不再替代实际提交时间。读取核对申请、审核身份快照、版本、事件、精确绑定和原件元数据的一致性；异常记录拒绝返回看似正常的详情。详情访问保留审计，不暴露存储路径。

## 迁移与恢复

0020 增加申请、精确附件绑定、人工决策和幂等表，记录不可更新或删除；扩展单据状态约束时保留已有提现与采买转换。0020 不修改历史账本，也不生成资金数据。

已有普通报销状态后不得直接降级到不识别这些状态的程序。优先前向修复，必要时在受控环境恢复匹配的数据库与原件；回退 Git 代码不能视为数据库恢复。
