import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createOpenAICompatibleEmbedder, sha256, type RushDBMemoryClientOptions } from '@rushdb/agent-memory-contract'
import { DEFAULT_PROFILE_ID, RECALL_TIMEOUT_MS } from '@rushdb/agent-plugins-core'
import { z, type SecretSource } from './host.ts'

/**
 * Settings of the `rushdb` row. Fields named `...Ref` hold the name of a credential, never its value; it is resolved
 * through dsh's credentials on every use (see `secretSource`).
 */
export interface Config {
  /** Credential holding the RushDB API key. */
  apiKeyRef?: string
  /** RushDB API URL; empty for RushDB Cloud. */
  url?: string
  /** A standalone RushDB engine (direct mode) instead of the API. */
  engineUrl?: string
  /** Credential holding the standalone engine's token. */
  engineTokenRef?: string
  /** Tenant on a multitenant standalone engine. */
  engineScope?: string
  /** OpenAI-compatible embedding provider; a standalone engine has no managed embeddings. */
  embedding?: {
    baseUrl?: string
    apiKeyRef?: string
    model?: string
    dimensions?: number
  }
  /** Profile id in the stored context; hosts that share it share context. */
  profileId?: string
  /** Replaces the project key (the hash of the git remote, or of the working directory). */
  contextScope?: string
  /** Automatic context. Both parts are off by default. */
  autoContext?: {
    /** Before the first step of each turn, add relevant context from earlier sessions. */
    recall?: boolean
    /** Store each finished turn in RushDB. */
    capture?: boolean
  }
  recallLimit?: number
  recallTimeoutMs?: number
  /** Prompts shorter than this don't trigger recall. */
  recallMinChars?: number
  /** Also recall into and capture from subagent sessions. */
  includeSubagents?: boolean
  /** Outbox directory for captured turns; relative paths resolve against `$DSH_HOME`. */
  outboxPath?: string
  /** Keep sessions that received recalled RushDB context out of the session-log upload to DeepSeek. */
  excludeFromLogUpload?: boolean
}

export const DEFAULT_API_KEY_REF = 'RUSHDB_API_KEY'
export const DEFAULT_ENGINE_TOKEN_REF = 'RUSHDB_ENGINE_TOKEN'
export const DEFAULT_EMBEDDING_API_KEY_REF = 'RUSHDB_EMBEDDING_API_KEY'
export const DEFAULT_OUTBOX_PATH = 'rushdb/outbox'

export const Config: z<Config> = z.object({
  apiKeyRef: z.string().default(DEFAULT_API_KEY_REF).description('Credential that holds the RushDB API key.'),
  url: z.string().description('RushDB API URL. Leave empty for RushDB Cloud.'),
  engineUrl: z.string().description('URL of a standalone RushDB engine (direct mode), instead of the API.'),
  engineTokenRef: z
    .string()
    .default(DEFAULT_ENGINE_TOKEN_REF)
    .description('Credential that holds the standalone engine token.'),
  engineScope: z.string().description('Tenant on a multitenant standalone engine.'),
  embedding: z
    .object({
      baseUrl: z.string().description('Base URL of an OpenAI-compatible embeddings API.'),
      apiKeyRef: z
        .string()
        .default(DEFAULT_EMBEDDING_API_KEY_REF)
        .description('Credential that holds the embedding API key.'),
      model: z.string().description('Embedding model.'),
      dimensions: z.natural().description('Embedding dimensions.')
    })
    .description('Embedding provider; required with a standalone engine, which has no managed embeddings.'),
  profileId: z.string().default(DEFAULT_PROFILE_ID).description('Profile id stored with the context.'),
  contextScope: z
    .string()
    .description('Replaces the project key (a hash of the git remote, or of the working directory).'),
  autoContext: z
    .object({
      recall: z
        .boolean()
        .default(false)
        .description('Before the first step of each turn, add relevant context from earlier sessions.'),
      capture: z.boolean().default(false).description('Store each finished turn in your RushDB project.')
    })
    .description('Automatic context. Off by default: no network calls and no local files.'),
  recallLimit: z.natural().min(1).max(20).default(6).description('Most items one recall adds.'),
  recallTimeoutMs: z
    .natural()
    .min(1)
    .default(RECALL_TIMEOUT_MS)
    .description('Recall gives up after this many milliseconds and the step goes on without it.'),
  recallMinChars: z.natural().default(3).description('Prompts shorter than this do not trigger recall.'),
  includeSubagents: z.boolean().default(false).description('Also recall into and capture from subagent sessions.'),
  outboxPath: z
    .string()
    .default(DEFAULT_OUTBOX_PATH)
    .description('Outbox for captured turns waiting to be sent; relative to $DSH_HOME.'),
  excludeFromLogUpload: z
    .boolean()
    .default(false)
    .description('Keep sessions that received RushDB context out of the session-log upload to DeepSeek.')
})

export interface Settings {
  apiKeyRef: string
  url?: string
  engineUrl?: string
  engineTokenRef: string
  engineScope?: string
  embedding?: { baseUrl?: string; apiKeyRef: string; model?: string; dimensions?: number }
  profileId: string
  contextScope?: string
  recall: boolean
  capture: boolean
  recallLimit: number
  recallTimeoutMs: number
  recallMinChars: number
  includeSubagents: boolean
  outboxDirectory: string
  excludeFromLogUpload: boolean
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** `$DSH_HOME`, else `~/.dsh`, as dsh resolves it. */
export function dshHome(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  return text(env.DSH_HOME) ?? join(homeDir, '.dsh')
}

/** Settings with every default filled in, also when the loader passed a partial config. */
export function resolveSettings(config: Config = {}, env: NodeJS.ProcessEnv = process.env): Settings {
  const outboxPath = text(config.outboxPath) ?? DEFAULT_OUTBOX_PATH
  const embedding = config.embedding
  return {
    apiKeyRef: text(config.apiKeyRef) ?? DEFAULT_API_KEY_REF,
    url: text(config.url),
    engineUrl: text(config.engineUrl),
    engineTokenRef: text(config.engineTokenRef) ?? DEFAULT_ENGINE_TOKEN_REF,
    engineScope: text(config.engineScope),
    embedding:
      embedding && (text(embedding.model) || embedding.dimensions !== undefined)
        ? {
            baseUrl: text(embedding.baseUrl),
            apiKeyRef: text(embedding.apiKeyRef) ?? DEFAULT_EMBEDDING_API_KEY_REF,
            model: text(embedding.model),
            dimensions: embedding.dimensions
          }
        : undefined,
    profileId: text(config.profileId) ?? DEFAULT_PROFILE_ID,
    contextScope: text(config.contextScope),
    recall: config.autoContext?.recall === true,
    capture: config.autoContext?.capture === true,
    recallLimit: config.recallLimit ?? 6,
    recallTimeoutMs: config.recallTimeoutMs ?? RECALL_TIMEOUT_MS,
    recallMinChars: config.recallMinChars ?? 3,
    includeSubagents: config.includeSubagents === true,
    outboxDirectory: isAbsolute(outboxPath) ? outboxPath : resolve(dshHome(env), outboxPath),
    excludeFromLogUpload: config.excludeFromLogUpload === true
  }
}

export type Credentials = SecretSource

/** Thrown when RushDB isn't configured; the message says what to set. */
export class NotConfiguredError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'NotConfiguredError'
  }
}

async function secret(credentials: Credentials, name: string): Promise<string | undefined> {
  return text(await credentials.resolve(name))
}

export interface Connection {
  options: RushDBMemoryClientOptions
  /** Hash that identifies the connection, so a rotated key gets a new client. */
  fingerprint: string
  /** Credentials to keep out of logs and tool output. */
  secrets: string[]
}

/**
 * The RushDB connection from the settings and the current credential values, resolved on every call so a rotated
 * key applies to the next request. Throws `NotConfiguredError` when something is missing.
 */
export async function resolveConnection(
  settings: Settings,
  credentials: Credentials,
  /** Fetch for the embedding provider; the plugin passes its transport's, which has deadlines. */
  fetch?: typeof globalThis.fetch
): Promise<Connection> {
  let embedder: RushDBMemoryClientOptions['embedder']
  const secrets: string[] = []
  if (settings.embedding) {
    const { baseUrl, apiKeyRef, model, dimensions } = settings.embedding
    const apiKey = await secret(credentials, apiKeyRef)
    if (!apiKey || !model || !dimensions) {
      throw new NotConfiguredError(
        `RushDB embedding provider is incomplete: set embedding.model, embedding.dimensions and the ${apiKeyRef} credential`
      )
    }
    secrets.push(apiKey)
    embedder = createOpenAICompatibleEmbedder({ baseUrl, apiKey, model, dimensions, ...(fetch ? { fetch } : {}) })
  }
  if (settings.engineUrl) {
    const engineToken = await secret(credentials, settings.engineTokenRef)
    if (!engineToken) {
      throw new NotConfiguredError(
        `RushDB engine ${settings.engineUrl} needs the ${settings.engineTokenRef} credential`
      )
    }
    if (!embedder) {
      throw new NotConfiguredError(
        'A standalone RushDB engine has no managed embeddings; configure the embedding provider (embedding.model, embedding.dimensions, embedding.apiKeyRef)'
      )
    }
    secrets.push(engineToken)
    return {
      options: { engineUrl: settings.engineUrl, engineToken, scope: settings.engineScope, embedder },
      fingerprint: sha256(JSON.stringify(['engine', settings.engineUrl, settings.engineScope, ...secrets])),
      secrets
    }
  }
  const apiKey = await secret(credentials, settings.apiKeyRef)
  if (!apiKey) {
    throw new NotConfiguredError(
      `RushDB is not configured: set the ${settings.apiKeyRef} credential (export it, or add it to $DSH_HOME/.env)`
    )
  }
  secrets.push(apiKey)
  return {
    options: { apiKey, url: settings.url, embedder },
    fingerprint: sha256(JSON.stringify(['api', settings.url, ...secrets])),
    secrets
  }
}
