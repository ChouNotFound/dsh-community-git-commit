/**
 * The git-commit plugin entry: registers the commit pipeline, the model tool,
 * and the slash commands as fiber-owned effects. The browser half lives in
 * `@dsh-community/ui-git-commit`, discovered through its `dsh.client`
 * declaration.
 * @module @dsh-community/git-commit
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerCommitCommands } from './commands.js'
import { Config, resolveConfig } from './config.js'
import { GitCommitService } from './service.js'
import { registerCommitTool } from './tool.js'

export { Config } from './config'
export type { Config as GitCommitPluginConfig } from './config'
export * from './types'

export const name = 'git-commit'

/** Required services: tool registry, shell seam, LLM, and human commands. */
export const inject = ['tools', 'shell', 'llm', 'commands']

/** Plugin body: compose the pipeline and its two consumers. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const service = new GitCommitService(ctx, resolved)
  ctx.effect(() => registerCommitTool(ctx, service), 'git-commit: tool')
  ctx.effect(() => registerCommitCommands(ctx, service), 'git-commit: commands')
}
