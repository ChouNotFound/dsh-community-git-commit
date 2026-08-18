/**
 * The git-commit pipeline: one implementation shared by the model tool and
 * the slash commands. Owns repository collection, the auxiliary LLM call,
 * and the commit execution. Durable state rides the tool's own
 * `tool/result.meta` (a known session event type) — no custom event types,
 * which the persistence read path refuses for out-of-tree plugins.
 * @module @dsh-community/git-commit/service
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.js'
import { generateCommitMessage, frameInput } from './generate.js'
import {
  collectRepoState, commitWithMessage, createGitRunner,
  GitExecutionError, NotAGitRepositoryError,
} from './git.js'
import type {
  CommitGeneratedFrom, CommitScope, CommitStyle,
  GitCommitProposalId, GitCommitProposalPayload, GitRoute,
} from './types.js'

/** Mint the next unique proposal identity (instance-token prefixed so a resumed log never repeats one). */
export function mintProposalId(): GitCommitProposalId {
  return `git-commit-${randomUUID().slice(0, 8)}` as GitCommitProposalId
}

/** The configured explicit route, when the deployment supplied the pair. */
function routeFromConfig(config: ResolvedConfig): GitRoute | undefined {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  return undefined
}

/** The latest logged request route, falling back to the session's last request. */
function routeFromSession(session: Session): GitRoute | undefined {
  for (const event of [...session.events].reverse()) {
    if (event.type !== 'request/header') continue
    const config = event.data.header.config
    if (typeof config.provider === 'string' && config.provider !== ''
      && typeof config.model === 'string' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
    return undefined
  }
  return undefined
}

/** Resolve the explicit pair or the exact route captured from the session log. */
function resolveRoute(config: ResolvedConfig, session: Session): GitRoute {
  const explicit = routeFromConfig(config)
  if (explicit !== undefined) return explicit
  const logged = routeFromSession(session)
  if (logged !== undefined) return logged
  throw new Error('git-commit: no model route is available; configure provider and model together')
}

/** The session's working directory, or a user-facing error reason. */
function cwdOf(session: Session): { cwd: string } | { reason: string } {
  const cwd = session.header.cwd
  if (cwd === undefined || cwd === '') {
    return { reason: '会话没有工作目录，无法定位仓库' }
  }
  return { cwd }
}

/** Shape-check one `tool/result` meta value as our proposal payload. */
export function parseProposalPayload(value: unknown): GitCommitProposalPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as {
    kind?: unknown; proposalId?: unknown; style?: unknown; message?: unknown
    stagedFiles?: unknown; stagedCount?: unknown; unstagedCount?: unknown
    repoRoot?: unknown; generatedFrom?: unknown
  }
  if (candidate.kind !== 'proposal'
    || typeof candidate.proposalId !== 'string' || candidate.proposalId === ''
    || (candidate.style !== 'complete' && candidate.style !== 'concise')
    || typeof candidate.message !== 'string'
    || !Array.isArray(candidate.stagedFiles)
    || !candidate.stagedFiles.every(file => typeof file === 'string')
    || typeof candidate.stagedCount !== 'number'
    || typeof candidate.unstagedCount !== 'number'
    || typeof candidate.repoRoot !== 'string'
    || (candidate.generatedFrom !== 'history' && candidate.generatedFrom !== 'generic')) {
    return undefined
  }
  return {
    kind: 'proposal',
    proposalId: candidate.proposalId as GitCommitProposalId,
    style: candidate.style,
    message: candidate.message,
    stagedFiles: candidate.stagedFiles,
    stagedCount: candidate.stagedCount,
    unstagedCount: candidate.unstagedCount,
    repoRoot: candidate.repoRoot,
    generatedFrom: candidate.generatedFrom,
  }
}

/** The most recent durable proposal payload for one proposal identity. */
export function findProposalPayload(
  events: readonly SessionEvent[],
  proposalId: GitCommitProposalId,
): GitCommitProposalPayload | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'tool/result') continue
    const payload = parseProposalPayload(event.data.meta)
    if (payload !== undefined && payload.proposalId === proposalId) return payload
  }
  return undefined
}

/** A successful proposal, ready for user review. */
export type ProposalView = GitCommitProposalPayload

/** The working tree has nothing to summarize in the requested scope. */
export interface NothingStagedView {
  readonly kind: 'nothing-staged'
  readonly repoRoot: string
  readonly unstagedCount: number
}

/** Generation failed; the reason is user-facing. */
export interface ProposalErrorView {
  readonly kind: 'error'
  readonly reason: string
}

export type ProposeOutcome = ProposalView | NothingStagedView | ProposalErrorView

export interface CommitOkView {
  readonly kind: 'ok'
  readonly hash: string
}

export interface CommitErrorView {
  readonly kind: 'error'
  readonly reason: string
}

export type CommitOutcome = CommitOkView | CommitErrorView

/** The git-commit pipeline behind the tool and the commands. */
export class GitCommitService {
  private readonly config: ResolvedConfig

  constructor(
    private readonly ctx: Context,
    config: ResolvedConfig,
  ) {
    this.config = config
  }

  /**
   * Collect the repository state and generate one commit message proposal.
   * @param session - owning session (cwd and route source).
   * @param opts - style, scope, cancellation, and provenance.
   * @returns the proposal (the caller persists it through the tool result),
   *   or a domain failure view when the tree or the model cannot produce one.
   */
  async propose(
    session: Session,
    opts: { style: CommitStyle; scope: CommitScope; signal: AbortSignal },
  ): Promise<ProposeOutcome> {
    opts.signal.throwIfAborted()
    const located = cwdOf(session)
    if ('reason' in located) return { kind: 'error', reason: located.reason }
    const runner = createGitRunner(this.ctx, located.cwd)
    let snapshot
    try {
      snapshot = await collectRepoState(runner, {
        styleSamples: this.config.styleSamples,
        maxDiffBytes: this.config.maxDiffBytes,
        scope: opts.scope,
      })
    } catch (error) {
      if (opts.signal.aborted) throw error
      if (error instanceof NotAGitRepositoryError) {
        return { kind: 'error', reason: `当前目录不是 git 仓库：${located.cwd}` }
      }
      if (error instanceof GitExecutionError) {
        return { kind: 'error', reason: `git 命令失败：${error.stderr.trim() || error.message}` }
      }
      throw error
    }
    if (snapshot.stagedFiles.length === 0) {
      return { kind: 'nothing-staged', repoRoot: snapshot.repoRoot, unstagedCount: snapshot.unstagedCount }
    }

    let route: GitRoute
    try {
      route = resolveRoute(this.config, session)
    } catch (error) {
      return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
    }

    const proposalId = mintProposalId()
    const generatedFrom: CommitGeneratedFrom = snapshot.hasCommits ? 'history' : 'generic'
    const framedInput = frameInput({
      stagedDiff: snapshot.stagedDiff,
      stagedFiles: snapshot.stagedFiles,
      styleSamples: snapshot.styleSamples,
      style: opts.style,
    })
    let generated
    try {
      generated = await generateCommitMessage(this.ctx, {
        route,
        style: opts.style,
        generatedFrom,
        framedInput,
        maxInputBytes: this.config.maxInputBytes,
        maxOutputTokens: this.config.maxOutputTokens,
        timeoutMs: this.config.timeoutMs,
        sessionId: session.id,
        signal: opts.signal,
      })
    } catch (error) {
      if (opts.signal.aborted) throw error
      return { kind: 'error', reason: `生成失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return {
      kind: 'proposal',
      proposalId,
      style: opts.style,
      message: generated.message,
      stagedFiles: snapshot.stagedFiles,
      stagedCount: snapshot.stagedFiles.length,
      unstagedCount: snapshot.unstagedCount,
      repoRoot: snapshot.repoRoot,
      generatedFrom,
    }
  }

  /**
   * Commit the staged changes with the final message. When a proposal id is
   * supplied, the current staged file set must still match the proposal's
   * durable payload — a stale card can never commit newer changes.
   * @param session - owning session (cwd and durable proposal lookup).
   * @param opts - optional proposal identity, final message, cancellation.
   * @returns the commit outcome.
   */
  async commit(
    session: Session,
    opts: { proposalId?: GitCommitProposalId; message: string; signal: AbortSignal },
  ): Promise<CommitOutcome> {
    const message = opts.message.trim()
    if (message === '') return { kind: 'error', reason: '提交消息不能为空' }
    const located = cwdOf(session)
    if ('reason' in located) return { kind: 'error', reason: located.reason }
    const runner = createGitRunner(this.ctx, located.cwd)

    let expectedStaged: readonly string[] | undefined
    if (opts.proposalId !== undefined) {
      const payload = findProposalPayload(session.events, opts.proposalId)
      if (payload === undefined) {
        return { kind: 'error', reason: '未找到对应的提案记录，请重新生成提交信息' }
      }
      expectedStaged = payload.stagedFiles
    }

    try {
      const stagedCheck = await runner.run(['diff', '--cached', '--name-only'])
      if (stagedCheck.exitCode !== 0) {
        throw new GitExecutionError('git diff --cached failed', stagedCheck.exitCode, stagedCheck.stderr)
      }
      const currentStaged = stagedCheck.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '')
      if (currentStaged.length === 0) {
        return { kind: 'error', reason: '暂存区已清空，无法提交' }
      }
      if (expectedStaged !== undefined) {
        const sameSet = currentStaged.length === expectedStaged.length
          && [...currentStaged].sort().join('\u0000') === [...expectedStaged].sort().join('\u0000')
        if (!sameSet) {
          return { kind: 'error', reason: '暂存内容与提案不一致，请重新生成提交信息' }
        }
      }
      const hash = await commitWithMessage(runner, message, opts.signal)
      return { kind: 'ok', hash }
    } catch (error) {
      if (error instanceof GitExecutionError) {
        return { kind: 'error', reason: error.stderr.trim() || error.message }
      }
      throw error
    }
  }
}
