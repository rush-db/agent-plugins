import RushDB from '@rushdb/javascript-sdk'
import { RushDBAgentMemory, type RushDBMemoryClientOptions } from '@rushdb/agent-memory-contract'
import type { Logger } from '@rushdb/agent-plugins-core'

/**
 * The contract client, with its RushDB client built here so failed recall searches reach the log: the contract's
 * `recall` settles each search and drops the errors, which would leave `hooks.log` empty with the network off.
 */
export function createMemory(connection: RushDBMemoryClientOptions, logger: Logger): RushDBAgentMemory {
  if (!connection.engineUrl && !connection.apiKey)
    throw new Error('RushDB connection has neither an engine URL nor a key')
  const db = connection.engineUrl
    ? new RushDB(connection.engineToken ?? '', {
        direct: true,
        engineUrl: connection.engineUrl,
        ...(connection.scope ? { scope: connection.scope } : {})
      })
    : new RushDB(connection.apiKey ?? '', connection.url ? { url: connection.url } : undefined)
  const vectorSearch = db.records.vectorSearch.bind(db.records)
  db.records.vectorSearch = (async (...args: Parameters<typeof vectorSearch>) => {
    try {
      return await vectorSearch(...args)
    } catch (error) {
      logger.warn('RushDB recall search failed', error)
      throw error
    }
  }) as typeof vectorSearch
  return new RushDBAgentMemory({ db, embedder: connection.embedder, recentLimit: 16 })
}
