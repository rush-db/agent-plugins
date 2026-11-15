import { describe, expect, it, vi } from 'vitest'
import type { AgentMemoryFactV1 } from '@rushdb/agent-memory-contract'
import { ClientCache } from '../src/client.ts'
import { createTools, jsonOutput, TOOL_OUTPUT_MAX_CHARS } from '../src/tools.ts'
import { credentials, memoryStub, session, settingsFor, tempDir, type MemoryStub } from './helpers.ts'

function dbStub() {
  const result = { data: [{ data: { __id: 'r1', __label: 'Order', total: 120 } }], total: 1 }
  return {
    records: {
      find: vi.fn(async () => result),
      vectorSearch: vi.fn(async () => result)
    }
  }
}

async function tools(
  options: { memory?: MemoryStub; values?: Record<string, string>; embed?: boolean; config?: object } = {}
) {
  const settings = settingsFor(await tempDir(), { contextScope: 'test', ...options.config })
  const db = dbStub()
  const memory = options.memory ?? memoryStub()
  const clients = new ClientCache(settings, credentials(options.values ?? { RUSHDB_API_KEY: 'test-key-123' }), () => ({
    db: db as never,
    memory: memory as never
  }))
  if (options.embed) {
    const get = clients.get.bind(clients)
    vi.spyOn(clients, 'get').mockImplementation(async () => ({ ...(await get()), embed: async () => [0.1, 0.2] }))
  }
  const byName = Object.fromEntries(
    createTools({ settings, clients, gitRemote: async () => undefined }).map((tool) => [tool.name, tool])
  )
  const run = (name: string, args: unknown) =>
    byName[name]!.execute(args, {
      signal: new AbortController().signal,
      agent: { session: session('session-a') }
    } as never) as Promise<string>
  return { run, db, memory, byName }
}

describe('model tools', () => {
  it('rushdb_query sends a SearchQuery with a bounded limit and returns {total, data}', async () => {
    const { run, db } = await tools()
    const output = await run('rushdb_query', {
      labels: ['Order'],
      where: { total: { $gte: 100 } },
      orderBy: { total: 'desc' },
      limit: 5000
    })
    expect(db.records.find).toHaveBeenCalledWith({
      labels: ['Order'],
      where: { total: { $gte: 100 } },
      orderBy: { total: 'desc' },
      limit: 1000
    })
    expect(JSON.parse(output)).toEqual({ total: 1, data: [{ __id: 'r1', __label: 'Order', total: 120 }] })
  })

  it('rushdb_aggregate never sends a limit, which would cut the scan', async () => {
    const { run, db } = await tools()
    await run('rushdb_aggregate', {
      labels: ['Order'],
      select: { revenue: { $sum: '$record.total' }, country: '$record.country' },
      groupBy: ['country']
    })
    const [query] = db.records.find.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(query).toEqual({
      labels: ['Order'],
      select: { revenue: { $sum: '$record.total' }, country: '$record.country' },
      groupBy: ['country']
    })
    expect(query).not.toHaveProperty('limit')
  })

  it('rushdb_aggregate rejects a select that is not an object', async () => {
    const { run } = await tools()
    await expect(run('rushdb_aggregate', { select: 'count' })).rejects.toThrow()
  })

  it('rushdb_search ranks records by an embedding index, with a client-side vector when one is configured', async () => {
    const managed = await tools()
    await managed.run('rushdb_search', { query: 'cheap flights', propertyName: 'description', labels: ['Offer'] })
    expect(managed.db.records.vectorSearch).toHaveBeenCalledWith({
      propertyName: 'description',
      labels: ['Offer'],
      limit: 10,
      query: 'cheap flights'
    })
    const direct = await tools({ embed: true })
    await direct.run('rushdb_search', { query: 'cheap flights', propertyName: 'description', limit: 3 })
    expect(direct.db.records.vectorSearch).toHaveBeenCalledWith({
      propertyName: 'description',
      limit: 3,
      queryVector: [0.1, 0.2]
    })
  })

  it('rushdb_search without propertyName searches stored context in the project scope', async () => {
    const recall = vi.fn(async () => [
      { id: 'f1', label: 'MEMORY_FACT' as const, text: 'Tests run with vitest.', score: 0.8 }
    ])
    const { run } = await tools({ memory: memoryStub({ recall }) })
    const output = await run('rushdb_search', { query: 'test runner' })
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'test runner', limit: 10, agentId: 'agent-plugins', profileId: 'default' })
    )
    expect(JSON.parse(output)).toEqual([{ label: 'MEMORY_FACT', text: 'Tests run with vitest.', score: 0.8 }])
  })

  it('rushdb_remember stores a contract fact with an idempotent source event id', async () => {
    const facts: AgentMemoryFactV1[] = []
    const memory = memoryStub({ persistFact: async (fact) => (facts.push(fact as AgentMemoryFactV1), fact as never) })
    const { run } = await tools({ memory })
    const output = await run('rushdb_remember', {
      text: ' Tests run with vitest. ',
      kind: 'convention',
      subject: 'tests'
    })
    expect(facts).toHaveLength(1)
    const fact = facts[0]!
    expect(fact).toMatchObject({
      eventType: 'fact',
      runtime: 'custom',
      text: 'Tests run with vitest.',
      kind: 'convention',
      subjectKey: 'tests',
      active: true,
      provenance: 'dsh:rushdb_remember'
    })
    expect(fact.sourceEventId).toMatch(/^session-a:remember:[a-f0-9]{64}$/)
    expect(output).toContain(fact.factId)
  })

  it('fails the call, not the agent, when RushDB is not configured', async () => {
    const { run, db } = await tools({ values: {} })
    await expect(run('rushdb_query', { labels: ['Order'] })).rejects.toThrow(/RUSHDB_API_KEY/)
    expect(db.records.find).not.toHaveBeenCalled()
  })

  it('stops waiting when the call is cancelled', async () => {
    const { byName, db } = await tools()
    db.records.find.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = byName.rushdb_query!.execute({ labels: ['Order'] }, { signal: controller.signal } as never)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('cuts long output', () => {
    const output = jsonOutput({ text: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS * 2) })
    expect(output.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 200)
    expect(output).toContain('output cut')
  })
})
