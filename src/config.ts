/**
 * Plugin configuration: deployment-varying generation policy. Every field has
 * a schema default so the bundle works out of the box; a deployment overrides
 * it in its profile cordis.patch.yml.
 * @module @dsh-community/git-commit/config
 */

import z from '@deepseek-ai/schemastery'

/** Validated loader configuration for the git-commit plugin. */
export interface Config {
  /** How many recent commits are sampled as style examples (default 20). */
  styleSamples: number
  /** Maximum UTF-8 bytes of the diff sent to the model; longer diffs truncate (default 65536). */
  maxDiffBytes: number
  /** Maximum UTF-8 bytes of the framed JSON prompt (default 131072). */
  maxInputBytes: number
  /** Auxiliary generation output-token cap (default 512). */
  maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds (default 60000). */
  timeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  model?: string
}

/** Loader schema with deployment defaults. */
export const Config: z<Config> = z.object({
  styleSamples: z.natural().min(1).default(20),
  maxDiffBytes: z.natural().min(1).default(65_536),
  maxInputBytes: z.natural().min(1).default(131_072),
  maxOutputTokens: z.natural().min(1).default(512),
  timeoutMs: z.natural().min(1).default(60_000),
  provider: z.string(),
  model: z.string(),
})

/** Resolved plugin configuration (z defaults materialized). */
export type ResolvedConfig = Required<Config>

/**
 * Validate cross-field configuration invariants the schema cannot express.
 * @param config - untrusted loader configuration.
 * @returns the resolved configuration.
 * @throws when `provider` and `model` are not supplied together.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('git-commit: provider and model must be supplied together')
  }
  if (hasProvider
    && (config.provider === '' || config.model === '')) {
    throw new Error('git-commit: provider and model overrides must be non-empty strings')
  }
  return config as ResolvedConfig
}
