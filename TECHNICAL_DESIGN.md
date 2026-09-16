# 教研联盟管理平台｜技术设计说明

## 1. 文档职责与设计边界

本文说明如何实现 [PRODUCT.md](PRODUCT.md) 中 F01–F14，是开发前的技术基线，不代表功能已开发、部署或验收。产品语义、计算口径与待决定事项仍以 PRODUCT 为唯一事实源；本文只在已确认边界内选择实现方案。执行进度与验证证据统一记录在 [PROJECT_LOG.md](PROJECT_LOG.md)。

已确认的终端边界：主要平台为**微信小程序**，同时提供手机浏览器和电脑浏览器使用的响应式网页看板。三个终端共享后端、权限、计算和结算结果，不在客户端复制结算规则。

本设计坚持以下边界：

- 采用 TypeScript 模块化单体和一个 PostgreSQL 主数据库，先保证财务口径、事务和审计一致；当前规模和需求没有支持微服务拆分的证据。
- 原始业务记录、派生结算状态和用户视图分层保存。原始事件不因重算或更正被覆盖；已结算明细不原地修改。
- 业务主键使用不可变 UUID。老师昵称继续满足产品要求的唯一性，但数据库关系一律引用 UUID，避免昵称改名破坏历史。
- 表1–表8是业务视图和 Excel 工作表概念，不直接等同于八张数据库表。
- Excel 是管理端可读、可下载的完整业务数据备份。D20 已确认本期**不需要 Excel 导入**；数据库灾难恢复另用数据库备份，二者不能互相冒充。
- 本轮不接真实支付、提现或对外付款接口。最终产品是记录线下处理结果还是连接支付渠道，仍由 D16 决定；技术设计不提前限定。

## 2. 技术方案

### 2.1 代码结构

采用 TypeScript monorepo，建议按以下边界组织：

```text
apps/
  miniapp/        Taro + React，微信小程序
  web/            React 响应式网页看板（手机/电脑共用）
  api/            NestJS REST API，模块化单体
  worker/         导出及按最终业务口径受控执行的月度计算任务
packages/
  api-contracts/  OpenAPI 生成的请求/响应类型与错误码
  domain/         纯计算函数、状态约束、金额与费率值对象
  ui-tokens/      颜色、间距、字体等共享设计令牌
  test-fixtures/  仅含合成数据的测试样例
database/
  migrations/     前向数据库迁移
  seeds/          本地/测试环境合成数据
docs/
```

小程序和网页可以复用 API 类型、校验模型和无平台依赖的展示逻辑，但分别维护页面组件。Taro 遵循小程序的组件、API 和路由规范，并支持 React；这适合微信小程序主端。网页看板使用标准 React DOM，以免桌面表格、键盘操作和大屏布局受小程序组件限制。两端共享代码不以牺牲各终端体验为代价。

微信小程序承接 F01–F12 中各角色获准使用的业务能力，不因技术选型删减。网页端明确承接管理员配置、权限、报表和 Excel 备份，以及普通用户的响应式看板；普通用户是否在网页完成全部写操作受 D22，接口和权限模型可以复用，但不在未确认前扩大网页产品范围。

### 2.2 运行组件

| 组件 | 职责 | 关键约束 |
|---|---|---|
| 微信小程序 | 登录、角色选择、个人业务、移动审批、个人看板 | 不保存结算真值；每次写入都调用 API |
| 响应式网页 | 手机/电脑看板、管理配置、大表格、Excel 备份 | 手机与电脑为同一 Web 应用的响应式布局 |
| API | 身份、权限、业务写入、查询、结算编排、审计 | 服务端校验范围；客户端角色/金额均不可信 |
| Worker | 异步 Excel、月度试算/结算、重试任务 | 与 API 复用 domain；从事务型任务表取任务 |
| PostgreSQL | 唯一业务真源、事务、约束、审计、任务队列 | 金额使用精确十进制，不使用浮点数 |
| 私有文件存储 | Excel 文件、可选附件、备份产物 | 本地开发使用临时私有目录；生产对象存储、保留期和费用受 D21/部署决定 |

首版不引入独立消息队列、搜索引擎或数据仓库。后台任务存入 PostgreSQL `job` 表，worker 使用行锁领取；实际负载证明不足时不增加额外基础设施。

### 2.3 后端业务模块

单个 API 部署单元内保持清晰模块边界：

1. `auth`：手机号密码登录、管理员重置、会话、角色切换。
2. `identity-org`：老师、角色、校区、分区、教研组和归属关系。
3. `referral-student`：学生、生源推荐、接收与业务状态事件。
4. `weekly-fee`：按周课时费原始记录和确认/作废事件。
5. `rate-policy`：基础费率、抬升区间、封顶、绩效分润版本。
6. `calculation-settlement`：试算、结算快照、分配明细、调整和月/年视图。
7. `finance-document`：提现、报销、付款申请、有效性、审批和入账。
8. `compensation`：工资、奖金、医社保及项目扣费。
9. `reporting`：角色看板、表1–表8视图、范围查询。
10. `export-backup`：Excel 快照任务、清单、文件和下载授权。
11. `audit`：追加式操作日志、请求追踪和安全审计。

模块之间通过应用服务调用和数据库外键协作，不直接让控制器跨模块写表。结算模块只消费已确认输入和已发布配置版本。

## 3. F01–F14 实现映射

| 功能 | 实现模块 | 主要写模型 | 用户读取视图 |
|---|---|---|---|
| F01 登录、角色、权限 | `auth`、`identity-org` | `user_account`、`role_assignment`、`session` | `my_roles`、授权后的角色主页 |
| F02 教师资料与归属（表1） | `identity-org` | `person`、`teacher_profile`、`organization_unit`、`person_relationship` | `v_table1_teacher` |
| F03 生源、接收、课时费（表2） | `referral-student`、`weekly-fee` | `student`、`referral_case`、状态事件、`weekly_fee_entry` | `v_table2_practice` |
| F04 动态费率 | `rate-policy`、`calculation-settlement` | `rate_policy_version`、`rate_tier` | 生效版本和月度试算说明 |
| F05 绩效配置（表8） | `rate-policy` | `split_policy_version`、`split_policy_rate` | `v_table8_split_config` |
| F06 单笔分配 | `calculation-settlement` | `calculation_run`、`allocation_line` | 单笔分配明细和公式输入快照 |
| F07 月度汇总（表3） | `calculation-settlement`、`reporting` | `settlement_period`、`ledger_entry` | `v_table3_monthly_income` |
| F08 财务单据（表4） | `finance-document` | `finance_document`、状态事件、入账记录 | `v_table4_finance_document` |
| F09 工资奖金（表5） | `compensation` | `compensation_item_definition`、`compensation_entry` | `v_table5_payroll_bonus` |
| F10 扣费（表6） | `compensation` | 同上，类别为扣费 | `v_table6_deduction` |
| F11 最终结算（表7） | `calculation-settlement`、`reporting` | 不可变 `ledger_entry`、结算快照 | `v_table7_balance`、年汇总 |
| F12 管理与报表 | 全部业务模块、`reporting` | 配置版本、审计记录 | 管理网页和范围内报表 |
| F13 微信小程序与手机/电脑网页 | `miniapp`、`web`、统一 API | 不新增业务真源 | 各角色移动页、响应式看板 |
| F14 Excel 完整业务备份 | `export-backup`、`worker` | `export_job`、`export_artifact` | 管理端导出任务、校验清单与下载 |

## 4. 身份、角色与服务端数据范围

### 4.1 身份模型

- `person.id`：不可变 UUID，所有业务外键使用它。
- `person.nickname`：产品要求的唯一业务昵称，数据库设唯一约束；是否允许改名受 D15 决定。即使允许，历史关系仍引用 UUID，并在结算快照保存当时昵称。
- `user_account.phone`：规范化后唯一；密码保存为自适应加盐哈希，绝不保存明文。管理员重置密码后撤销既有会话。
- 微信小程序只是主要客户端，现阶段登录仍按 PRODUCT 使用手机号和密码。微信 `openid` 不是人员真源；未来如需微信账号绑定，作为可撤销的辅助身份另表保存。
- 会话使用短期访问令牌和可撤销刷新会话。网页刷新凭据放入 `HttpOnly`、`Secure`、合适 `SameSite` 的 Cookie，写请求配置 CSRF 防护，并用明确 CORS allowlist 限制来源。小程序只按平台能力保存完成会话所需的最小短期凭据，不声称平台本地存储具备硬件级或应用自带加密保障；敏感长期秘密不落客户端。日志不得记录密码、完整令牌或银行卡号。

### 4.2 角色与范围

采用 RBAC + 数据范围：`role_assignment(person_id, role_code, scope_type, scope_id, valid_from, valid_to)`。`scope_type` 支持 `SELF`、`GROUP`、`CAMPUS`、`REGION`、`GLOBAL`。D08/D15 未关闭前，不自行决定教研组长、指导导师的分配方式或多角色范围合并规则；数据库模型可承载，但相关授权规则保持不可启用。

每个 API 同时校验：

1. 会话是否有效；
2. 当前选择角色是否属于该人员；
3. 该角色是否拥有资源动作权限；
4. 目标行是否处于授权数据范围；
5. 操作是否满足业务状态与乐观锁版本。

角色切换只改变当前会话上下文和界面导航，不扩大账号已经拥有的授权。查询必须由服务端拼入范围条件；隐藏按钮不是权限控制。导出任务再次按服务端权限和范围构造快照，不能接收客户端传入的任意人员 ID 列表。

## 5. 数据模型与表1–表8映射

### 5.1 通用字段和类型

所有可变主记录包含 `id uuid`、`version bigint`、`created_at timestamptz`、`created_by uuid`、`updated_at timestamptz`、`updated_by uuid`。并发更新使用 `WHERE id = :id AND version = :expectedVersion`，成功后版本加一。

- 金额原始值、计算中间值和入账值均使用 PostgreSQL `numeric`，禁止 JavaScript `number` 承担财务计算。建议原始/入账金额 `numeric(20,6)`、费率 `numeric(12,9)`、中间计算 `numeric(38,18)`。这是存储精度选择，不替代 D12 尚未确认的业务舍入、展示位数和尾差归属。
- 月份保存为月初 `date`，周区间保存 `date` 起止值，时间点保存带时区时间；业务时区必须在部署前固定。
- 角色、状态、类型使用受约束代码值；中文文案仅为展示层，不作为关联键。
- 真实姓名、手机号、学生姓名、银行卡和发票信息按敏感字段分级；银行卡号加密保存并按权限脱敏展示。

### 5.2 表1：教师信息

| 实体 | 关键字段 | 约束/关系 |
|---|---|---|
| `person` | `id`、`nickname`、`legal_name`、`status` | `nickname` 唯一，ID 不可变 |
| `user_account` | `person_id`、`phone_normalized`、`password_hash` | 一人一个账号；手机号唯一 |
| `teacher_profile` | `person_id`、`primary_role`、`grade_subject`、`campus_id` | 教师角色时年段学科条件必填；主要角色受产品枚举约束 |
| `role_assignment` | `person_id`、`role_code`、范围、有效期 | 同角色同范围有效期不得重叠 |
| `organization_unit` | `id`、`type`、`name`、`parent_id` | 承载公司/分区/校区/教研组；具体层级受 D01 |
| `person_relationship` | `subject_id`、`kind`、`target_person_id`、有效期 | 承载组长、导师、场地、平台财务、分区财务、咨询平台费账号 |

归属关系用有效期版本化，历史结算从快照读取当时对象，不能因人员后续调岗改变旧结算。咨询平台费账户遵循 F02 已确认规则：主要角色为学业规划时必须指定有效人员；其他角色留空时默认该人员本人。计算咨询平台收入时，解析输出方的这项关系，不能把已明确默认规则的空值当作缺失收款对象。

### 5.3 表2：生源记录与周课时费分离

原需求把学生、生源关系和每周费用放在一行。实现必须拆开：

- `student`：`id`、`display_name`、必要敏感字段；不使用姓名作为唯一键。
- `referral_case`：`student_id`、`receiver_id`、`referrer_id`、当前 `class_type`、`location`、`referrer_campus_snapshot_id`（表2“输出方校区”）、`business_status`、`acceptance_status`。若业务以后还需记录接收方校区，另用 `receiver_campus_id`，不能与输出方校区混用。
- `referral_case_event`：追加保存推送、接收、拒绝、浇灌、完结等原始状态事件，含操作人、时间、原因和请求 ID。
- `weekly_fee_entry`：`referral_case_id`、`week_start`、`week_end`、`settlement_month`、`gross_amount`、`class_type_snapshot`、`consultation_rate_input`（该笔手填 Q）、`collection_account_id_snapshot`、`referrer_campus_id_snapshot`、`source_case_version`、`entry_status`、`version`，每周一条。建议唯一约束为 `referral_case_id + week_start + week_end + active_revision`，最终规则受 D13/D14。逐笔输入和源版本在确认时冻结，不能因生源主记录以后修改而污染历史计算。
- `weekly_fee_event`：追加保存创建、确认、更正、作废及更正原因。

收费账号留空时默认接收方。收费账号不等于接收方时，沿用原文“线下处理、系统仅记录”：仍记录各方应收分配，不自动向任何账号划款，也不把整笔 F 当作收费账号的绩效收入。

这样一个学生可跨周、跨月产生多条课时费，生源状态与金额流水互不覆盖。D13 尚未确认的自动生成、完结周、退费、删除和重复规则不能由定时任务猜测；相关入口在规则确认前只允许安全的草稿记录与显式确认。

### 5.4 表8及费率版本

`rate_policy_version` 保存政策版本、有效期、基础费率、上限、状态和创建依据；`rate_tier` 保存上下界、包含方向、抬升比例和是否执行。发布前执行区间检查：重叠、缺口、反向边界或未执行范围均生成阻塞错误。D06/D07/D18 未关闭时，系统可以保存原始配置和进行标注，但不得对受影响月份执行最终结算。

`split_policy_version` 以接收方为对象，保存版本、有效期、默认/个别来源、操作人；`split_policy_rate` 保存六个分润角色的比例。表8新配置仅影响之后新产生的表2记录：在对应源记录创建事件中冻结版本 ID 和六项比例，无个性配置时保存默认六比例及其来源。拆分后的 weekly_fee_entry 必须持有该快照，试算只读取已冻结版本，不能按首次试算时的当前配置取值。表2拆分后“新记录”对应生源还是每周费用事件仍按 D13/D14 明确；在决定前不得对旧流水套用新配置。修改配置只产生新版本，不覆盖旧版本。

### 5.5 表3、表7及不可变结算明细

计算与结算采用以下模型：

- `settlement_period`：月份、内部状态 `DRAFT | SETTLED`、版本、结算人和结算时间。该状态是技术工作流，不替代 PRODUCT 的对外业务状态。
- `calculation_run`：月份、接收方、输入快照哈希、算法版本、费率版本、状态 `RUNNING | SUCCEEDED | FAILED | SUPERSEDED`、错误。草稿期允许新 run 替代旧 run，但旧 run 仍保留审计。
- `allocation_line`：关联 run 和周费用，保存 F、净课时费、基础费率、抬升、最终费率、Q、六项分润比例、收款对象快照、分配类型和精确金额。
- `ledger_entry`：结算时由成功 run 产生的不可变入账明细，含月份、账户、方向、类型、金额、来源实体、来源行、`reversal_of`。表3和表7只从已入账 ledger 派生。
- `monthly_statement`：按人员 + 月份的可重建投影；数据库唯一约束为 `person_id + settlement_month`。年查询从月度明细聚合，不另存容易漂移的“全年真值”。

内部流程：

```text
原始业务事件 -> 草稿周费用 -> 月度试算 run -> 人工/规则校验
             -> 月份结算 -> 不可变 allocation/ledger -> 表3/表7视图
             -> 发现错误 -> 新调整单 + 冲销/补差 ledger -> 新视图
```

已结算月份不重写原分配行。更正通过 `adjustment` 和正反向 ledger 追加完成，保留 `adjustment_of`、原因、操作者和审批依据。D14 未确认关账、重算和跨月调整前，最终结算动作不得开放为生产可用。

### 5.6 表4：有效性、审批与入账分离

`finance_document` 保存单据类型、申请人、加余额人员、支出账户人员、金额、收款资料、发票号及版本；`finance_document_event` 追加保存提交、审批、拒绝、完成和撤销行为。

必须分开三个概念：

- `data_validity`：字段和引用是否满足当前产品规则，值为 `VALID | INVALID | UNRESOLVED`。
- `approval_status`：沿用产品的待审核、已通过、已拒绝、已完成。
- `posting_status`：技术状态 `UNPOSTED | POSTED | REVERSED`，表示是否已产生 ledger。

数据有效不等于审批通过，审批通过也不自动等于已经计入余额。D09/D10 决定具体计入条件后，由独立 posting policy 执行一次性入账；在此之前不自行把任一审批状态计入表7。真实资金是否在线下处理、是否需要渠道对接及回执来源，按 D16 的后续决定设计。

### 5.7 表5、表6：稳定项目 ID 与可改显示名

`compensation_item_definition` 保存 `id`、`category`（奖金/扣费）、稳定槽位 1–10、显示名称和有效期；`compensation_entry` 保存人员、月份、项目 ID、金额、来源和版本。名称变化只生成新名称版本，历史记录保存当时显示名快照。

网页端提供右键菜单，微信小程序和手机网页提供长按或“更多”菜单；具体交互受 D17，但后端接口相同。工资、医社保、奖金和扣费均按人 + 月份保存，不把多个自然月覆盖在同一字段。

### 5.8 原始记录、派生状态和用户视图

| 层次 | 示例 | 修改规则 |
|---|---|---|
| 原始记录/事件 | 生源状态事件、周费用事件、配置版本、审批事件、补差原因 | 追加保存；错误通过作废/冲销事件更正 |
| 派生状态 | 当前生源状态、最新配置、试算 run、月度 statement | 可从事件和不可变明细重建；带版本和来源游标 |
| 用户视图 | 表1–表8、个人看板、校区/分区看板、Excel | 只读组合；按权限和快照时间生成 |

Excel 导出和看板都是数据库在指定快照下的用户视图，不能反向成为数据库真源。D20 已确认本期不提供 Excel 导入入口、接口或后台任务。

## 6. 计算、幂等与并发

### 6.1 计算流程

1. 读取某接收方、某月已经确认且符合 D13/D14 范围的周费用。
2. 按 D18 最终口径计算净课时费；若口径或数据范围未决，返回阻塞错误，不给出猜测结果。
3. 选择覆盖该业务时点的基础费率和抬升政策版本；检测区间唯一命中。
4. 读取源记录产生时已冻结的表8版本及六比例；其他费率与人员归属的时点按 D14 最终规则取快照。新配置不得因旧流水首次试算较晚而覆盖其旧比例。
5. 用精确十进制计算全部份额，校验总比例、缺失收款对象及负剩余。
6. 生成试算明细、输入哈希和核对总额。舍入/尾差按 D12 最终决定执行。
7. 结算时锁定月份与相关输入，重新核验输入哈希；一致后原子写入不可变明细、ledger、审计和投影失效标记。

任何 D06、D09–D14、D18 所涉数据无法唯一解释时，试算返回明确错误，例如 `RATE_TIER_UNRESOLVED`、`PAYEE_UNRESOLVED`、`ROUNDING_POLICY_UNRESOLVED`，不能默认为 0 或静默跳过。

### 6.2 幂等

所有写 API 要求客户端生成 UUID `requestId`。数据库 `idempotency_record` 以 `actor_id + operation + request_id` 唯一，保存请求摘要、结果状态和响应摘要：

- 相同 requestId + 相同请求重试：返回原结果，`outcome=REPLAYED`。
- 相同 requestId + 不同请求体：返回 `IDEMPOTENCY_CONFLICT`。
- 后台 job 使用业务唯一键，例如 `export:{scope}:{snapshot}:{templateVersion}` 或 `settle:{month}:{inputHash}`。
- ledger 使用 `source_type + source_id + source_line_key + entry_kind` 唯一，避免重复入账。

### 6.3 并发和事务

- 普通编辑用 `version` 乐观锁，版本不一致返回 409 `VERSION_CONFLICT` 和服务器当前版本。
- 接收学生、确认周费用、审批和发布配置在一个事务内写主记录、事件和审计。
- 月份结算使用 `SERIALIZABLE` 事务，并对 `settlement_period` 执行行锁；捕获序列化失败后按有限次数、随机退避重试，仍失败则安全退出。
- 同一月份的多个结算请求只能有一个成功；唯一约束与输入哈希是最终防线。
- Excel 任务领取使用 `FOR UPDATE SKIP LOCKED`，失败记录错误和重试次数，超过阈值进入人工处理，不丢失 job。
- 所有外部文件写入采用“临时对象 -> 校验和 -> 原子发布元数据”；数据库事务不假装与对象存储形成分布式事务。

## 7. API 契约

API 使用 `/api/v1` REST + JSON，并由 OpenAPI 文件作为客户端和服务端的共同契约。列表统一使用游标分页；金额和费率在 JSON 中使用十进制字符串，防止客户端浮点误差。

### 7.1 写请求与响应

```json
{
  "requestId": "uuid",
  "version": 3,
  "data": {
    "...": "业务字段"
  }
}
```

```json
{
  "requestId": "uuid",
  "outcome": "SUCCEEDED",
  "data": {
    "id": "uuid",
    "version": 4,
    "updatedAt": "2026-09-16T12:00:00Z"
  },
  "errors": []
}
```

`outcome` 统一为 `SUCCEEDED | REPLAYED | REJECTED`。错误结构如下：

```json
{
  "code": "VERSION_CONFLICT",
  "message": "记录已被其他操作更新，请刷新后重试",
  "field": null,
  "retryable": false,
  "details": {
    "currentVersion": 4
  }
}
```

`message` 可本地化，客户端逻辑只依赖稳定 `code`。主要状态码：400 字段校验，401 未登录，403 无权限/超范围，404 不存在，409 版本或幂等冲突，422 业务规则未满足，429 限流，500 未预期错误。500 响应不暴露堆栈、SQL 或敏感字段。

### 7.2 主要资源

| 路径 | 用途 |
|---|---|
| `/auth/login`、`/auth/refresh`、`/auth/select-role` | 登录、刷新、角色切换 |
| `/people`、`/organizations`、`/role-assignments` | 表1和范围配置 |
| `/referrals`、`/referrals/{id}/events` | 生源推送、接收、拒绝、完结 |
| `/weekly-fees`、`/weekly-fees/{id}/confirm` | 周课时费草稿和确认 |
| `/rate-policies`、`/split-policies` | 费率和表8版本配置 |
| `/calculations/preview`、`/settlements/{month}` | 试算、结算、调整 |
| `/finance-documents`、`/{id}/approve`、`/{id}/complete` | 表4工作流 |
| `/compensation-items`、`/compensation-entries` | 表5、表6 |
| `/reports/table1`…`/reports/table8` | 权限过滤后的报表视图 |
| `/exports`、`/exports/{id}`、`/exports/{id}/download` | Excel 导出任务、状态和限时下载 |
| `/sync/changes?cursor=...` | 跨端增量刷新 |

具体字段由 OpenAPI schema 定义；所有管理写接口都记录 before/after 摘要和操作者。敏感字段在响应 schema 中按权限分型，不能先全量返回再由前端隐藏。

## 8. 三端刷新、失败恢复与离线边界

首版采用“服务端真值 + 前台缓存”：

- 每次写成功返回新 `version` 和 `updatedAt`，客户端立即用服务端结果替换本地缓存。
- 页面进入、微信小程序 `onShow`、浏览器重新聚焦和网络恢复时调用增量同步；游标失效则重新拉取当前范围。
- 看板前台可短间隔轮询变化游标；首版不依赖 WebSocket。结算和导出等长任务按 job ID 查询状态。
- 草稿表单可本地暂存，但提交必须重新做服务端权限、版本和业务校验。财务写操作不支持离线自动排队，避免恢复网络时重复入账。
- 客户端超时后使用同一 `requestId` 查询或重试，不能生成新 ID 猜测第一次是否成功。
- 401 时只允许一次刷新会话重试；版本冲突显示服务器当前值和用户草稿，要求用户明确重新提交。

## 9. Excel 业务备份与数据库灾备边界

完整字段、工作簿、权限、脱敏、命名和验收契约见 [docs/EXCEL_BACKUP_SPEC.md](docs/EXCEL_BACKUP_SPEC.md)。本文只定义系统实现边界。

### 9.1 一致性快照与任务

1. 管理员创建导出任务，API 记录请求人、授权范围和导出类型；此时不把不同时间的查询结果当成快照。
2. worker 领取任务后启动只读 `REPEATABLE READ` 快照事务，记录 `as_of`、数据库快照标识、筛选条件、schema/generator 版本和数据水位。单连接用服务端游标流式读取；若压测证明需要多连接，则由保持打开的协调事务导出 snapshot，所有读取连接在查询前导入同一 snapshot。
3. worker 从同一逻辑快照读取表1–表8、原始流水、配置版本、结算明细、调整和审计清单。大数据量分批和跨工作簿拆分仍须保持相同快照，不能让各 sheet 看到不同时间点。
4. 生成 Excel 临时文件，执行 sheet/分片、行数、稳定排序、引用、金额核对、长文本重组和业务文本字符串类型与公式注入检查，计算每个文件的 SHA-256 和数据集逻辑摘要。
5. 生成 `package-manifest.json`，列出整个文件组的必备分片、文件大小、SHA-256、逻辑摘要和完成状态；文件组写入私有存储后，原子更新 `export_artifact` 为可下载。
6. `export_job` 记录请求人、权限范围、快照时间、schema/generator 版本、行数、各表金额总计、校验和、业务异常状态、任务状态、错误和文件到期时间；`audit_event` 记录创建、失败、下载、撤销与清理。

源数据存在业务异常、配置缺失或待决定口径时，完整备份仍须原样导出，并在 manifest/异常清单中逐项标注，不能因为业务数据“不好看”而拒绝备份。只有无法取得一致快照、授权失败、复制不完整、文件/清单生成失败或校验和不一致，任务才标记失败。失败不得留下“成功”文件；重试沿用同一 job 或产生显式 attempt。Excel 中的密码哈希、会话、内部密钥永不导出；设计按管理员获准导出的手机号、银行卡、开户行、户名和发票号原始文本保真；真实敏感字段的授权范围仍须按 D16 确定，下载全程受控和审计，其他报表仍按权限脱敏。附件原件的配套归档和保留方式受 D21，manifest 必须如实说明是否包含附件原件。

### 9.2 与数据库灾备的分工

- **Excel 业务备份**：用于管理员下载、人工核查、移交和业务数据留存；不包含密码哈希、会话、令牌、密钥、数据库角色、索引物理状态或基础设施配置。本期没有 Excel 导入能力。
- **系统灾难恢复**：数据库 schema、约束、审计、幂等记录、认证数据和全部系统关系使用加密 `pg_dump`/物理备份与对象存储备份恢复。Excel 不能替代它。

数据库灾备属于生产部署的基础安全前置，需要用合成数据在隔离环境验收，并在上线前明确 RPO、RTO、保留期、密钥托管和恢复责任人；它不是本轮新增的 Excel 功能，也不代表已经授权购买存储、部署服务或执行真实生产恢复。

## 10. 审计、安全与隐私

- `audit_event` 追加保存操作者、当前角色、数据范围、动作、资源 ID、请求 ID、结果、时间、IP/设备摘要和变更字段摘要；财务记录不得硬删除。
- 敏感字段日志默认遮蔽；银行卡只显示尾号，完整值使用应用层信封加密，密钥与数据库分离。
- 所有线上通信使用 HTTPS；生产密钥通过专用秘密管理注入，不进入 Git、镜像或 Excel。
- 管理端导出、全局查询、费率发布、结算和调整属于高风险动作，要求重新校验会话并留下不可变审计。
- 数据保留与删除规则尚未在产品中确认；实现先支持逻辑停用、访问收回和法定保留标记，不擅自物理删除教育和财务原始记录。

## 11. 迁移、回滚与失败处理

### 11.1 数据初始化与范围

D20 已确定本阶段不提供 Excel 导入，也不安排历史表格批量接入。开发及验证使用隔离环境中的合成种子数据，正式业务记录通过已授权的业务操作产生。本节的数据库迁移仅指应用升级时的结构演进和内部数据回填，不是面向用户的数据导入功能。

### 11.2 Schema 与应用回滚

数据库迁移采用 expand/migrate/contract：先增加兼容结构，再回填和双读核验，最后在后续版本移除旧结构。应用代码可以回滚到兼容版本；已经入账的数据不能靠 Git 或 schema 回滚撤销，必须用业务冲销/调整。

迁移失败时事务回滚；长回填任务保存游标并可重复执行。发布后发现计算错误时立即停止受影响月份结算，保留原始输入，修复算法后生成新 run 和差异报告，已结算数据走冲销调整。

## 12. 测试与交付门禁

### Gate A：产品口径可执行

- F04/F06/F08/F11 的每个计算分支都能追溯到 PRODUCT 已确认条款。
- D06–D18 中会改变计算或入账结果的项目未关闭时，相应最终结算测试必须标为阻塞，不能用假设制造通过。
- D20 已确认不需要 Excel 导入；F14 只验收一致快照、完整导出、校验清单和受控下载。

### Gate B：领域与数据库

- 费率区间边界、16%封顶、比例上限、缺失收款对象、正负金额和跨月案例有确定性测试。
- 属性测试验证每笔分配在既定舍入规则下守恒、剩余不为负；D12 决定前只验证高精度中间值，不能宣称尾差已解决。
- PostgreSQL 集成测试覆盖外键、唯一约束、版本冲突、重复 requestId、并发结算、序列化重试和不可变 ledger。
- 审批有效性、审批状态和 posting 状态分别测试，证明拒绝/重复请求不会重复入账。

### Gate C：API 与权限

- OpenAPI schema 校验，miniapp/web 使用生成类型完成契约测试。
- 每个角色覆盖允许、禁止和越范围三类测试；证明直接调用 API 也无法绕过范围。
- 敏感字段脱敏、日志清洗、会话撤销和管理员重置密码通过安全测试。

### Gate D：终端体验

- 微信开发者工具和至少一台真实手机验证登录、角色切换、生源接收、费用查看、审批和网络恢复。
- 手机网页验证触屏交互；电脑网页验证大表格、键盘/鼠标、筛选和下载。
- 同一账号跨端写入后刷新，三端显示同一版本和结算结果。

### Gate E：Excel、迁移与恢复

- 按 Excel 规范验证 sheet、字段、行数、主外键、金额总计、快照时间、脱敏和 SHA-256。
- 使用含源数据异常、配置缺失、零值、停用、作废、历史版本和并发写入的合成数据导出；原数据全部保留，异常进入 manifest，不能因业务异常让备份失败。
- 验证只有快照取得、授权、复制完整性、文件生成或校验和失败才使任务失败；失败产物不能显示为完整备份。
- 在空数据库完成一次合成 `pg_dump` 恢复演练；恢复后重跑数据库和结算不变量。

任一必须 Gate 失败，不得标记为已交付或可上线。真实数据、真实支付和部署验收不能由模拟数据替代。

## 13. 分阶段技术依赖

这是依赖顺序，不是进度状态表：

1. **契约闭合**：关闭会改变计算、权限、入账和恢复行为的 D 项；确定 OpenAPI、错误码、业务时区和 Excel 契约。
2. **工程基础**：建立 monorepo、CI、PostgreSQL 迁移、身份、组织范围、审计和合成数据。
3. **原始业务流**：完成教师、生源、接收、周费用与配置版本；此阶段不开放最终结算。
4. **计算结算**：在 D06/D07/D11–D14/D18 闭合后实现试算、快照、不可变明细、ledger、月/年视图。
5. **财务调整**：在 D09/D10/D16 闭合后实现单据 posting、工资、奖金和扣费。
6. **多端与备份**：完成微信小程序、响应式网页、Excel 完整导出任务、跨端刷新和设备验证。
7. **迁移与上线准备**：Excel 导出验收和数据库灾备演练通过后，才申请真实资料、生产资源、部署和真实验收授权。

并行边界：miniapp/web 可在稳定 OpenAPI 下并行；身份组织、生源周费用、Excel 生成器可分模块并行；结算依赖费率、人员归属和周费用契约稳定；表7依赖 ledger；生产上线依赖全部前序 Gate。同一 schema 迁移和 OpenAPI 文件同一阶段只设一名写入负责人。

## 14. 部署前置条件与未定项

开始生产部署前至少需要：

- 微信小程序 AppID、主体和管理员、合法请求域名、隐私声明、体验版与审核流程；
- Web/API 域名、TLS、生产 PostgreSQL、私有对象存储、秘密/加密密钥管理；
- 监控、错误告警、审计访问、数据库备份计划、恢复演练、RPO/RTO 和保留期；
- 明确业务时区、组织规模、性能目标、真实资料范围、费用预算和运维责任人；
- 关闭会影响上线行为的 PRODUCT 待决定项，尤其 D01、D06–D18、D21–D22；
- 安全审查、权限验收、真实设备验收和用户书面确认的计算样例。

技术设计不替用户决定以下业务口径：费率区间缺口/重叠、净课时费定义、16%上限权限、两类角色分配、提现有效字段、单据何时计入余额、缺失收款对象、舍入尾差、周流水生成与退费、关账重算、多角色范围、真实资金流程、手机改名交互、自动备份/附件保留和普通用户网页写入范围。它们必须在 PRODUCT 中形成决定后，才转为代码和测试常量。

## 15. 官方能力依据

以下资料于 **2026-09-16** 核查；这里只引用能力边界，不锁定未经工程验证的依赖版本或价格：

- [Taro React 概述](https://docs.taro.zone/docs/react-overall)：确认 Taro 使用真实 React，并遵循小程序组件、API 和路由规范。
- [Taro H5 实现说明](https://docs.taro.zone/docs/implement-note)：确认其 H5 端和平台插件机制；本项目仍为桌面网页单独使用 React DOM，以满足管理看板需求。
- [NestJS Controllers](https://docs.nestjs.com/controllers)、[Validation](https://docs.nestjs.com/techniques/validation) 与 [OpenAPI](https://docs.nestjs.com/openapi/introduction)：确认模块化 HTTP 控制器、输入校验和 OpenAPI 集成能力。
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)：作为跨端 API 描述和类型生成的标准来源。
- [PostgreSQL Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html)：确认 `numeric` 适合要求精确值的计算。
- [PostgreSQL Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) 与 [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)：支持一致性事务、可序列化失败重试和行锁设计。
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) 与 [Backup and Restore](https://www.postgresql.org/docs/current/backup.html)：确认数据库一致性导出和恢复工具边界；官方亦明确提示常规生产备份不能只靠简单 `pg_dump`，因此上线前仍需制定完整备份方案。
