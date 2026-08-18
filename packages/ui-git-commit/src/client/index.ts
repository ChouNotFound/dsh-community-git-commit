/**
 * Browser half of the git-commit plugin: registers the proposal dictionary
 * and the keyed toolview (`tool.call.toolview` key `git_commit_propose`) that
 * replaces the generic tool row with the editable proposal card. Commit
 * buttons dispatch `/git-commit` through the existing `commands` Remote;
 * regenerate buttons ask the agent (via `session.prompt`) to call the tool
 * again, producing a new card.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { CommitStyle } from '@dsh-community/git-commit/types'
import { CommitCard, type CommitCardInjected } from './CommitCard'
import { en, NS, type GitCommitKey, zh } from './locales'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The commit-proposal toolview copy. */
    gitCommit: GitCommitKey
  }
}

/** Required services: slot registry, commands Remote, sessions (for followup). */
export const inject = ['slots', 'remote', 'remote.commands', 'sessions', 'locale']

/** Extract a user-facing failure line from a command dispatch result. */
function commandFailure(result: { ok: boolean; error?: { message?: string }; value?: unknown }): string | null {
  if (!result.ok) return result.error?.message ?? 'command failed'
  const value = result.value as { result?: { kind?: string; text?: string } } | undefined
  if (value === undefined) return 'unknown command'
  if (value.result?.kind === 'error') return value.result.text ?? 'command failed'
  return null
}

/** Build the followup message that asks the agent to regenerate one proposal. */
function regenerationFollowup(style: CommitStyle): string {
  return [
    `请为当前 git 暂存区重新生成一条提交信息，风格：${style}（请调用 git_commit_propose 工具，参数 style=${style}）。`,
    '请直接调用工具生成新提案，不要在回复里自己写提交信息。',
  ].join('\n')
}

/** Extract a user-facing failure line from a prompt dispatch result. */
function promptFailure(result: { ok: boolean; error?: { message?: string } }): string | null {
  if (result.ok) return null
  return result.error?.message ?? 'followup rejected'
}

/** Register the dictionary and the keyed toolview. */
export function apply(ctx: ClientContext): void {
  void ctx as unknown as Context
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-git-commit: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'git_commit_propose',
    locale: NS,
    inject: (sessionId: SessionId): CommitCardInjected => ({
      commit: async (proposalId: string, message: string) => {
        const payload = JSON.stringify({ proposalId, message })
        const result = await ctx.remote.commands.execute(sessionId, `/git-commit ${payload}`)
        return commandFailure(result)
      },
      regenerate: async (style: CommitStyle) => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) return '会话不可用'
        const result = await session.prompt(
          [{ type: 'text', text: regenerationFollowup(style) }],
          'queue',
        )
        return promptFailure(result)
      },
    }),
  }, CommitCard))
}