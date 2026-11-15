import { boundedText, createFactEvent, sha256 } from '@rushdb/agent-memory-contract'
import { memoryScope, resolveContextScope, type ContextScope } from '@rushdb/agent-plugins-core'
import type { ClientCache, RushDBClient } from './client.ts'
import type { Settings } from './config.ts'
import { defineTool, type Agent } from './host.ts'

/** Deadline of a tool call and of each RushDB request in it; dsh's timeout policy also aborts the signal. */
export const TOOL_TIMEOUT_MS = 30_000
/** Longest tool output the model gets, in characters. */
export const TOOL_OUTPUT_MAX_CHARS = 30_000
export const QUERY_DEFAULT_LIMIT = 20
export const QUERY_MAX_LIMIT = 1000
export const SEARCH_DEFAULT_LIMIT = 10
export const SEARCH_MAX_LIMIT = 100

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }]
}

/** Settles with the task, or rejects once the call is cancelled. */
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
    signal.addEventListener('abort', abort, { once: true })
    task.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.trunc(value), max))
}

function objectArg(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object`)
  return value as Record<string, unknown>
}

/** Tool output as JSON, cut to `TOOL_OUTPUT_MAX_CHARS` with a note when it is longer. */
export function jsonOutput(value: unknown): string {
  const text = JSON.stringify(value, null, 1)
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n… output cut at ${TOOL_OUTPUT_MAX_CHARS} characters; narrow the query or lower the limit`
}

/** Plain record data from an SDK result. */
function records(result: { data: ReadonlyArray<{ data?: unknown }>; total?: number }) {
  return { total: result.total ?? result.data.length, data: result.data.map((record) => record.data ?? record) }
}

export interface ToolDependencies {
  settings: Settings
  clients: ClientCache
  gitRemote?: (cwd: string) => Promise<string | undefined>
  cwd?: () => string
}

async function scopeOf(
  dependencies: ToolDependencies,
  agent: Pick<Agent, 'session'> | undefined
): Promise<ContextScope> {
  const session = agent?.session
  const scope = await resolveContextScope({
    sessionId: session?.id ?? 'dsh-tool',
    cwd: session?.header.cwd ?? (dependencies.cwd ?? (() => process.cwd()))(),
    contextScope: dependencies.settings.contextScope,
    profileId: dependencies.settings.profileId,
    gitRemote: dependencies.gitRemote
  })
  if (!scope) throw new Error('RushDB could not resolve the project scope')
  return scope
}

/**
 * The model tools: search, query, aggregate and remember. They are always registered, whatever the
 * automatic-context switch says, and touch the network only when the model calls them.
 */
export function createTools(dependencies: ToolDependencies) {
  const client = (signal: AbortSignal): Promise<RushDBClient> => abortable(dependencies.clients.get(), signal)

  const search = defineTool({
    name: 'rushdb_search',
    description:
      'Semantic search in the RushDB project. With propertyName, ranks records of the given labels by meaning against an embedding index on that property (RAG over your data). Without it, searches context stored from earlier sessions in this project and facts saved with rushdb_remember.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for, in natural language.' },
      propertyName: {
        type: 'string',
        description: 'Property with an embedding index to search, e.g. "description". Omit to search stored context.'
      },
      labels: { type: 'array', items: { type: 'string' }, description: 'Record labels to search, e.g. ["Product"].' },
      where: { type: 'json', description: 'RushDB where filter applied before ranking, e.g. {"status": "active"}.' },
      limit: {
        type: 'integer',
        description: `Results to return, 1-${SEARCH_MAX_LIMIT}; default ${SEARCH_DEFAULT_LIMIT}.`
      }
    },
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { db, memory, embed } = await client(exec.signal)
      const limit = clamp(args.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT)
      if (!args.propertyName) {
        const scope = await scopeOf(dependencies, exec.agent)
        const found = await abortable(memory.recall({ ...memoryScope(scope), query: args.query, limit }), exec.signal)
        return jsonOutput(found.map(({ label, text, score, observedAt }) => ({ label, text, score, observedAt })))
      }
      const result = await abortable(
        db.records.vectorSearch({
          propertyName: args.propertyName,
          ...(args.labels?.length ? { labels: [...args.labels] } : {}),
          ...(objectArg(args.where, 'where') ? { where: objectArg(args.where, 'where') } : {}),
          limit,
          ...(embed ? { queryVector: await embed(args.query) } : { query: args.query })
        }),
        exec.signal
      )
      return jsonOutput(records(result))
    }
  })

  const query = defineTool({
    name: 'rushdb_query',
    description:
      'Find records in the RushDB project with a SearchQuery: labels, where filters (including related records), orderBy, limit and skip. Returns {total, data}. Use rushdb_aggregate for counts, sums and groupings.',
    parameters: {
      labels: { type: 'array', items: { type: 'string' }, description: 'Record labels, e.g. ["Order"].' },
      where: {
        type: 'json',
        description:
          'RushDB where clause, e.g. {"total": {"$gte": 100}, "CUSTOMER": {"country": "DE"}}. Use $contains for names.'
      },
      orderBy: { type: 'json', description: 'Sort, e.g. {"createdAt": "desc"}.' },
      limit: {
        type: 'integer',
        description: `Records to return, 1-${QUERY_MAX_LIMIT}; default ${QUERY_DEFAULT_LIMIT}.`
      },
      skip: { type: 'integer', description: 'Records to skip, for paging.' }
    },
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { db } = await client(exec.signal)
      const result = await abortable(
        db.records.find({
          ...(args.labels?.length ? { labels: [...args.labels] } : {}),
          ...(objectArg(args.where, 'where') ? { where: objectArg(args.where, 'where') } : {}),
          ...(objectArg(args.orderBy, 'orderBy') ? { orderBy: objectArg(args.orderBy, 'orderBy') as never } : {}),
          limit: clamp(args.limit, QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT),
          ...(args.skip ? { skip: Math.max(0, Math.trunc(args.skip)) } : {})
        }),
        exec.signal
      )
      return jsonOutput(records(result))
    }
  })

  const aggregate = defineTool({
    name: 'rushdb_aggregate',
    description:
      'Analytics over the RushDB project: counts, sums, averages, min/max, collected values and time buckets, optionally grouped. Pass select (and groupBy) as in a RushDB SearchQuery; every matching record is scanned.',
    parameters: {
      labels: { type: 'array', items: { type: 'string' }, description: 'Root record labels, e.g. ["Order"].' },
      where: { type: 'json', description: 'RushDB where clause that selects the records to aggregate.' },
      select: {
        type: 'json',
        required: true,
        description:
          'Output fields, e.g. {"orders": {"$count": "*"}, "revenue": {"$sum": "$record.total"}, "country": "$record.country"}.'
      },
      groupBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Select keys or record properties to group by, e.g. ["country"].'
      },
      orderBy: { type: 'json', description: 'Sort on select keys, e.g. {"revenue": "desc"}.' }
    },
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { db } = await client(exec.signal)
      // No limit: with select it would cut the scan and give wrong numbers.
      const result = await abortable(
        db.records.find({
          ...(args.labels?.length ? { labels: [...args.labels] } : {}),
          ...(objectArg(args.where, 'where') ? { where: objectArg(args.where, 'where') } : {}),
          select: objectArg(args.select, 'select') as never,
          ...(args.groupBy?.length ? { groupBy: [...args.groupBy] as never } : {}),
          ...(objectArg(args.orderBy, 'orderBy') ? { orderBy: objectArg(args.orderBy, 'orderBy') as never } : {})
        }),
        exec.signal
      )
      return jsonOutput(records(result))
    }
  })

  const remember = defineTool({
    name: 'rushdb_remember',
    description:
      'Save a fact, decision or preference in the RushDB project so later sessions can find it (rushdb_search without propertyName, or automatic context when it is on). Save only what the user wants kept; never secrets.',
    parameters: {
      text: { type: 'string', required: true, description: 'The fact, in one or two self-contained sentences.' },
      kind: {
        type: 'string',
        description: 'Kind of fact, e.g. "decision", "preference", "convention". Default "note".'
      },
      subject: {
        type: 'string',
        description:
          'Short key for what the fact is about, e.g. "test-runner"; a newer fact with the same subject sits next to it.'
      }
    },
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const text = boundedText(args.text.trim())
      if (!text) throw new Error('text is empty')
      const { memory } = await client(exec.signal)
      const scope = await scopeOf(dependencies, exec.agent)
      const digest = sha256(text)
      const fact = createFactEvent({
        ...memoryScope(scope),
        runtime: 'custom',
        text,
        kind: args.kind?.trim() || 'note',
        subjectKey: args.subject?.trim() || digest.slice(0, 16),
        confidence: 1,
        active: true,
        sourceEventId: `${scope.externalSessionId}:remember:${digest}`,
        validFrom: new Date().toISOString(),
        visibility: 'participant',
        trustClass: 'mixed',
        provenance: 'dsh:rushdb_remember'
      })
      await abortable(memory.ensureIndexes(), exec.signal)
      await abortable(memory.persistFact(fact), exec.signal)
      return `Saved in RushDB (${fact.kind}, id ${fact.factId}).`
    }
  })

  // Each call's requests carry its deadline and cancellation, so a RushDB that never answers ends the call with an
  // error result and leaves no request open.
  return [search, query, aggregate, remember].map((tool): typeof tool => ({
    ...tool,
    execute: (args, exec) =>
      dependencies.clients.run({ signal: exec.signal, timeoutMs: TOOL_TIMEOUT_MS }, () => tool.execute(args, exec))
  }))
}
