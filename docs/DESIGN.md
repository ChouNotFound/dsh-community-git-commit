# 设计决定

以下是本项目早期的关键设计决定，以及与"曾讨论过的合并方案"对比下落地时的实际差异。代码层面的取舍说明面向想理解架构、或者想 fork / 改造本插件的人。

## 没有自定义会话事件

DSH 持久化层对仓库外未知事件类型强制拒绝（除非信封带 `ignorable` 标记，而 `Session.append` API 不暴露该标记）。

因此提案数据**只通过工具自己的 `tool/result` 事件 + `presentationMeta`** 持久化——这是外置插件唯一可重放的载体。本插件**不**依赖 `SessionEventMap` merge、**不**依赖 `@Remote` 服务。

## 按钮 → 宿主通道走 `commands` Remote

`ctx.remote.commands.execute(sessionId, line)`，经已发布的 `dsh-commands/remote`，无需改仓库内 `api/remotes` 聚合面。

## 卡片 = 工具行内的 `tool.call.toolview`

`key=git_commit_propose`：从 `block.meta` 读 proposal；不是独立的会话节点，避免与既有 `tool-call` 节点重复渲染。

## 重新生成 = `session.prompt()` 让 Agent 再调一次工具

经过 Agent 回合（慢一点但完全可重放 + 模型可见 + 日志留存），新卡片自然出现。旧的提案卡片保留为"备选方案"——可直接点击其提交按钮，暂存集安全校验会防止把与该提案不匹配的更新内容错混提交。

## 提交命令的暂存集二次校验

命令的 JSON 负载携带 `proposalId`；服务从会话日志里找到该 proposal 对应的 `tool/result.meta.stagedFiles`，与 `git diff --cached --name-only` 当前结果对比，不一致则拒绝，防止"过期卡片 → 把后来的改动用旧消息错混提交"。