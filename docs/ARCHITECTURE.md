# 架构

本插件采用 pnpm monorepo，两个包：`@dsh-community/git-commit`（宿主）+ `@dsh-community/ui-git-commit`（浏览器）。`cordis.patch.yml` 把两个包插入现有 DSH profile。

```
dsh-community-git-commit/
├── package.json                      # 宿主包 = bundle 清单 + 运行时插件
├── cordis.patch.yml                  # 把 git-commit + ui-git-commit 行插入 profile
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
├── packages/ui-git-commit/           # 浏览器插件包（独立 npm 包）
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

## 宿主包 `src/`

- `index.ts` — cordis `apply()` 入口：注册工具 + 命令
- `types.ts` — 提案 ID、风格、scope、生成来源枚举与 payload 类型
- `config.ts` — 部署相关配置（默认 scan window、模型选择等）的解析
- `git.ts` — `git` 子进程封装：扫描工作区状态、收集 diff、提交
- `generate.ts` — 提示词构建（system prompt）、输入框定（frame）、消息拼装（compose）、生成入口
- `service.ts` — `GitCommitService`：提案生命周期 + 提交入口 + 从会话日志反查 proposal payload
- `tool.ts` — 把 `git_commit_propose` 注册为 cordis 工具
- `commands.ts` — 把 `/git-commit` 注册为 cordis 命令

## 浏览器包 `packages/ui-git-commit/src/client/`

- `index.ts` — 浏览器侧 `apply()`：注册 locale + `tool.call.toolview`
- `CommitCard.tsx` — 卡片组件（文本框 + 风格徽标 + 文件数 + 三个按钮）
- `CommitCard.module.css` — 语义化样式，使用回退变量，无主题依赖
- `locales.ts` — zh / en 文案字典 + `LocaleNamespaceMap` 合并

## `cordis.patch.yml`

bundle patch 文件：把 `git-commit`（宿主工具）+ `ui-git-commit`（浏览器卡片）两行插入到现有 profile 的 bundle 列表，使宿主运行时增量扫描并按需加载。

## 数据流

1. 用户输入「生成提交信息」 → Agent 推理
2. Agent 调用 `git_commit_propose` 工具
3. 宿主 `generate.ts` 拼提示词 → 调模型 → 写入 `tool/result` 的 `content` + `presentationMeta`
4. 浏览器侧 `tool.call.toolview` 渲染 `CommitCard`
5. 用户点 **提交** → 浏览器发命令 `/git-commit` → 宿主命令处理器 → 校验暂存集 → 执行 `git commit`