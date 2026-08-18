# git-commit for DeepSeek Harness

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.3-blue.svg)](package.json)
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.7-blueviolet.svg)](https://github.com/deepseek-ai)

在 DSH（DeepSeek Harness）Web GUI 中，按仓库历史风格生成 git commit 信息，在工具卡片里审阅 / 编辑 / 一键提交。**不修改 `deepseek-harness` 仓库任何代码**。

[English summary](#english) · [关于 DSH](#关于-dsh)

## 这是什么

DSH Web GUI 的一个外置插件。用户输入「生成提交信息」后，Agent 调用 `git_commit_propose` 工具，按仓库最近的提交风格生成提案，在工具行内显示一张可编辑卡片：

- **提交**：宿主机执行 `git commit`
- **重新生成 / 风格切换**：让 Agent 再调一次工具，得到一张新卡片
- **复制**：把当前文本框内容复制到剪贴板

通过 `dsh plugin add` 安装到现有 profile，运行时增量扫描并按需加载，**不会触碰 `deepseek-harness` 仓库**。

## 工作流程

```
  用户输入「生成提交信息」
         │
         ▼
   ┌──────────────┐
   │ Agent 推理回合 │  ── 调用 git_commit_propose
   └──────┬───────┘
          │ 提案 (subject + body + stagedFiles)
          ▼
   ┌────────────────────┐
   │ 工具行内 CommitCard │  ← 可编辑文本框 + 按钮
   └──────┬─────────────┘
          │ 点「提交」
          ▼
   宿主机 git commit（含暂存区二次校验）
```

## 功能

- **风格感知**：自动学习仓库最近 N 条提交的风格（主题行长度、是否带正文、scope 命名、动词时态）
- **两档风格**：完整（主题 + 正文）/ 简洁（单行主题）
- **可编辑卡片**：生成的提案在卡片中可直接修改再提交
- **暂存区二次校验**：提交前会比对"当前暂存文件"与"生成提案时的暂存文件"，防止过期提案被错误提交
- **不修改宿主**：作为外置插件以 bundle patch 形式注入，卸载即复原

## 兼容

| 组件 | 版本 |
|------|------|
| DeepSeek Harness | `0.1.0-rc.7` |
| Node.js | `>= 22` |
| pnpm | `>= 9` |

## 安装

```sh
# 1) 拉取并构建
git clone https://github.com/ChouNotFound/dsh-community-git-commit.git
cd dsh-community-git-commit
pnpm install
pnpm run build

# 2) 安装到现有 web profile（DSH_HOME=C:\Users\zhouz\.dsh\profiles\web）
#    这是两个独立 bundle 层，需要分别 add：
dsh plugin --profile web add .
dsh plugin --profile web add ./packages/ui-git-commit

# 3) 重启 dsh web，刷新 http://127.0.0.1:3080
```

卸载：

```sh
dsh plugin --profile web remove @dsh-community/git-commit
dsh plugin --profile web remove @dsh-community/ui-git-commit
```

## 使用

1. 在 DSH Web 中打开任意 git 仓库所在的工作区
2. `git add` 暂存要提交的文件
3. 在对话中输入「生成提交信息」 → Agent 调用工具 → 出现提案卡片
4. 检查卡片：可编辑、切换风格（完整 / 简洁）、重新生成，或直接点 **提交**

## 开发

```sh
pnpm install
pnpm run build       # 编译宿主 + ui 包 + 打浏览器 bundle
pnpm test            # vitest 跑全部 spec（host + ui 包组件，jsdom 环境）
pnpm run typecheck
```

monorepo 结构（pnpm workspace）一句话：`src/` 宿主插件（cordis plugin），`packages/ui-git-commit/` 浏览器插件包（独立 npm 包 + 浏览器 bundle），`cordis.patch.yml` 把两个包插入 profile 的 patch 文件。完整目录与职责见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 设计 / 限制

- 设计决定：[docs/DESIGN.md](docs/DESIGN.md)
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 已知限制：[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)

## 关于 DSH

DeepSeek Harness（`@deepseek-ai/dsh-*`）是 DeepSeek 的本地 AI Agent 运行时。本插件工作在它的 Web GUI 上，需要先安装并运行 DSH `0.1.0-rc.7`。插件宿主通过 cordis 把工具注册到现有 profile，不修改 `deepseek-harness` 仓库本身。

## 许可证

MIT © 2026 [ChouNotFound](https://github.com/ChouNotFound)

## 致谢

- 基于 [DeepSeek Harness](https://github.com/deepseek-ai) `@deepseek-ai/dsh-*` 系列包
- 插件宿主基于 [cordis](https://github.com/deepseek-ai/cordis)

---

<a name="english"></a>

## English

A plugin for DeepSeek Harness Web GUI that proposes git commit messages based on the repository's recent commit style, presented in an in-line editable card. Install via `dsh plugin add` — no changes to the `deepseek-harness` repo itself.

- **Style-aware**: learns from recent commits (subject length, body presence, scope conventions, verb tense)
- **Two styles**: full (subject + body) / concise (single-line)
- **Editable card**: review and edit before committing
- **Staged-set re-validation**: refuses to commit if the staged files have changed since the proposal was generated
- **External**: installed as a bundle patch, removed cleanly with one command

See [docs/](docs/) for design, architecture, and known limitations.