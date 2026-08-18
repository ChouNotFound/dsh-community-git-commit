import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  commitOutcomeToCommandResult, outcomeToCommandResult, parseCommitPayload, parseStyleToken,
} from '../src/commands.ts'

describe('parseStyleToken', () => {
  it('accepts complete and concise tokens', () => {
    expect(parseStyleToken('complete')).toBe('complete')
    expect(parseStyleToken('concise')).toBe('concise')
    expect(parseStyleToken(' CONCISE ')).toBe('concise')
  })

  it('returns undefined for unknown or empty tokens', () => {
    expect(parseStyleToken('')).toBeUndefined()
    expect(parseStyleToken('narrative')).toBeUndefined()
  })
})

describe('parseCommitPayload', () => {
  it('returns the structured payload when JSON is valid', () => {
    expect(parseCommitPayload(JSON.stringify({ proposalId: 'git-commit-x', message: 'fix' })))
      .toEqual({ proposalId: 'git-commit-x', message: 'fix' })
  })

  it('returns null when JSON parses but fields are missing', () => {
    expect(parseCommitPayload('{}')).toBeNull()
    expect(parseCommitPayload(JSON.stringify({ proposalId: 'x' }))).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseCommitPayload('not json')).toBeNull()
  })
})

describe('outcomeToCommandResult', () => {
  it('maps proposal outcomes to a success result carrying the message', () => {
    const result = outcomeToCommandResult({
      kind: 'proposal',
      proposalId: 'git-commit-x' as never,
      style: 'complete',
      message: 'fix: thing',
      stagedFiles: ['a.ts'],
      stagedCount: 1,
      unstagedCount: 0,
      repoRoot: '/repo',
      generatedFrom: 'history',
    })
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('fix: thing')
  })

  it('maps nothing-staged and error outcomes to error results', () => {
    expect(outcomeToCommandResult({ kind: 'nothing-staged', repoRoot: '/repo', unstagedCount: 3 }).kind)
      .toBe('error')
    expect(outcomeToCommandResult({ kind: 'error', reason: 'boom' })).toEqual({ kind: 'error', text: 'boom' })
  })
})

describe('commitOutcomeToCommandResult', () => {
  it('carries the hash on success', () => {
    const result = commitOutcomeToCommandResult({ kind: 'ok', hash: 'deadbeef' })
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('deadbeef')
  })

  it('carries the reason on failure', () => {
    expect(commitOutcomeToCommandResult({ kind: 'error', reason: 'nothing staged' }))
      .toEqual({ kind: 'error', text: 'nothing staged' })
  })
})

/** Build a fake CommandInvocation with the supplied session and raw input. */
function fakeInvocation(session: Session, rawInput: string, signal = new AbortController().signal): CommandInvocation {
  const fakeAgent: Agent = { session } as unknown as Agent
  return {
    commandId: 'cmd-1' as CommandInvocation['commandId'],
    agent: fakeAgent,
    rawInput,
    signal,
  }
}

it('(smoke) build a CommandInvocation with a real Session (no provider calls)', () => {
  const session: Session = Session.create(SessionId('s1'), [], { version: 0, id: SessionId('s1'), createdAt: 0, cwd: '/repo' })
  const inv = fakeInvocation(session, 'complete')
  expect(inv.rawInput).toBe('complete')
  expect(inv.agent.session).toBe(session)
  // session.events snapshot
  const _events: readonly SessionEvent[] = session.events
  expect(_events.length).toBe(1) // Session.create appends a session/end-seed marker
})