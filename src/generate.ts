/**
 * Auxiliary LLM generation of commit messages: JSON framing, the style
 * instruction, streaming, and strict output validation. Mirrors the
 * `dsh-session-title-llm` auxiliary-call pattern (deadline, BlockAssembler,
 * text-only output, exact request logged by the caller).
 * @module @dsh-community/git-commit/generate
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { CommitGeneratedFrom, CommitStyle, GitRoute } from './types.js'

/** Capability-owned timeout reason code for auxiliary commit-message requests. */
export const GIT_COMMIT_TIMEOUT_CODE = 'GIT_COMMIT_TIMEOUT'

/** The generated output failed validation (JSON parse, subject, or shape). */
export class GenerationError extends Error {}

/** One validated generated message plus the exact request that produced it. */
export interface GeneratedCommitMessage {
  readonly message: string
  readonly system: string
  readonly messages: readonly Message[]
  readonly maxTokens: number
}

/** The model-facing instruction, fixed verbatim. */
export function buildSystemPrompt(style: CommitStyle, generatedFrom: CommitGeneratedFrom): string {
  const styleRule = style === 'complete'
    ? [
      'Message format: one subject line (imperative mood, at most 72 characters),',
      'a blank line, then a body paragraph list: what changed and why,',
      'one bullet per main change.',
    ].join('\n')
    : [
      'Message format: ONE subject line only (imperative mood, at most 72 characters).',
      'No body, no trailing period unless the samples use one.',
    ].join('\n')
  const sampleRule = generatedFrom === 'history'
    ? [
      'Imitate the style, wording patterns, and language of the supplied',
      '"styleSamples" commits; the message language follows the majority language of the samples.',
    ].join('\n')
    : 'The repository has no commit history; write a clean conventional message in English.'
  return [
    'You write a git commit message for the supplied staged diff.',
    styleRule,
    sampleRule,
    'Do not add emojis unless the style samples contain them.',
    'Do not list file paths verbatim; summarize intent.',
    'Return ONLY a JSON object with exactly two string fields: {"subject": "...", "body": "..."}.',
    'No markdown fences, no commentary outside the JSON.',
  ].join('\n')
}

/** Frame the exact model input as JSON so diff text cannot break structural delimiters. */
export function frameInput(
  input: { stagedDiff: string; stagedFiles: readonly string[]; styleSamples: readonly string[]; style: CommitStyle },
): string {
  return JSON.stringify(input)
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('git-commit: generated output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('git-commit: generation unexpectedly requested a tool')
    default:
      return new Error(`git-commit: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** Parse and validate the model's JSON answer into a composed message. */
export function composeMessage(text: string, style: CommitStyle): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GenerationError('the model did not return valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GenerationError('the model did not return a JSON object')
  }
  const subject = (parsed as { subject?: unknown }).subject
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new GenerationError('the model returned an empty subject')
  }
  const normalizedSubject = subject.trim().replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
  if (normalizedSubject.length > 200) {
    throw new GenerationError('the model returned an unreasonably long subject')
  }
  const bodyValue = (parsed as { body?: unknown }).body
  const body = typeof bodyValue === 'string'
    ? bodyValue.trim().replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
    : ''
  if (style === 'complete') {
    return body === '' ? normalizedSubject : `${normalizedSubject}\n\n${body}`
  }
  return normalizedSubject
}

/**
 * Generate one commit message through the shared auxiliary LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param opts - resolved route, style, framed input, caps, session, and cancellation.
 * @returns the validated message and the exact request for durable logging.
 */
export async function generateCommitMessage(
  ctx: Context,
  opts: {
    route: GitRoute
    style: CommitStyle
    generatedFrom: CommitGeneratedFrom
    framedInput: string
    maxInputBytes: number
    maxOutputTokens: number
    timeoutMs: number
    sessionId: SessionId
    signal: AbortSignal
  },
): Promise<GeneratedCommitMessage> {
  opts.signal.throwIfAborted()
  const inputBytes = Buffer.byteLength(opts.framedInput, 'utf8')
  if (inputBytes > opts.maxInputBytes) {
    throw new Error(`git-commit: input is ${inputBytes} bytes, exceeding maxInputBytes ${opts.maxInputBytes}`)
  }
  const system = buildSystemPrompt(opts.style, opts.generatedFrom)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: opts.framedInput }],
    source: { kind: 'plugin', plugin: 'git-commit' },
  })]
  using callDeadline = deadline(opts.signal, opts.timeoutMs, GIT_COMMIT_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: opts.route.provider,
    model: opts.route.model,
    messages,
    system,
    maxTokens: opts.maxOutputTokens,
    sessionId: opts.sessionId,
    signal: callDeadline.signal,
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('git-commit: generated output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const message = composeMessage(text, opts.style)
  return { message, system, messages, maxTokens: opts.maxOutputTokens }
}
