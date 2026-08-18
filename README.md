# `@dsh-community/git-commit` — DSH 外置 Git 提交信息生成插件

`deepseek-harness` 同级独立项目。为现有 DSH Web GUI 新增"按历史风格生成 git 提交信息、可在卡片中审阅编辑后点击提交"的能力。**不修改 `deepseek-harness` 仓库任何文件**，通过 `dsh plugin add` 安装到现有 profile 后由宿主运行时增量扫描并按需加载。

## 功能

- 对话输入"生成提交信息" → 模型调用 `git_commit_propose` 工具 → 在工具行内显示提案卡片（可编辑文本框、风格徽标、文件数）。
- **两档风格**：完整（主题行 + 正文）/ 简洁（单行主题）；切换风格 = 让 Agent 重新调用工具生成一张新卡片。
- 卡片按钮：
  - **提交**：调用 `/git-commit` 命令；宿主机执行 `git commit`；卡片本地翻到"已提交"。
  - **重新生成 / 风格切换**：通过 `session.prompt()` 给 Agent 发一条 followup，让 Agent 重新调用工具 → 新卡片。
  - **复制**：复制当前文本框到剪贴板。

## 项目结构

```
dsh-git-commit/
├── package.json                      # 宿主包 = bundle 清单 + 运行时插件
├── cordis.patch.yml                  #  把 git-commit + ui-git-commit 行插入 profile
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                      # apply() 注册工具与命令
│   ├── types.ts                      # GitCommitProposalId/CommitStyle/CommitScope/CommitGeneratedFrom + GitCommitProposalPayload
│   ├── config.ts                     # 部署配置 + resolveConfig
│   ├── git.ts                        # createGitRunner / collectRepoState / commitWithMessage
│   ├── generate.ts                   # buildSystemPrompt / frameInput / composeMessage / generateCommitMessage
│   ├── service.ts                    # GitCommitService.propose/.commit + findProposalPayload
│   ├── tool.ts                       # registerCommitTool
│   └── commands.ts                   # registerCommitCommands
├── packages/ui-git-commit/            # 浏览器插件包（独立 npm 包）
│   ├── package.json                  # dsh.client 清单 + exports["client"]
│   ├── tsconfig.json
│   ├── tsdown.config.ts              # 复刻 clientBundle 等价配置
│   ├── src/{index.ts (空 apply), css-modules.d.ts}
│   └── src/client/
│       ├── index.ts                  # apply() 注册 locale + tool.call.toolview
│       ├── CommitCard.tsx            # 卡片组件
│       ├── CommitCard.module.css     # 语义化 CSS（无主题依赖，回退变量）
│       └── locales.ts                # zh/en 字典 + LocaleNamespaceMap 合并
└── tests/                            # vitest 单测
└── packages/ui-git-commit/tests/     # 组件测试（jsdom 环境）
```

## 安装到现有 web profile

```sh
# 1) 构建宿主与浏览器包
cd D:\Code\OpenSource\dsh-git-commit
pnpm install
pnpm run build

# 2) 安装到现有 profile（默认 $DSH_HOME=C:\Users\zhouz\.dsh\profiles\web）
dsh plugin --profile web add .
#   （若 dsh CLI 不在 PATH：npx -y @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile web add .）

# 3) 核对层与行
dsh --profile web --dump-config

# 4) 重启服务 GUI 的 dsh web 进程，刷新 http://127.0.0.1:3080
#    （client 包改动：重建 ui-git-commit + 重启进程，rev 变化使浏览器重新拉取）
```

卸载：`dsh plugin --profile web remove @dsh-community/git-commit`。

## 开发

- 宿主与 ui 包均通过 pnpm 工作区（`pnpm-workspace.yaml` 包含 `packages/*`）。
- `pnpm run build`：先 `tsc` 宿主 → 再 `tsc` ui 包 → 再 `tsdown` 打 ui 包浏览器 bundle。
- `pnpm test`：vitest 跑全部 spec（含 ui 包组件测试，使用 jsdom 环境）。

## 关键设计决定（与已合并的方案对比，落地时的实际差异）

- **没有自定义会话事件**：DSH 持久化层对仓库外未知事件类型强制拒绝（除非信封带 `ignorable` 标记，而 `Session.append` API 不暴露该标记）。因此提案数据只通过工具自己的 **`tool/result` 事件 + `presentationMeta`** 持久化——这是外置插件唯一可重放的载体。所以本插件不依赖 `SessionEventMap` merge、不依赖 `@Remote` 服务。
- **按钮 → 宿主通道走 `commands` Remote**：`ctx.remote.commands.execute(sessionId, line)`，经已发布的 `dsh-commands/remote`，无需改仓库内 `api/remotes` 聚合面。
- **卡片 = 工具行内的 `tool.call.toolview`**（key=`git_commit_propose`）：从 `block.meta` 读 proposal；不是独立的会话节点，避免与既有 `tool-call` 节点重复渲染。
- **重新生成 = `session.prompt()` 让 Agent 再调一次工具**：经过 Agent 回合（慢一点但完全可重放 + 模型可见 + 日志留存），新卡片自然出现。旧的提案卡片保留为"备选方案"——可直接点击其提交按钮，暂存集安全校验会防止把与该提案不匹配的更新内容错混提交。
- **提交命令的暂存集二次校验**：命令的 JSON 负载携带 `proposalId`；服务从会话日志里找到该 proposal 对应的 `tool/result.meta.stagedFiles`，与 `git diff --cached --name-only` 当前结果对比，不一致则拒绝，防止"过期卡片 → 把后来的改动用旧消息错混提交"。

## 已知限制

- **辅助 LLM 请求不写日志**：本工具会发起额外的模型调用以生成提交信息；这条 auxiliary 请求**没有可重放的日志事件**（DSH 仓库外无法注册自定义会话事件类型）。生成结果本身落在 `tool/result` 元数据 + 内容里，可重放。
- **会话级别本地"已提交"状态**：卡片点击提交后，本地组件进入"已提交"态；如果刷新页面或重启 dsh web，卡片回到"可编辑提案态"——**但**再次提交会因为暂存区已空而被服务拒绝（`暂存区已清空，无法提交`），因此不会重复提交。committed 状态是会话内的，不跨刷新。
- **"已取代"语义被有意省去**：旧提案卡与新提案卡并存，旧卡作为同一暂存集的不同候选方案存在；如不希望保留旧卡，关闭它所在的工具行即可。
- **风格切换与重新生成经模型回合**，耗时 2–10 秒并消耗少量 token；如需离线瞬时切换，可改为本地字符串模板替换，但生成质量会下降。