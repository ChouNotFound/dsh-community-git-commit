/**
 * The model-facing `git_commit_propose` tool: a Consumer of the commit
 * pipeline so the model can generate proposals on request. Committing stays
 * with the user through the UI card.
 * @module @dsh-community/git-commit/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitCommitService, ProposeOutcome } from './service.js'

/** The exact model-facing tool name. */
export const COMMIT_TOOL_NAME = 'git_commit_propose'

/** Render one pipeline outcome as model-facing text. */
export function renderProposeOutcome(outcome: ProposeOutcome, styleLabel: string): string {
  switch (outcome.kind) {
    case 'proposal':
      return [
        `Generated a ${styleLabel} commit message for ${outcome.stagedCount} staged file(s) in ${outcome.repoRoot}:`,
        '',
        outcome.message,
        '',
        'The proposal card in the UI lets the user review, edit, and commit it.',
      ].join('\n')
    case 'nothing-staged':
      return [
        `Nothing is staged in ${outcome.repoRoot} (${outcome.unstagedCount} unstaged change(s)).`,
        "Stage changes first, or call the tool with scope='all' to include unstaged changes.",
      ].join('\n')
    case 'error':
      return `Could not generate a commit message: ${outcome.reason}`
  }
}

/** Register the commit-propose tool as one effect-owned registration. */
export function registerCommitTool(ctx: Context, service: GitCommitService): () => void {
  return ctx.tools.register(defineTool({
    name: COMMIT_TOOL_NAME,
    description: [
      'Generate a git commit message for the staged changes of the repository in the session workspace,',
      'imitating the style of recent commits. Use it when the user asks to generate, draft, or suggest a',
      'commit message. The result appears as a reviewable proposal card; committing is a user action.',
    ].join(' '),
    parameters: {
      style: {
        type: 'string',
        enum: ['complete', 'concise'],
        description: "Message style. 'complete' adds a body with the what and the why; 'concise' is a one-line subject. Defaults to 'complete'.",
      },
      scope: {
        type: 'string',
        enum: ['staged', 'all'],
        description: "Which changes to summarize. 'staged' (default) covers the index only; 'all' also includes unstaged changes.",
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['proposal', 'nothing-staged', 'error'], required: true },
          proposalId: { type: 'string' },
          style: { type: 'string', enum: ['complete', 'concise'] },
          message: { type: 'string' },
          stagedFiles: { type: 'array', items: { type: 'string' } },
          stagedCount: { type: 'integer' },
          unstagedCount: { type: 'integer' },
          repoRoot: { type: 'string' },
          generatedFrom: { type: 'string', enum: ['history', 'generic'] },
          reason: { type: 'string' },
        },
        additionalProperties: false,
      },
      // The output schema infers a permissive object type (most fields optional).
      // The tool body returns the typed ProposeOutcome union, which is structurally
      // assignable; we render and project by trusting the union's discriminator.
      render(_args, value) {
        const outcome = value as unknown as ProposeOutcome
        const styleLabel = outcome.kind === 'proposal' && outcome.style === 'concise' ? 'concise' : 'complete'
        return [{ type: 'text', text: renderProposeOutcome(outcome, styleLabel) }]
      },
      // The exact value is the durable card payload; pass through unchanged.
      presentationMeta(_args, value) {
        return value
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error(`${COMMIT_TOOL_NAME} requires a calling agent (exec.agent was undefined)`)
      }
      return service.propose(agent.session, {
        style: args.style ?? 'complete',
        scope: args.scope ?? 'staged',
        signal: exec.signal,
      })
    },
  }))
}