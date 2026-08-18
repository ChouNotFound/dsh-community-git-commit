/**
 * Git execution through the `ctx.shell` capability seam. Every argv element is
 * a trusted literal (fixed flags, our own temp-file path); user text never
 * enters a command line — the commit message travels via `git commit -F
 * <file>`. Quoting only guards paths containing spaces.
 * @module @dsh-community/git-commit/git
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** A git command failed with a non-zero exit. */
export class GitExecutionError extends Error {
  readonly exitCode: number | null
  readonly stderr: string

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message)
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/** The working directory is not inside a git repository. */
export class NotAGitRepositoryError extends Error {
  constructor() {
    super('not a git repository')
  }
}

/** One foreground git invocation, bounded and cancellable. */
export interface GitRunOptions {
  /** Working directory override (default: the runner's root). */
  workdir?: string
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Foreground stdout capture budget in bytes. */
  stdoutMaxBytes?: number
  /** Command timeout in milliseconds. */
  timeoutMs?: number
}

/** Result of one git invocation. */
export interface GitRunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Testable git facade: runs argv-style git commands with trusted literals. */
export interface GitRunner {
  run(args: readonly string[], opts?: GitRunOptions): Promise<GitRunResult>
}

/** A snapshot of the repository state a proposal summarizes. */
export interface GitRepoSnapshot {
  readonly repoRoot: string
  readonly stagedFiles: string[]
  readonly stagedCount: number
  /** The (possibly truncated) diff text sent to the model. */
  readonly stagedDiff: string
  readonly stagedDiffTruncated: boolean
  /** Working-tree changes not staged (including untracked). */
  readonly unstagedCount: number
  /** One string per sampled commit (subject, plus body when present). */
  readonly styleSamples: string[]
  readonly hasCommits: boolean
}

/** PowerShell-safe single-quote of one literal argument. */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll("'", "''")}'`
}

/** Truncate one string at a UTF-8 byte budget, marking the cut. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  // Never split a multi-byte character: drop a trailing partial sequence.
  const boundary = cut.byteLength
  let end = boundary
  while (end > 0 && (cut[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return {
    text: `${cut.subarray(0, end).toString('utf8')}\n... [diff truncated]`,
    truncated: true,
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_STDOUT_BUDGET = 8 * 1024 * 1024

/** Build a git facade over the shell seam for one working directory. */
export function createGitRunner(ctx: Context, workdir: string): GitRunner {
  return {
    async run(args, opts = {}) {
      const command = `git ${args.map(quoteArg).join(' ')}`
      const spec: ShellExecSpec = ctx.shell.resolve({
        command,
        workdir: opts.workdir ?? workdir,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        stdoutMaxBytes: opts.stdoutMaxBytes ?? DEFAULT_STDOUT_BUDGET,
        ...opts.signal === undefined ? {} : { signal: opts.signal },
      })
      const result: ShellRunResult = await ctx.shell.run(spec)
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        timedOut: result.timedOut,
      }
    },
  }
}

/** Read the staged/untracked counts and staged paths from porcelain status. */
function parseStatus(porcelain: string): { staged: string[]; unstagedCount: number } {
  const staged: string[] = []
  let unstagedCount = 0
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 3) continue
    const index = line[0]!
    const worktree = line[1]!
    if (index !== ' ' && index !== '?') staged.push(line.slice(3))
    if (worktree !== ' ' && worktree !== '?') unstagedCount += 1
    if (worktree === '?') unstagedCount += 1
  }
  return { staged, unstagedCount }
}

/** Read one `git log` sample per commit, separated by the unit separator. */
function parseStyleSamples(logText: string): string[] {
  const samples: string[] = []
  for (const raw of logText.split('\u001f')) {
    const sample = raw.replace(/\r?\n/g, '\n').trim()
    if (sample !== '') samples.push(sample)
  }
  return samples
}

/**
 * Collect the repository facts a proposal needs.
 * @param runner - git facade bound to the candidate working directory.
 * @param options - sample count and diff budget.
 * @returns the snapshot; throws {@link NotAGitRepositoryError} outside a repo
 *   and {@link GitExecutionError} for other git failures.
 */
export async function collectRepoState(
  runner: GitRunner,
  options: { styleSamples: number; maxDiffBytes: number; scope: 'staged' | 'all' },
): Promise<GitRepoSnapshot> {
  const toplevel = await runner.run(['rev-parse', '--show-toplevel'])
  if (toplevel.exitCode !== 0) throw new NotAGitRepositoryError()
  const repoRoot = toplevel.stdout.trim()
  if (repoRoot === '') throw new NotAGitRepositoryError()

  const status = await runner.run(['status', '--porcelain=v1'])
  if (status.exitCode !== 0) {
    throw new GitExecutionError('git status failed', status.exitCode, status.stderr)
  }
  const { staged, unstagedCount } = parseStatus(status.stdout)

  const diffArgs = options.scope === 'staged' ? ['diff', '--cached'] : ['diff', 'HEAD']
  const diff = await runner.run(diffArgs, { stdoutMaxBytes: options.maxDiffBytes + 65_536 })
  if (diff.exitCode !== 0) {
    throw new GitExecutionError(`git ${diffArgs.join(' ')} failed`, diff.exitCode, diff.stderr)
  }
  const stagedDiff = truncateUtf8(diff.stdout, options.maxDiffBytes)

  const log = await runner.run([
    'log', `-n${options.styleSamples}`, '--pretty=format:%x1f%s%n%b',
  ])
  let styleSamples: string[] = []
  let hasCommits = false
  if (log.exitCode === 0) {
    styleSamples = parseStyleSamples(log.stdout)
    hasCommits = styleSamples.length > 0
  } else if (!/does not have any commits yet/i.test(log.stderr)) {
    throw new GitExecutionError('git log failed', log.exitCode, log.stderr)
  }

  return {
    repoRoot,
    stagedFiles: staged,
    stagedCount: staged.length,
    stagedDiff: stagedDiff.text,
    stagedDiffTruncated: stagedDiff.truncated,
    unstagedCount,
    styleSamples,
    hasCommits,
  }
}

/**
 * Commit the staged changes with an exact message. The message travels in a
 * temp file (`-F`), so user text never reaches a shell command line.
 * @param runner - git facade bound to the repository.
 * @param message - the final commit message (line endings normalized by the caller).
 * @param signal - caller cancellation.
 * @returns the short hash of the created commit.
 * @throws {@link GitExecutionError} when git rejects the commit.
 */
export async function commitWithMessage(
  runner: GitRunner,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-commit-'))
  try {
    const messagePath = join(dir, 'message.txt')
    await writeFile(messagePath, message, 'utf8')
    const commit = await runner.run(['commit', '-F', messagePath], { timeoutMs: 60_000, signal })
    if (commit.exitCode !== 0) {
      throw new GitExecutionError('git commit failed', commit.exitCode, commit.stderr)
    }
    const hash = await runner.run(['rev-parse', '--short=12', 'HEAD'])
    if (hash.exitCode !== 0) {
      throw new GitExecutionError('git rev-parse failed', hash.exitCode, hash.stderr)
    }
    const shortHash = hash.stdout.trim()
    if (shortHash === '') throw new GitExecutionError('git rev-parse returned no hash', 0, '')
    return shortHash
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
