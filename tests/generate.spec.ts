import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  buildSystemPrompt,
  composeMessage,
  frameInput,
  generateCommitMessage,
  GenerationError,
} from '../src/generate.ts'

describe('buildSystemPrompt', () => {
  it('emits the complete-style format rule with history samples', () => {
    const prompt = buildSystemPrompt('complete', 'history')
    expect(prompt).toContain('one subject line')
    expect(prompt).toContain('body')
    expect(prompt).toContain('Imitate')
    expect(prompt).toContain('{"subject":')
  })

  it('emits the concise rule for the concise style', () => {
    const prompt = buildSystemPrompt('concise', 'history')
    expect(prompt).toContain('ONE subject line')
  })

  it('emits the generic fallback when no history is available', () => {
    const prompt = buildSystemPrompt('complete', 'generic')
    expect(prompt).toContain('clean conventional message')
  })
})

describe('frameInput', () => {
  it('round-trips text through JSON with newlines preserved', () => {
    const framed = frameInput({
      stagedDiff: 'diff --git\n+one\n+two\n',
      stagedFiles: ['a.ts', 'b.ts'],
      styleSamples: ['feat: a'],
      style: 'complete',
    })
    const parsed = JSON.parse(framed) as { stagedDiff: string; stagedFiles: string[]; styleSamples: string[]; style: string }
    expect(parsed.stagedDiff).toBe('diff --git\n+one\n+two\n')
    expect(parsed.stagedFiles).toEqual(['a.ts', 'b.ts'])
    expect(parsed.style).toBe('complete')
  })
})

describe('composeMessage', () => {
  it('composes complete messages with a body', () => {
    expect(composeMessage(JSON.stringify({ subject: 'fix', body: 'details here' }), 'complete'))
      .toBe('fix\n\ndetails here')
  })

  it('composes concise messages as a one-line subject', () => {
    expect(composeMessage(JSON.stringify({ subject: 'fix', body: 'ignored' }), 'concise'))
      .toBe('fix')
  })

  it('omits the body section when no body is supplied', () => {
    expect(composeMessage(JSON.stringify({ subject: 'fix', body: '' }), 'complete'))
      .toBe('fix')
  })

  it('throws GenerationError for non-JSON input', () => {
    expect(() => composeMessage('not json', 'complete')).toThrow(GenerationError)
  })

  it('throws GenerationError for an empty subject', () => {
    expect(() => composeMessage(JSON.stringify({ subject: '  ', body: 'x' }), 'complete')).toThrow(GenerationError)
  })

  it('throws GenerationError for a non-object payload', () => {
    expect(() => composeMessage(JSON.stringify('subject'), 'complete')).toThrow(GenerationError)
  })

  it('normalizes CRLF to LF in the final message', () => {
    expect(composeMessage(JSON.stringify({ subject: 's\r\n', body: 'one\r\ntwo' }), 'complete'))
      .toBe('s\n\none\ntwo')
  })
})

/** Build a fake LLM context that streams the supplied text chunks. */
function fakeLLMContext(chunks: readonly StreamChunk[]): Context {
  const ctx = {
    llm: {
      async *stream(): AsyncIterable<StreamChunk> {
        for (const chunk of chunks) yield chunk
      },
    },
  } as unknown as Context
  return ctx
}

describe('generateCommitMessage', () => {
  const sessionId = SessionId('s1')
  const route = { provider: 'deepseek', model: 'deepseek-chat' }
  const framedInput = JSON.stringify({ stagedDiff: 'd', stagedFiles: ['a.ts'], styleSamples: [], style: 'complete' })

  it('streams, parses, and composes a valid JSON answer', async () => {
    const ctx = fakeLLMContext([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"subject":"fix",' },
      { type: 'text-delta', index: 0, text: '"body":"details"}' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '{"subject":"fix","body":"details"}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const out = await generateCommitMessage(ctx, {
      route, style: 'complete', generatedFrom: 'generic',
      framedInput, maxInputBytes: 1024, maxOutputTokens: 64, timeoutMs: 1000, sessionId,
      signal: new AbortController().signal,
    })
    expect(out.message).toBe('fix\n\ndetails')
    expect(out.system).toContain('one subject line')
    expect(out.maxTokens).toBe(64)
  })

  it('throws when the model finishes with an error reason', async () => {
    const ctx = fakeLLMContext([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } },
    ])
    await expect(generateCommitMessage(ctx, {
      route, style: 'concise', generatedFrom: 'generic',
      framedInput, maxInputBytes: 1024, maxOutputTokens: 64, timeoutMs: 1000, sessionId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/boom/)
  })

  it('throws when the input exceeds the configured byte budget', async () => {
    const ctx = fakeLLMContext([])
    const huge = 'x'.repeat(64 * 1024 + 1)
    await expect(generateCommitMessage(ctx, {
      route, style: 'complete', generatedFrom: 'generic',
      framedInput: huge, maxInputBytes: 64 * 1024, maxOutputTokens: 64, timeoutMs: 1000, sessionId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/maxInputBytes/)
  })
})