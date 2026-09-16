# 教研联盟管理平台

教研联盟管理平台的独立项目仓库，用于持续管理产品需求、源代码和开发记录。

GitHub 私有仓库：[XOxiaosi/teaching-research-alliance](https://github.com/XOxiaosi/teaching-research-alliance)。

## 当前状态

已依据用户提供的 V1.6 文档整理内部绩效结算需求，并完成开发前核查与技术设计。已确认微信小程序为主端、手机/电脑网页看板，以及管理端完整 Excel 导出（不含导入）。计算与入账歧义集中在 PRODUCT 待决定表；当前尚未实现业务功能。

## 项目文档

- [PRODUCT.md](PRODUCT.md)：产品目标、当前范围、验收标准和待明确事项。
- [PROJECT_LOG.md](PROJECT_LOG.md)：开发进度、决策与验证证据。
- [AGENTS.md](AGENTS.md)：项目协作规则。
- [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)：多端架构、数据模型、计算与权限、接口及验证方案。
- [Excel 导出规范](docs/EXCEL_BACKUP_SPEC.md)：全量数据范围、快照、文件格式、权限与完整性验收。
- [开发前审查](docs/reviews/PREDEVELOPMENT_AUDIT.md)：原文覆盖、计算反例和待澄清口径。

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
