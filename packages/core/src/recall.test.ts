import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RushDBAgentMemory, type RecallOptions, type RecalledMemory } from '@rushdb/agent-memory-contract'
import { buildEpisode } from './episode.ts'
import { flushOutbox } from './flush.ts'
import { silentLogger } from './logger.ts'
import { pendingEpisodeCount, writeOutboxEvent } from './outbox.ts'
import { RECALL_HEADING, recallContext } from './recall.ts'
import type { ContextScope } from './scope.ts'

const scope: ContextScope = {
  agentId: 'agent-plugins',
  profileId: 'default',
  privacyScope: 'private',
  participantScopeHash: 'b'.repeat(64),
  sandboxEligible: false,
  externalSessionId: 'current-session'
}

function memory(id: string, text: string): RecalledMemory {
  return { id, label: 'EPISODE', text, score: 0.9 }
}

describe('recallContext', () => {
  it('formats memories under the RushDB heading and leaves the current session out', async () => {
    const recall = vi.fn(async (_: RecallOptions) => [memory('1', 'We chose pnpm.')])
    const context = await recallContext({ recall }, scope)
    expect(context.startsWith(RECALL_HEADING)).toBe(true)
    expect(context).toContain('We chose pnpm.')
    expect(recall.mock.calls[0]![0]).toMatchObject({
      participantScopeHash: scope.participantScopeHash,
      excludeSessionId: 'current-session'
    })
    expect(recall.mock.calls[0]![0]).not.toHaveProperty('externalSessionId')
  })

  it('caps the context size', async () => {
    const recall = async () => Array.from({ length: 20 }, (_, index) => memory(String(index), 'x'.repeat(1500)))
    const context = await recallContext({ recall }, scope)
    expect(context.length).toBeLessThanOrEqual(8000)
    expect(context).toContain('[Memory 1;')
  })

  it('returns nothing when nothing is recalled', async () => {
    expect(await recallContext({ recall: async () => [] }, scope)).toBe('')
  })

  it('gives up after the timeout', async () => {
    const onError = vi.fn()
    const started = Date.now()
    const context = await recallContext({ recall: () => new Promise(() => {}) }, scope, { timeoutMs: 100, onError })
    expect(context).toBe('')
    expect(Date.now() - started).toBeLessThan(500)
    expect(onError).toHaveBeenCalledWith('RushDB recall timed out after 100 ms')
  })

  it('resolves when recall throws, synchronously or not', async () => {
    const onError = vi.fn()
    expect(
      await recallContext(
        {
          recall: () => {
            throw new Error('boom')
          }
        },
        scope,
        { onError }
      )
    ).toBe('')
    expect(await recallContext({ recall: async () => Promise.reject(new Error('boom')) }, scope, { onError })).toBe('')
    expect(onError).toHaveBeenCalledTimes(2)
  })
})

describe('network off', () => {
  // A refused port and a non-routable address: one fails fast, the other hangs until the timeout.
  for (const url of ['http://127.0.0.1:9/api/v1', 'http://10.255.255.1/api/v1']) {
    it(`recall and flush resolve within their timeouts against ${url}`, async () => {
      const client = new RushDBAgentMemory({ apiKey: 'test-key', url })

      let started = Date.now()
      expect(await recallContext(client, scope, { timeoutMs: 500 })).toBe('')
      expect(Date.now() - started).toBeLessThan(1000)

      const directory = await mkdtemp(join(tmpdir(), 'rushdb-core-offline-'))
      const episode = buildEpisode({
        scope,
        turnIndex: 0,
        userText: 'question',
        assistantText: 'answer',
        host: 'test',
        event: 'Stop'
      })!
      await writeOutboxEvent(directory, episode)
      started = Date.now()
      expect(await flushOutbox(directory, { memory: client, logger: silentLogger, timeoutMs: 800 })).toBe(false)
      expect(Date.now() - started).toBeLessThan(1500)
      expect(await pendingEpisodeCount(directory)).toBe(1)
    })
  }
})
