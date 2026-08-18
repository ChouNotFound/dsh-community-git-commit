/**
 * The commit-proposal card rendered inside the tool row for
 * `git_commit_propose`. The proposal rides the tool's own `tool/result.meta`
 * (the only durable replayable carrier available to out-of-tree plugins) and
 * survives page reload and host restart. Committing dispatches the plugin's
 * `/git-commit` command; regeneration asks the agent (via `session.prompt`)
 * to call the tool again, producing a new proposal card below.
 */

import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitStyle, GitCommitProposalPayload } from '@dsh-community/git-commit/types'
import type { GitCommitKey } from './locales'
import css from './CommitCard.module.css'

/** Actions injected from the plugin's own service + sessions access. */
export interface CommitCardInjected {
  /**
   * Commit the staged changes with the exact message.
   * @param proposalId - proposal identity (for staged-set re-verification).
   * @param message - the final (possibly user-edited) message.
   * @returns a user-facing failure line, or null on success.
   */
  readonly commit: (proposalId: string, message: string) => Promise<string | null>
  /**
   * Ask the agent to regenerate a proposal with the requested style.
   * @param style - the requested style.
   * @returns a user-facing failure line, or null when the followup was accepted.
   */
  readonly regenerate: (style: CommitStyle) => Promise<string | null>
}

/** Complete keyed toolview props. */
export type CommitCardProps =
  PropsRuntime<'tool.call.toolview'>
  & PropsLocale<'gitCommit'>
  & CommitCardInjected

type BusyKind = 'commit' | 'regenerate' | null

/** Shape-check one candidate payload (structural — no host runtime import). */
function parseProposal(value: unknown): GitCommitProposalPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
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
    proposalId: candidate.proposalId as GitCommitProposalPayload['proposalId'],
    style: candidate.style,
    message: candidate.message,
    stagedFiles: candidate.stagedFiles as string[],
    stagedCount: candidate.stagedCount,
    unstagedCount: candidate.unstagedCount,
    repoRoot: candidate.repoRoot,
    generatedFrom: candidate.generatedFrom,
  }
}

/** The full proposal card rendered inside the tool row. */
export function CommitCard(props: CommitCardProps) {
  const { block, t, commit, regenerate } = props
  const isSettled = 'kind' in block && block.kind === 'tool-result'

  if (!isSettled) {
    return (
      <div className={css.card}>
        <div className={css.header}>
          <span className={css.title}>{t('title')}</span>
        </div>
        <div className={css.running}>{t('busy.generating')}</div>
      </div>
    )
  }

  const resultBlock = block
  const isError = resultBlock.isError
  const payload = parseProposal(resultBlock.meta)
  const contentText = resultBlock.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')

  if (isError || payload === undefined) {
    return (
      <div className={css.card}>
        <div className={css.header}>
          <span className={css.title}>{t('title')}</span>
        </div>
        <pre className={css.message}>{contentText || t(isError ? 'status.failed' : 'fallback.invalid')}</pre>
      </div>
    )
  }

  return <CommitCardBody payload={payload} t={t} commit={commit} regenerate={regenerate} />
}

/** Full interactive body for a settled, valid proposal. */
function CommitCardBody({
  payload,
  t,
  commit,
  regenerate,
}: {
  payload: GitCommitProposalPayload
  t: (key: GitCommitKey, params?: Record<string, string | number>) => string
  commit: CommitCardInjected['commit']
  regenerate: CommitCardInjected['regenerate']
}) {
  const [draft, setDraft] = useState<string>('')
  const [busy, setBusy] = useState<BusyKind>(null)
  const [committed, setCommitted] = useState<boolean>(false)
  const [failureReason, setFailureReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Initial seed and any proposal-id replacement (regeneration creates a new
  // tool call, hence a new toolview instance, so this seeds once in practice).
  useEffect(() => {
    setDraft(payload.message)
    setCommitted(false)
    setFailureReason(null)
    setError(null)
    setCopied(false)
  }, [payload.proposalId])

  const handleCommit = async (): Promise<void> => {
    if (draft.trim() === '') {
      setError(t('error.empty'))
      return
    }
    setBusy('commit')
    const failure = await commit(payload.proposalId, draft)
    setBusy(null)
    if (failure !== null) {
      setFailureReason(failure)
    } else {
      setCommitted(true)
    }
  }

  const handleRegenerate = async (style: CommitStyle): Promise<void> => {
    setBusy('regenerate')
    const failure = await regenerate(style)
    setBusy(null)
    if (failure !== null) setError(failure)
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
    } catch {
      setError(t('action.copy'))
    }
  }

  const fileCount = t(payload.stagedCount === 1 ? 'files.one' : 'files.other', { count: payload.stagedCount })
  const locked = committed
  const isFailure = failureReason !== null

  return (
    <div className={css.card}>
      <div className={css.header}>
        <span className={css.title}>{t('title')}</span>
        <span className={css.badge}>{payload.style === 'complete' ? t('style.complete') : t('style.concise')}</span>
        <span className={css.meta}>{fileCount}</span>
        {payload.generatedFrom === 'generic' && <span className={css.meta}>{t('generated.generic')}</span>}
      </div>
      <textarea
        className={css.textarea}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setError(null) }}
        disabled={locked || busy !== null}
        placeholder={t('placeholder')}
        rows={payload.style === 'complete' ? 6 : 2}
      />
      <div className={css.actions}>
        <button
          className={css.primary}
          onClick={handleCommit}
          disabled={locked || busy !== null}
        >
          {busy === 'commit' ? t('busy.commit') : t('action.commit')}
        </button>
        <button
          onClick={() => handleRegenerate(payload.style)}
          disabled={locked || busy !== null}
        >
          {busy === 'regenerate' ? t('busy.regenerate') : t('action.regenerate')}
        </button>
        <button onClick={handleCopy} disabled={busy !== null}>
          {copied ? t('action.copied') : t('action.copy')}
        </button>
        <span className={css.styleToggle}>
          <button
            className={payload.style === 'complete' ? css.active : undefined}
            onClick={() => handleRegenerate('complete')}
            disabled={locked || busy !== null}
          >
            {t('style.complete')}
          </button>
          <button
            className={payload.style === 'concise' ? css.active : undefined}
            onClick={() => handleRegenerate('concise')}
            disabled={locked || busy !== null}
          >
            {t('style.concise')}
          </button>
        </span>
      </div>
      {committed && (
        <div className={css.committed}>{t('status.committed', { hash: '\u2713' })}</div>
      )}
      {isFailure && (
        <div className={css.failed}>{t('status.failed')}：{failureReason}</div>
      )}
      {error !== null && <div className={css.error}>{error}</div>}
    </div>
  )
}