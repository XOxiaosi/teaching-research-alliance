# 教研联盟管理平台

教研联盟管理平台的独立项目仓库，用于持续管理产品需求、源代码和开发记录。

GitHub 私有仓库：[XOxiaosi/teaching-research-alliance](https://github.com/XOxiaosi/teaching-research-alliance)。

## 当前状态

当前需求为V1.10：微信小程序与手机/电脑网页具备同等业务能力；采用个人/公司账户、三类权限和按身份分列的欢乐豆结算。已明确实时月度及全财年重算、9月至次年8月的财年、每周五10点自动Excel与凭证原件备份，文件及历史数据永久保留（不含导入）。提现提交即扣款自动通过，提交后仅财务可撤回；财务人工调账填写原因、提交即生效并送上级审批，上级可查阅调整明细，拒绝或退回时自动冲回；审批前增加的余额也可提现。用户集中答复和补充确认已归档，剩余口径见PRODUCT待决定表。当前只有需求与技术文档，尚无业务实现。

## 项目文档

- [PRODUCT.md](PRODUCT.md)：产品目标、当前范围、验收标准和待明确事项。
- [PROJECT_LOG.md](PROJECT_LOG.md)：开发进度、决策与验证证据。
- [AGENTS.md](AGENTS.md)：项目协作规则。
- [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)：多端架构、数据模型、计算与权限、接口及验证方案。
- [Excel 导出规范](docs/EXCEL_BACKUP_SPEC.md)：全量数据范围、快照、文件格式、权限与完整性验收。
- [最新答复审查](docs/reviews/REQ-008_DECISION_REVIEW.md)：35条答复覆盖、后续澄清及剩余口径。
- [集中答复来源](docs/requirements/REQ-008-用户集中答复.md)：用户提供的条目及补充确认，未进行音频核验。
- [历史开发前审查](docs/reviews/PREDEVELOPMENT_AUDIT.md)：原始V1.6问题与当时的计算例证。

## Git 管理

默认分支为 `main`。后续功能开发使用独立分支，提交前检查变更并进行与变更相应的验证。

GitHub 同步通过提交和推送完成；本地文件修改不会自动上传。配置远端后可使用：

```sh
git status
git add <本次修改的文件>
git commit -m "说明本次变更"
git push
```

## 数据边界

仓库用于代码、文档和脱敏示例。真实学校、教师、学生资料、上传文件、数据库、密钥和本地环境配置不进入版本控制。
