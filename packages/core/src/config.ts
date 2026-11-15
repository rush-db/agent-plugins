import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createOpenAICompatibleEmbedder,
  type OpenAICompatibleEmbedderConfig,
  type RushDBMemoryClientOptions
} from '@rushdb/agent-memory-contract'

export type AutoContext = 'off' | 'recall' | 'recall+persist'

export const AUTO_CONTEXT_VALUES: ReadonlyArray<AutoContext> = ['off', 'recall', 'recall+persist']
export const DEFAULT_AUTO_CONTEXT: AutoContext = 'off'

/** The user's own config file, `${XDG_CONFIG_HOME:-~/.config}/rushdb/config.json`. Plugins never write it. */
export interface ConfigFile {
  apiKey?: string
  apiUrl?: string
  autoContext?: string
  contextScope?: string
  engineUrl?: string
  engineToken?: string
  engineScope?: string
  embedding?: {
    baseUrl?: string
    apiKey?: string
    model?: string
    dimensions?: number
  }
}

interface ResolvedBase {
  stateDir: string
  configFile: string
  /** Problems worth logging once a logger exists (bad values, a config file others can read). */
  warnings: string[]
}

export type ResolvedConfig =
  | (ResolvedBase & { status: 'off'; autoContext: 'off' })
  | (ResolvedBase & { status: 'disabled'; autoContext: Exclude<AutoContext, 'off'>; reason: string })
  | (ResolvedBase & {
      status: 'enabled'
      autoContext: Exclude<AutoContext, 'off'>
      connection: RushDBMemoryClientOptions
      contextScope?: string
      /** Credentials to mask in logs. */
      secrets: string[]
    })

export interface ResolveConfigOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  /** Reads and parses the config file; returns undefined when there is none. */
  readConfigFile?: (path: string, warnings: string[]) => ConfigFile | undefined
}

/**
 * An env value, or undefined when unset, blank, or an unexpanded placeholder such as `${user_config.api_key}`
 * (Qwen passes Claude's `userConfig` references through literally).
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  if (!value || value.startsWith('${')) return undefined
  return value
}

function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = envValue(env, name)
    if (value) return value
  }
  return undefined
}

function fileText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  return join(envValue(env, 'XDG_CONFIG_HOME') ?? join(homeDir, '.config'), 'rushdb', 'config.json')
}

/** `CLAUDE_PLUGIN_DATA`, then `PLUGIN_DATA`, then `${XDG_STATE_HOME:-~/.local/state}/rushdb`. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  return (
    firstEnv(env, 'CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA') ??
    join(envValue(env, 'XDG_STATE_HOME') ?? join(homeDir, '.local', 'state'), 'rushdb')
  )
}

export function readConfigFile(path: string, warnings: string[]): ConfigFile | undefined {
  let text: string
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      warnings.push(`${path} can be read by other users; run chmod 600 on it`)
    }
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const input = parsed as Record<string, unknown>
      // Accept the snake_case names of the plugin settings too.
      const pick = (camel: string, snake: string) => fileText(input[camel]) ?? fileText(input[snake])
      const embedding = input.embedding && typeof input.embedding === 'object' ? input.embedding : undefined
      return {
        apiKey: pick('apiKey', 'api_key'),
        apiUrl: pick('apiUrl', 'api_url'),
        autoContext: pick('autoContext', 'auto_context'),
        contextScope: pick('contextScope', 'context_scope'),
        engineUrl: pick('engineUrl', 'engine_url'),
        engineToken: pick('engineToken', 'engine_token'),
        engineScope: pick('engineScope', 'engine_scope'),
        embedding: embedding as ConfigFile['embedding']
      }
    }
  } catch {
    // reported below
  }
  warnings.push(`${path} is not a JSON object; ignoring it`)
  return undefined
}

function parseAutoContext(value: string | undefined, warnings: string[]): AutoContext | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if ((AUTO_CONTEXT_VALUES as ReadonlyArray<string>).includes(normalized)) return normalized as AutoContext
  warnings.push(`auto_context "${value}" is not one of ${AUTO_CONTEXT_VALUES.join(', ')}; using off`)
  return 'off'
}

function parseEmbedding(values: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number }): {
  embedding?: OpenAICompatibleEmbedderConfig
  embeddingError?: string
} {
  const { baseUrl, apiKey, model, dimensions } = values
  if (!apiKey && !model && dimensions === undefined) return {}
  if (!apiKey || !model || !Number.isInteger(dimensions) || (dimensions as number) <= 0) {
    return {
      embeddingError:
        'set RUSHDB_EMBEDDING_API_KEY, RUSHDB_EMBEDDING_MODEL and RUSHDB_EMBEDDING_DIMENSIONS (a positive integer) together'
    }
  }
  return { embedding: { baseUrl, apiKey, model, dimensions: dimensions as number } }
}

/**
 * Resolves the automatic-context switch, the credentials and the state directory.
 *
 * - Switch: `CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT`, `RUSHDB_AUTO_CONTEXT`, then the config file; default `off`.
 *   When the env turns it off, nothing else is read.
 * - Key: `CLAUDE_PLUGIN_OPTION_API_KEY`, `RUSHDB_API_KEY`, then the config file.
 * - Target: `RUSHDB_API_URL` (Cloud by default), or a standalone engine in direct mode with `RUSHDB_ENGINE_URL` and
 *   `RUSHDB_ENGINE_TOKEN`, which also needs an embedding provider.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()
  const warnings: string[] = []
  const stateDir = resolveStateDir(env, homeDir)
  const configFile = configFilePath(env, homeDir)
  const base = { stateDir, configFile, warnings }

  const envSwitch = parseAutoContext(
    firstEnv(env, 'CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT', 'RUSHDB_AUTO_CONTEXT'),
    warnings
  )
  if (envSwitch === 'off') return { ...base, status: 'off', autoContext: 'off' }

  const file = (options.readConfigFile ?? readConfigFile)(configFile, warnings) ?? {}
  const autoContext = envSwitch ?? parseAutoContext(file.autoContext, warnings) ?? DEFAULT_AUTO_CONTEXT
  if (autoContext === 'off') return { ...base, status: 'off', autoContext }

  const text = (fileValue: string | undefined, ...names: string[]) => firstEnv(env, ...names) ?? fileValue
  const apiKey = text(file.apiKey, 'CLAUDE_PLUGIN_OPTION_API_KEY', 'RUSHDB_API_KEY')
  const apiUrl = text(file.apiUrl, 'CLAUDE_PLUGIN_OPTION_API_URL', 'RUSHDB_API_URL')
  const engineUrl = text(file.engineUrl, 'RUSHDB_ENGINE_URL')
  const engineToken = text(file.engineToken, 'RUSHDB_ENGINE_TOKEN')
  const engineScope = text(file.engineScope, 'RUSHDB_ENGINE_SCOPE')
  const contextScope = text(file.contextScope, 'CLAUDE_PLUGIN_OPTION_CONTEXT_SCOPE', 'RUSHDB_CONTEXT_SCOPE')
  const envDimensions = envValue(env, 'RUSHDB_EMBEDDING_DIMENSIONS')
  const { embedding, embeddingError } = parseEmbedding({
    baseUrl: text(fileText(file.embedding?.baseUrl), 'RUSHDB_EMBEDDING_BASE_URL'),
    apiKey: text(fileText(file.embedding?.apiKey), 'RUSHDB_EMBEDDING_API_KEY'),
    model: text(fileText(file.embedding?.model), 'RUSHDB_EMBEDDING_MODEL'),
    dimensions: envDimensions !== undefined ? Number(envDimensions) : file.embedding?.dimensions
  })
  const disabled = (reason: string): ResolvedConfig => ({ ...base, status: 'disabled', autoContext, reason })

  if (embeddingError) return disabled(`RushDB automatic context is disabled: ${embeddingError}`)
  const embedder = embedding ? createOpenAICompatibleEmbedder(embedding) : undefined
  const secrets = [apiKey, engineToken, embedding?.apiKey].filter((value): value is string => Boolean(value))

  if (engineUrl) {
    if (!engineToken)
      return disabled('RushDB automatic context is disabled: RUSHDB_ENGINE_URL needs RUSHDB_ENGINE_TOKEN')
    if (!embedder) {
      return disabled(
        'RushDB automatic context is disabled: a standalone RushDB engine has no managed embeddings; configure an embedding provider (RUSHDB_EMBEDDING_API_KEY, RUSHDB_EMBEDDING_MODEL, RUSHDB_EMBEDDING_DIMENSIONS)'
      )
    }
    return {
      ...base,
      status: 'enabled',
      autoContext,
      connection: { engineUrl, engineToken, scope: engineScope, embedder },
      contextScope,
      secrets
    }
  }
  if (!apiKey) {
    return disabled(
      'RushDB automatic context is disabled until RUSHDB_API_KEY (RushDB Cloud) or RUSHDB_ENGINE_URL and RUSHDB_ENGINE_TOKEN (a standalone engine) is set'
    )
  }
  return {
    ...base,
    status: 'enabled',
    autoContext,
    connection: { apiKey, url: apiUrl, embedder },
    contextScope,
    secrets
  }
}

export function persistsContext(config: ResolvedConfig): boolean {
  return config.status === 'enabled' && config.autoContext === 'recall+persist'
}
