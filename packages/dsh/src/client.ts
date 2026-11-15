import RushDB from '@rushdb/javascript-sdk'
import { RushDBAgentMemory, type RushDBMemoryClientOptions } from '@rushdb/agent-memory-contract'
import { resolveConnection, type Connection, type Credentials, type Settings } from './config.ts'

export interface RushDBClient {
  db: RushDB
  memory: RushDBAgentMemory
  /** Embeds text on the client; set when an embedding provider is configured (always for a standalone engine). */
  embed?: (text: string) => Promise<number[]>
  /** Credentials to keep out of logs and tool output. */
  secrets: string[]
}

export type CreateClient = (options: RushDBMemoryClientOptions) => Omit<RushDBClient, 'secrets'>

export function createClient(options: RushDBMemoryClientOptions): Omit<RushDBClient, 'secrets'> {
  const db = options.engineUrl
    ? new RushDB(options.engineToken ?? '', {
        direct: true,
        engineUrl: options.engineUrl,
        ...(options.scope ? { scope: options.scope } : {})
      })
    : new RushDB(options.apiKey ?? '', options.url ? { url: options.url } : undefined)
  const embedder = options.embedder
  return {
    db,
    memory: new RushDBAgentMemory({ db, embedder, recentLimit: 16 }),
    embed: embedder ? async (text) => (await embedder.embed([text]))[0]! : undefined
  }
}

/**
 * Hands out the RushDB client for the current credentials. Credentials are resolved on every call, and a new client
 * is built only when they changed, so a rotated key applies to the next request.
 */
export class ClientCache {
  private readonly settings: Settings
  private readonly credentials: Credentials
  private readonly create: CreateClient
  private current?: { fingerprint: string; client: RushDBClient }

  public constructor(settings: Settings, credentials: Credentials, create: CreateClient = createClient) {
    this.settings = settings
    this.credentials = credentials
    this.create = create
  }

  /** Throws `NotConfiguredError` when RushDB isn't configured. */
  public async get(): Promise<RushDBClient> {
    const connection: Connection = await resolveConnection(this.settings, this.credentials)
    if (this.current?.fingerprint === connection.fingerprint) return this.current.client
    const client: RushDBClient = { ...this.create(connection.options), secrets: connection.secrets }
    this.current = { fingerprint: connection.fingerprint, client }
    return client
  }

  /** Credentials of the current client, to mask in logs. */
  public secrets(): string[] {
    return this.current?.client.secrets ?? []
  }

  /** The current client's memory, without resolving credentials again; undefined before the first `get()`. */
  public peekMemory(): RushDBAgentMemory | undefined {
    return this.current?.client.memory
  }
}
