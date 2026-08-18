import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { Session, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import {
  findProposalPayload, GitCommitService, parseProposalPayload,
} from '../src/service.ts'
import type { CommitStyle, GitCommitProposalPayload } from '../src/types.ts'

/** A scripted git facade driven by a queue of response factories. */
function scriptedRunner(scripts: Array<(args: readonly string[], spec: ShellExecSpec) => ShellRunResult>) {
  const queue = [...scripts]
  const calls: Array<readonly string[]> = []
  return {
    calls,
    runner: {
      resolve(spec: ShellExecSpec): ShellExecSpec {
        return { command: spec.command, workdir: spec.workdir, timeoutMs: spec.timeoutMs, stdoutMaxBytes: spec.stdoutMaxBytes, signal: spec.signal }
      },
      async run(spec: ShellExecSpec): Promise<ShellRunResult> {
        // Strip the surrounding single quotes our quoteArg adds around each literal.
        const args = spec.command
          .replace(/^git /, '')
          .split(' ')
          .filter(Boolean)
          .map(arg => arg.replace(/^'(.*)'$/, '$1'))
        calls.push(args)
        const next = queue.shift()
        if (next === undefined) throw new Error('runner received more invocations than scripted')
        return next(args, spec)
      },
    },
  }
}

function ok(stdout: string, stderr: string = ''): ShellRunResult {
  return { exitCode: 0, signal: null, timedOut: false, timeoutMs: 0, stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } }
}

function fail(stderr: string, exitCode: number = 1): ShellRunResult {
  return { exitCode, signal: null, timedOut: false, timeoutMs: 0, stdout: { text: '', truncated: false }, stderr: { text: stderr, truncated: false } }
}

/** Build a Session whose header declares one cwd. */
function makeSession(cwd: string, seed: readonly SessionEvent[] = []): Session {
  return Session.create(SessionId('s1'), seed, {
    version: 0,
    id: SessionId('s1'),
    createdAt: 0,
    cwd,
  })
}

interface FakeLLM {
  readonly chunks: ReadonlyArray<{ type: 'text-delta'; index: number; text: string } | { type: 'finish'; reason: { kind: 'stop' } }>
  readonly route: LlmCallConfig
}

function buildCtx(runner: ReturnType<typeof scriptedRunner>['runner'], llm: FakeLLM): Context {
  return {
    shell: runner,
    llm: {
      async *stream(): AsyncIterable<unknown> {
        for (const chunk of llm.chunks) yield chunk
      },
    },
    logger: { warn: () => undefined, info: () => () => undefined, error: () => () => undefined },
  } as unknown as Context
}

const baseConfig = resolveConfig({
  styleSamples: 5,
  maxDiffBytes: 1024,
  maxInputBytes: 4096,
  maxOutputTokens: 64,
  timeoutMs: 1000,
  provider: 'deepseek',
  model: 'deepseek-chat',
})

const validProposal = (overrides: Partial<GitCommitProposalPayload> = {}): GitCommitProposalPayload => ({
  kind: 'proposal',
  proposalId: 'git-commit-deadbeef' as GitCommitProposalPayload['proposalId'],
  style: 'complete',
  message: 'fix: subject\n\nbody',
  stagedFiles: ['src/a.ts'],
  stagedCount: 1,
  unstagedCount: 0,
  repoRoot: '/repo',
  generatedFrom: 'history',
  ...overrides,
})

describe('parseProposalPayload', () => {
  it('round-trips a valid payload', () => {
    const payload = validProposal()
    expect(parseProposalPayload(payload)).toEqual(payload)
  })

  it('rejects malformed payloads', () => {
    expect(parseProposalPayload(null)).toBeUndefined()
    expect(parseProposalPayload(undefined)).toBeUndefined()
    expect(parseProposalPayload('string')).toBeUndefined()
    expect(parseProposalPayload({ kind: 'proposal' })).toBeUndefined()
    expect(parseProposalPayload({ ...validProposal(), style: 'narrative' })).toBeUndefined()
    expect(parseProposalPayload({ ...validProposal(), generatedFrom: 'unknown' })).toBeUndefined()
  })
})

describe('GitCommitService.propose', () => {
  it('returns the generated proposal with history samples', async () => {
    const { runner, calls } = scriptedRunner([
      () => ok('/repo\n'),
      () => ok('M  src/a.ts\n'),
      () => ok('diff --cached\n+line\n'),
      () => ok('\u001fprevious: commit message\n'),
    ])
    const ctx = buildCtx(runner, {
      route: { provider: 'deepseek', model: 'deepseek-chat' },
      chunks: [
        { type: 'text-delta', index: 0, text: '{"subject":"feat: add", "body":"details"}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const service = new GitCommitService(ctx, baseConfig)
    const session = makeSession('/repo')
    const outcome = await service.propose(session, { style: 'complete', scope: 'staged', signal: new AbortController().signal })
    expect(outcome.kind).toBe('proposal')
    if (outcome.kind === 'proposal') {
      expect(outcome.style).toBe<CommitStyle>('complete')
      expect(outcome.message).toBe('feat: add\n\ndetails')
      expect(outcome.repoRoot).toBe('/repo')
      expect(outcome.stagedCount).toBe(1)
      expect(outcome.generatedFrom).toBe('history')
    }
    expect(calls[0]).toEqual(['rev-parse', '--show-toplevel'])
    expect(calls[1]).toEqual(['status', '--porcelain=v1'])
  })

  it('returns a nothing-staged outcome when nothing is staged', async () => {
    const { runner } = scriptedRunner([
      () => ok('/repo\n'),
      () => ok('\n'), // empty status
      () => ok(''),
      () => ({ exitCode: 128, stdout: '', stderr: { text: 'fatal: your current branch does not have any commits yet', truncated: false }, timedOut: false }),
    ])
    const ctx = buildCtx(runner, { route: { provider: 'deepseek', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const outcome = await service.propose(makeSession('/repo'), { style: 'complete', scope: 'staged', signal: new AbortController().signal })
    expect(outcome.kind).toBe('nothing-staged')
  })

  it('returns an error outcome when not a git repository', async () => {
    const { runner } = scriptedRunner([
      () => ({ exitCode: 128, stdout: { text: '', truncated: false }, stderr: { text: 'fatal: not a git repository', truncated: false }, signal: null, timedOut: false, timeoutMs: 0 }),
    ])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const outcome = await service.propose(makeSession('/repo'), { style: 'complete', scope: 'staged', signal: new AbortController().signal })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.reason).toMatch(/不是 git 仓库/)
  })

  it('falls back to the session route when config provider is unset', async () => {
    const { runner } = scriptedRunner([
      () => ok('/repo\n'),
      () => ok('M  src/a.ts\n'),
      () => ok('+line\n'),
      () => ok('\u001fprevious\n'),
    ])
    const ctx = buildCtx(runner, {
      route: { provider: 'deepseek', model: 'chat' },
      chunks: [
        { type: 'text-delta', index: 0, text: '{"subject":"x"}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const service = new GitCommitService(ctx, baseConfig) // no provider/model pair
    const session = makeSession('/repo')
    const headerEvent: SessionEvent<'request/header'> = {
      type: 'request/header',
      seq: 0,
      time: 0,
      data: { header: { config: { provider: 'logged-provider', model: 'logged-model' } }, reason: 'initial' },
    }
    session.append('request/header', headerEvent.data)
    const outcome = await service.propose(session, { style: 'concise', scope: 'staged', signal: new AbortController().signal })
    expect(outcome.kind).toBe('proposal')
  })
})

describe('GitCommitService.commit', () => {
  it('rejects an empty message', async () => {
    const { runner } = scriptedRunner([])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const outcome = await service.commit(makeSession('/repo'), {
      message: '   ', signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ kind: 'error', reason: '提交消息不能为空' })
  })

  it('commits and returns the short hash when no proposal is supplied (hand-typed path)', async () => {
    const { runner, calls } = scriptedRunner([
      () => ok('src/a.ts\n'),
      () => ok(''),
      () => ok('abcdef123456\n'),
    ])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const outcome = await service.commit(makeSession('/repo'), {
      message: 'fix: hand commit', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.hash).toBe('abcdef123456')
    expect(calls[0]).toEqual(['diff', '--cached', '--name-only'])
    expect(calls[1]).toEqual(['commit', '-F', expect.any(String)])
    expect(calls[2]).toEqual(['rev-parse', '--short=12', 'HEAD'])
  })

  it('rejects when the staged file set no longer matches the durable proposal', async () => {
    const { runner } = scriptedRunner([
      () => ok('src/a.ts\nsrc/new.ts\n'), // staged set diverged from the proposal's ['src/a.ts']
    ])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const session = makeSession('/repo')
    const proposal = validProposal({ proposalId: 'git-commit-proposal-1' as GitCommitProposalPayload['proposalId'] })
    const content: ContentBlock[] = [{ type: 'text', text: 'fix: ...' }]
    const resultEvent: SessionEvent<'tool/result'> = {
      type: 'tool/result',
      seq: session.events.length,
      time: 0,
      data: {
        turn: 0,
        step: 0,
        message: { role: 'toolResult', content, toolCallId: 'call-1' },
        meta: proposal,
      },
    }
    session.append('tool/result', resultEvent.data, { surfaceOp: 'append' })
    const outcome = await service.commit(session, {
      proposalId: proposal.proposalId, message: proposal.message, signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.reason).toMatch(/暂存内容与提案不一致/)
  })

  it('commits when the staged set matches the proposal', async () => {
    const { runner } = scriptedRunner([
      () => ok('src/a.ts\n'),
      () => ok(''),
      () => ok('cafebabe\n'),
    ])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const session = makeSession('/repo')
    const proposal = validProposal({ proposalId: 'git-commit-proposal-2' as GitCommitProposalPayload['proposalId'] })
    session.append('tool/result', {
      turn: 0,
      step: 0,
      message: { role: 'toolResult', content: [{ type: 'text', text: proposal.message }], toolCallId: 'call-2' },
      meta: proposal,
    } as SessionEventMap['tool/result'], { surfaceOp: 'append' })
    const outcome = await service.commit(session, {
      proposalId: proposal.proposalId, message: 'edited body', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.hash).toBe('cafebabe')
  })

  it('returns error outcome when git commit rejects (hook failure)', async () => {
    const { runner } = scriptedRunner([
      () => ok('src/a.ts\n'),
      () => fail('commit-msg hook rejected'),
    ])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const outcome = await service.commit(makeSession('/repo'), { message: 'fix', signal: new AbortController().signal })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.reason).toMatch(/commit-msg hook rejected/)
  })

  it('returns error when the proposalId has no matching durable record', async () => {
    const { runner } = scriptedRunner([])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const outcome = await service.commit(makeSession('/repo'), {
      proposalId: 'git-commit-missing' as GitCommitProposalPayload['proposalId'],
      message: 'fix', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.reason).toMatch(/未找到对应的提案/)
  })

  it('returns error when the index is empty', async () => {
    const { runner } = scriptedRunner([
      () => ok('\n'), // empty staged list
    ])
    const ctx = buildCtx(runner, { route: { provider: 'p', model: 'm' }, chunks: [] })
    const service = new GitCommitService(ctx, baseConfig)
    const outcome = await service.commit(makeSession('/repo'), {
      message: 'fix', signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.reason).toMatch(/暂存区已清空/)
  })
})

describe('findProposalPayload', () => {
  it('returns the most recent matching proposal from the log', () => {
    const payload = validProposal({ proposalId: 'git-commit-x' as GitCommitProposalPayload['proposalId'] })
    const newer = validProposal({ proposalId: 'git-commit-y' as GitCommitProposalPayload['proposalId'], message: 'newer' })
    const events: SessionEvent[] = [
      { type: 'tool/result', seq: 0, time: 0, turn: 0, step: 0, data: { message: { role: 'toolResult', content: [], toolCallId: 'a' }, meta: payload } },
      { type: 'tool/result', seq: 1, time: 0, turn: 0, step: 0, data: { message: { role: 'toolResult', content: [], toolCallId: 'b' }, meta: newer } },
    ]
    expect(findProposalPayload(events, 'git-commit-y' as GitCommitProposalPayload['proposalId']))
      .toEqual(newer)
  })

  it('returns undefined when no tool/result carries the id', () => {
    expect(findProposalPayload([], 'git-commit-x' as GitCommitProposalPayload['proposalId']))
      .toBeUndefined()
  })
})