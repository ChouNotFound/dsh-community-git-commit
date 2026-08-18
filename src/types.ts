/**
 * Shared contracts for the git-commit plugin: the proposal payload carried by
 * the tool's durable `tool/result` presentation metadata (the only replayable
 * carrier available to out-of-tree plugins — custom session event types are
 * refused by the persistence read path) and the style/scope vocabulary.
 * @module @dsh-community/git-commit/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one generated commit-message proposal. */
export type GitCommitProposalId = Branded<'GitCommitProposalId'>

/** One resolved model route used for an auxiliary generation call. */
export interface GitRoute {
  readonly provider: string
  readonly model: string
}

/** The two adjustable message styles offered by the card and the tool. */
export type CommitStyle = 'complete' | 'concise'

/** Which working-tree changes a proposal summarizes. */
export type CommitScope = 'staged' | 'all'

/** Whether style samples came from the repository history or a generic instruction. */
export type CommitGeneratedFrom = 'history' | 'generic'

/**
 * The durable proposal payload: the tool returns it as its canonical value
 * and projects it verbatim into `tool/result.meta`, so the card survives
 * replay and the commit path can re-verify the staged file set.
 */
export interface GitCommitProposalPayload {
  readonly kind: 'proposal'
  readonly proposalId: GitCommitProposalId
  readonly style: CommitStyle
  /** The generated commit message (subject, plus body for `complete`). */
  readonly message: string
  /** Staged file paths summarized by this proposal. */
  readonly stagedFiles: string[]
  readonly stagedCount: number
  readonly unstagedCount: number
  readonly repoRoot: string
  readonly generatedFrom: CommitGeneratedFrom
}
