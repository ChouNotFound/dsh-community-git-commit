import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectRepoState,
  commitWithMessage,
  GitExecutionError,
  NotAGitRepositoryError,
  quoteArg,
  truncateUtf8,
  type GitRunner,
  type GitRunResult,
} from '../src/git.ts'

describe('quoteArg', () => {
  it('wraps plain text in single quotes', () => {
    expect(quoteArg('abc')).toBe("'abc'")
  })

  it('escapes embedded single quotes for PowerShell', () => {
    expect(quoteArg("a'b")).toBe("'a''b'")
  })

  it('preserves spaces inside the quoted argument', () => {
    expect(quoteArg('with spaces')).toBe("'with spaces'")
  })
})

describe('truncateUtf8', () => {
  it('returns the input unchanged when within budget', () => {
    const text = 'short diff body'
    const result = truncateUtf8(text, 64)
    expect(result.text).toBe(text)
    expect(result.truncated).toBe(false)
  })

  it('truncates long inputs at a UTF-8 boundary', () => {
    const long = '\u4e2d'.repeat(50) // 50 CJK characters, 3 bytes each
    const result = truncateUtf8(long, 30)
    expect(result.truncated).toBe(true)
    expect(result.text.endsWith('[diff truncated]')).toBe(true)
    // No half-character at the cut.
    const cut = result.text.split('\n')[0] ?? ''
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(30)
  })
})

function scriptRunner(scripts: Array<(command: string) => GitRunResult>): GitRunner {
  let index = 0
  return {
    async run(args, _opts = {}) {
      const command = `git ${args.join(' ')}`
      const script = scripts[index] ?? scripts[scripts.length - 1]
      index += 1
      if (script === undefined) throw new Error('no script for invocation')
      return script(command)
    },
  }
}

function okResult(stdout: string, stderr: string = ''): GitRunResult {
  return { exitCode: 0, stdout, stderr, timedOut: false }
}

describe('collectRepoState', () => {
  it('rejects when rev-parse fails (not a git repository)', async () => {
    const runner = scriptRunner([
      () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', timedOut: false }),
    ])
    await expect(collectRepoState(runner, { styleSamples: 20, maxDiffBytes: 1024, scope: 'staged' }))
      .rejects.toBeInstanceOf(NotAGitRepositoryError)
  })

  it('parses staged paths and counts, and treats empty log as no-commits', async () => {
    const runner = scriptRunner([
      () => okResult('/repo\n'),
      () => okResult('M  src/a.ts\nMM src/b.ts\n?? new.ts\n'),
      () => okResult('diff --cached --git a/src/a.ts b/src/a.ts\n+line\n'),
      () => ({ exitCode: 128, stdout: '', stderr: 'fatal: your current branch does not have any commits yet', timedOut: false }),
    ])
    const state = await collectRepoState(runner, { styleSamples: 20, maxDiffBytes: 1024, scope: 'staged' })
    expect(state.repoRoot).toBe('/repo')
    expect(state.stagedFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(state.stagedCount).toBe(2)
    expect(state.unstagedCount).toBe(2) // MM src/b.ts (worktree dirty) + ?? new.ts (untracked)
    expect(state.hasCommits).toBe(false)
    expect(state.styleSamples).toEqual([])
    expect(state.stagedDiff).toContain('+line')
  })

  it('parses style samples separated by the unit separator', async () => {
    const runner = scriptRunner([
      () => okResult('/repo\n'),
      () => okResult('M  src/a.ts\n'),
      () => okResult(''),
      () => okResult('\u001ffeat: new button\u001ffix: clamp timestamps\n'),
    ])
    const state = await collectRepoState(runner, { styleSamples: 20, maxDiffBytes: 1024, scope: 'staged' })
    expect(state.styleSamples).toEqual([
      'feat: new button',
      'fix: clamp timestamps',
    ])
    expect(state.hasCommits).toBe(true)
  })
})

describe('commitWithMessage', () => {
  it('writes the message to a temp file and passes it via -F', async () => {
    let capturedPath: string | undefined
    let messageFileContent: string | undefined
    const runner: GitRunner = {
      async run(args, _opts = {}) {
        const command = `git ${args.join(' ')}`
        const commitIndex = args.indexOf('commit')
        if (commitIndex >= 0 && args[commitIndex + 1] === '-F') {
          capturedPath = args[commitIndex + 2]
          messageFileContent = await readFile(capturedPath!, 'utf8')
          return okResult('', '')
        }
        if (args[0] === 'rev-parse') return okResult('abcdef123456\n')
        throw new GitExecutionError(`unexpected git invocation: ${command}`, 0, '')
      },
    }
    const dir = await mkdtemp(join(tmpdir(), 'dsh-test-'))
    const dirCleanup = await (async () => {
      try {
        const hash = await commitWithMessage(runner, 'first line\n\nsecond line\n')
        expect(hash).toBe('abcdef123456')
        expect(capturedPath).toBeDefined()
        expect(messageFileContent).toBe('first line\n\nsecond line\n')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })()
    expect(dirCleanup).toBeUndefined()
  })

  it('propagates GitExecutionError when git commit rejects', async () => {
    const runner: GitRunner = {
      async run(args) {
        if (args[0] === 'commit') {
          return { exitCode: 1, stdout: '', stderr: 'commit-msg hook rejected\n', timedOut: false }
        }
        if (args[0] === 'rev-parse') return okResult('deadbeef')
        return okResult('')
      },
    }
    await expect(commitWithMessage(runner, 'msg\n')).rejects.toBeInstanceOf(GitExecutionError)
  })
})

it('(smoke) writeFile+readFile preserves UTF-8 without BOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-utf8-'))
  try {
    const path = join(dir, 'm.txt')
    await writeFile(path, '中文', 'utf8')
    expect(await readFile(path, 'utf8')).toBe('中文')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})