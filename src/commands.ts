/**
 * Slash commands driving the commit pipeline without a model turn: the UI
 * card's commit button dispatches `/git-commit` through the existing
 * `commands` Remote; `/git-commit-propose [style]` is a chat-only convenience
 * for users who want a message without opening a card.
 * @module @dsh-community/git-commit/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  type CommitOutcome,
  type GitCommitService,
  type ProposeOutcome,
} from './service.js'
import type { CommitStyle, GitCommitProposalId } from './types.js'

/** Parse a command-line style token; undefined means "use the default". */
export function parseStyleToken(raw: string): CommitStyle | undefined {
  const token = raw.trim().toLowerCase()
  if (token === 'complete' || token === 'concise') return token
  return undefined
}

/** Parse the UI JSON payload `{proposalId, message}`; null when malformed. */
export function parseCommitPayload(raw: string): { proposalId: string; message: string } | null {
  try {
    const parsed = JSON.parse(raw) as { proposalId?: unknown; message?: unknown }
    if (typeof parsed.proposalId !== 'string' || parsed.proposalId === ''
      || typeof parsed.message !== 'string') {
      return null
    }
    return { proposalId: parsed.proposalId, message: parsed.message }
  } catch {
    return null
  }
}

/** Map one pipeline outcome onto the command result contract. */
export function outcomeToCommandResult(outcome: ProposeOutcome): CommandResult {
  switch (outcome.kind) {
    case 'proposal':
      return {
        kind: 'success',
        text: [
          `已生成${outcome.style === 'concise' ? '简洁' : '完整'}提交信息（${outcome.stagedCount} 个暂存文件）：`,
          '',
          outcome.message,
        ].join('\n'),
      }
    case 'nothing-staged':
      return { kind: 'error', text: `暂存区为空（${outcome.unstagedCount} 个未暂存改动），请先 git add 或改用 scope=all。` }
    case 'error':
      return { kind: 'error', text: outcome.reason }
  }
}

/** Map one commit outcome onto the command result contract. */
export function commitOutcomeToCommandResult(outcome: CommitOutcome): CommandResult {
  return outcome.kind === 'ok'
    ? { kind: 'success', text: `提交成功（${outcome.hash}）` }
    : { kind: 'error', text: outcome.reason }
}

/** Register the plugin's slash commands; returns the combined disposer. */
export function registerCommitCommands(ctx: Context, service: GitCommitService): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.commands.register({
    name: 'git-commit-propose',
    description: 'Generate a git commit message from the staged changes',
    input: { hint: '[complete|concise]' },
    handler: async (invocation) => {
      const style = parseStyleToken(invocation.rawInput) ?? 'complete'
      const outcome = await service.propose(invocation.agent.session, {
        style,
        scope: 'staged',
        signal: invocation.signal,
      })
      return outcomeToCommandResult(outcome)
    },
  }))

  disposers.push(ctx.commands.register({
    name: 'git-commit',
    description: 'Commit the staged changes with the given message (JSON payload from the UI card, or plain text for hand-typed commits)',
    // Plain-text hand-typed commits keep their args as recordInput=true so the chat
    // transcript shows the message; JSON payloads from the card hide it (the
    // committed message is owned by the git log and the git/commit-done event).
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      let proposalId: GitCommitProposalId | undefined
      let message: string
      if (raw.startsWith('{')) {
        const payload = parseCommitPayload(raw)
        if (payload !== null) {
          proposalId = payload.proposalId as GitCommitProposalId
          message = payload.message
        } else {
          return { kind: 'error', text: '用法：/git-commit {"proposalId":"...","message":"..."}' }
        }
      } else {
        message = raw
      }
      const outcome = await service.commit(invocation.agent.session, {
        proposalId,
        message,
        signal: invocation.signal,
      })
      return commitOutcomeToCommandResult(outcome)
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}