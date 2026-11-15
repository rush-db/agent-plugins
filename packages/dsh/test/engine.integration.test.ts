// Runs against a local engine container started by `pnpm test:integration` (packages/core/scripts/with-engine.mjs).
import { describe, expect, it } from 'vitest'
import { sha256, type MemoryEmbedder } from '@rushdb/agent-memory-contract'
import { silentLogger } from '@rushdb/agent-plugins-core'
import { ClientCache, createClient } from '../src/client.ts'
import { AutoContext } from '../src/context.ts'
import type { PreStepDecision } from '../src/host.ts'
import { createTools } from '../src/tools.ts'
import { credentials, session, settingsFor, tempDir, turnEvents, userMessage } from './helpers.ts'

const engineUrl = process.env.RUSHDB_TEST_ENGINE_URL
const engineToken = process.env.RUSHDB_TEST_ENGINE_TOKEN

/** A standalone engine has no managed embeddings; hashed bag-of-words vectors are enough to rank a test corpus. */
function hashingEmbedder(dimensions = 64): MemoryEmbedder {
  return {
    dimensions,
    similarity: 'cosine',
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0)
        for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
          vector[parseInt(sha256(word).slice(0, 8), 16) % dimensions]! += 1
        }
        const norm = Math.hypot(...vector) || 1
        return vector.map((value) => value / norm)
      })
    }
  }
}

async function setup() {
  const contextScope = `dsh-integration-${Date.now()}`
  const settings = settingsFor(await tempDir(), {
    engineUrl,
    embedding: { model: 'hashing', dimensions: 64 },
    contextScope,
    autoContext: { recall: true, capture: true }
  })
  const embedder = hashingEmbedder()
  // The config names an OpenAI-compatible provider; the test swaps in a local embedder of the same size.
  const clients = new ClientCache(
    settings,
    credentials({ RUSHDB_ENGINE_TOKEN: engineToken!, RUSHDB_EMBEDDING_API_KEY: 'unused' }),
    (options, transport) => createClient({ ...options, embedder }, transport)
  )
  return { settings, clients }
}

async function retry<T>(task: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await task()
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    value = await task()
  }
  return value
}

describe.skipIf(!engineUrl || !engineToken)('local engine', () => {
  it('recalls in a new session the turn an earlier session captured', async () => {
    const { settings, clients } = await setup()
    const writer = new AutoContext({ settings, clients, logger: silentLogger, gitRemote: async () => undefined })
    const a = session('dsh-session-a')
    for (const event of turnEvents(
      1,
      'Which package manager does this repository use?',
      'Decision: this repository uses pnpm workspaces, never npm or yarn.'
    )) {
      writer.onSessionEvent(a, event)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await writer.flush(20_000)).toBe(true)
    await writer.dispose()

    // Session B, in a fresh plugin instance with no recent-write cache.
    const reader = new AutoContext({
      settings: { ...settings, recallTimeoutMs: 5000 },
      clients: new ClientCache(
        settings,
        credentials({ RUSHDB_ENGINE_TOKEN: engineToken!, RUSHDB_EMBEDDING_API_KEY: 'unused' }),
        (options, transport) => createClient({ ...options, embedder: hashingEmbedder() }, transport)
      ),
      logger: silentLogger,
      gitRemote: async () => undefined
    })
    const decision: PreStepDecision = { kind: 'enter', messages: [userMessage('Which package manager should I use?')] }
    const b = session('dsh-session-b')
    const result = await retry(
      () =>
        reader.preStep(
          { agent: { session: b } as never, messages: decision.messages, signal: new AbortController().signal },
          async () => decision
        ),
      (value) => value !== decision
    )
    const messages = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages
    expect(messages).toHaveLength(2)
    expect(messages[0]!.source.kind).toBe('rushdb-context')
    expect(JSON.stringify(messages[0]!.content)).toContain('pnpm workspaces')
  })

  it('remembers, searches, queries and aggregates through the model tools', async () => {
    const { settings, clients } = await setup()
    const tools = Object.fromEntries(
      createTools({ settings, clients, gitRemote: async () => undefined }).map((tool) => [tool.name, tool])
    )
    const exec = { signal: new AbortController().signal, agent: { session: session('dsh-session-tools') } } as never
    const run = (name: string, args: unknown) => tools[name]!.execute(args, exec) as Promise<string>

    expect(
      await run('rushdb_remember', { text: 'Release notes are written in Changesets.', kind: 'convention' })
    ).toMatch(/^Saved in RushDB/)
    const found = await retry(
      async () =>
        JSON.parse(await run('rushdb_search', { query: 'release notes changesets' })) as Array<{ text: string }>,
      (value) => value.some((item) => item.text.includes('Changesets'))
    )
    expect(found.some((item) => item.text.includes('Changesets'))).toBe(true)

    const queried = JSON.parse(
      await run('rushdb_query', { labels: ['MEMORY_FACT'], where: { kind: 'convention' }, limit: 5 })
    ) as { total: number; data: Array<{ text: string }> }
    expect(queried.data.some((record) => record.text.includes('Changesets'))).toBe(true)

    const counted = JSON.parse(
      await run('rushdb_aggregate', {
        labels: ['MEMORY_FACT'],
        select: { facts: { $count: '*' }, kind: '$record.kind' },
        groupBy: ['kind']
      })
    ) as { data: Array<{ facts: number; kind: string }> }
    expect(counted.data.find((row) => row.kind === 'convention')?.facts).toBeGreaterThanOrEqual(1)

    const ranked = JSON.parse(
      await run('rushdb_search', {
        query: 'release notes changesets',
        propertyName: 'text',
        labels: ['MEMORY_FACT'],
        limit: 3
      })
    ) as { data: Array<{ text: string }> }
    expect(ranked.data[0]?.text).toContain('Changesets')
  })
})
