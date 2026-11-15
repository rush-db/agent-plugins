// Runs against a local engine container started by `pnpm test:integration` (scripts/with-engine.mjs).
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RushDBAgentMemory, sha256, type MemoryEmbedder } from '@rushdb/agent-memory-contract'
import { buildEpisode } from './episode.ts'
import { flushOutbox, outboxDirectory } from './flush.ts'
import { createFileLogger } from './logger.ts'
import { pendingEpisodeCount, writeOutboxEvent } from './outbox.ts'
import { RECALL_HEADING, recallContext } from './recall.ts'
import { resolveContextScope } from './scope.ts'

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

describe.skipIf(!engineUrl || !engineToken)('local engine', () => {
  it('recalls in a new session what an earlier session captured', async () => {
    const memory = () => new RushDBAgentMemory({ engineUrl, engineToken, embedder: hashingEmbedder() })
    const stateDir = await mkdtemp(join(tmpdir(), 'rushdb-core-engine-'))
    const logger = createFileLogger(stateDir, { secrets: [engineToken] })
    const contextScope = `integration-${Date.now()}`

    // Session A: a captured turn goes through the outbox and a flush, as the hooks will do it.
    const sessionA = (await resolveContextScope({ sessionId: 'session-a', cwd: stateDir, contextScope }))!
    const episode = buildEpisode({
      scope: sessionA,
      turnIndex: 0,
      userText: 'Which package manager does this repository use?',
      assistantText: 'Decision: this repository uses pnpm workspaces, never npm or yarn.',
      host: 'test',
      event: 'Stop'
    })!
    const outbox = outboxDirectory(stateDir)
    await writeOutboxEvent(outbox, episode)
    expect(await flushOutbox(outbox, { memory: memory(), logger, timeoutMs: 20_000 })).toBe(true)
    expect(await pendingEpisodeCount(outbox)).toBe(0)

    // Session B, in a fresh client with no recent-write cache, recalls it.
    const sessionB = (await resolveContextScope({ sessionId: 'session-b', cwd: stateDir, contextScope }))!
    let context = ''
    const deadline = Date.now() + 20_000
    while (!context && Date.now() < deadline) {
      context = await recallContext(memory(), sessionB, {
        query: 'package manager pnpm workspaces repository',
        timeoutMs: 5000
      })
      if (!context) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(context.startsWith(RECALL_HEADING)).toBe(true)
    expect(context).toContain('pnpm workspaces')

    // Session A itself is left out, and another project sees nothing.
    expect(await recallContext(memory(), sessionA, { query: 'pnpm workspaces', timeoutMs: 5000 })).toBe('')
    const other = (await resolveContextScope({
      sessionId: 'session-c',
      cwd: stateDir,
      contextScope: `${contextScope}-x`
    }))!
    expect(await recallContext(memory(), other, { query: 'pnpm workspaces', timeoutMs: 5000 })).toBe('')
  })

  it('stores a replayed event once', async () => {
    const client = new RushDBAgentMemory({ engineUrl, engineToken, embedder: hashingEmbedder() })
    const stateDir = await mkdtemp(join(tmpdir(), 'rushdb-core-engine-'))
    const scope = (await resolveContextScope({
      sessionId: 'session-d',
      cwd: stateDir,
      contextScope: `dup-${Date.now()}`
    }))!
    const episode = buildEpisode({
      scope,
      turnIndex: 0,
      userText: 'Replay me',
      assistantText: 'Replayed',
      host: 'test',
      event: 'Stop'
    })!
    const outbox = outboxDirectory(stateDir)
    for (let round = 0; round < 2; round += 1) {
      await writeOutboxEvent(outbox, episode)
      expect(await flushOutbox(outbox, { memory: client, logger: createFileLogger(stateDir), timeoutMs: 20_000 })).toBe(
        true
      )
    }
    const db = (client as unknown as { db: { records: { find(query: unknown): Promise<{ data: unknown[] }> } } }).db
    const found = await db.records.find({ labels: ['EPISODE'], where: { eventId: episode.eventId } })
    expect(found.data).toHaveLength(1)
  })
})
