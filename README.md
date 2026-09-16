# 教研联盟管理平台

教研联盟管理平台的独立项目仓库，用于持续管理产品需求、源代码和开发记录。

GitHub 私有仓库：[XOxiaosi/teaching-research-alliance](https://github.com/XOxiaosi/teaching-research-alliance)。

## 当前状态

已依据用户提供的 V1.6 文档，按功能整理内部绩效结算需求；详见 PRODUCT.md。当前尚未实现业务功能或确定技术栈。

## 项目文档

- [PRODUCT.md](PRODUCT.md)：产品目标、当前范围、验收标准和待明确事项。
- [PROJECT_LOG.md](PROJECT_LOG.md)：开发进度、决策与验证证据。
- [AGENTS.md](AGENTS.md)：项目协作规则。

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
