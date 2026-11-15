// The first case is ported from rush-db/rushdb-openclaw-memory `src/outbox.test.ts` (Apache-2.0).
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createEpisodeEvent, type RushDBAgentMemory } from '@rushdb/agent-memory-contract'
import { silentLogger } from './logger.ts'
import { flushOutbox } from './flush.ts'
import { DurableEpisodeWriter, pendingEpisodeCount, writeOutboxEvent } from './outbox.ts'

function episode(sourceEventId = 'run-1') {
  return createEpisodeEvent({
    runtime: 'custom',
    agentId: 'main',
    profileId: 'default',
    privacyScope: 'private',
    participantScopeHash: 'participant',
    sandboxEligible: false,
    externalSessionId: 'session-1',
    sourceEventId,
    turnIndex: 0,
    userText: 'Remember this',
    assistantText: 'Stored',
    summary: 'The user asked to remember this.',
    conversationKind: 'local',
    visibility: 'participant',
    trustClass: 'mixed',
    originClass: 'conversation',
    observedAt: '2026-08-18T00:00:00Z',
    provenance: 'test'
  })
}

function outbox() {
  return mkdtemp(join(tmpdir(), 'rushdb-core-outbox-'))
}

describe('DurableEpisodeWriter', () => {
  it('retries a surviving outbox event without requiring a restart', async () => {
    const directory = await outbox()
    const memory = {
      rememberRecent: vi.fn((value) => value),
      persistEpisode: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary outage'))
        .mockRejectedValueOnce(new Error('temporary outage'))
        .mockRejectedValueOnce(new Error('temporary outage'))
        .mockRejectedValueOnce(new Error('temporary outage'))
        .mockResolvedValue(undefined)
    } as unknown as RushDBAgentMemory
    const writer = new DurableEpisodeWriter(directory, memory, vi.fn(), 5)
    const value = episode()

    await writer.start()
    await writer.enqueue(value)
    expect(await writer.flush(3000)).toBe(true)
    expect(memory.persistEpisode).toHaveBeenCalledTimes(5)
    await expect(readFile(join(directory, `${value.eventId}.json`), 'utf8')).rejects.toThrow()
    await writer.stop()
  })

  it('replays what a crashed process left in the outbox', async () => {
    const directory = await outbox()
    const value = episode()
    // A hook wrote the event and died before any flush.
    await writeOutboxEvent(directory, value)
    // A crash between write and rename leaves a temporary file, which is not an event.
    await writeFile(join(directory, `.${value.eventId}.partial.tmp`), '{')
    expect(await pendingEpisodeCount(directory)).toBe(1)

    const persisted: string[] = []
    const memory = {
      rememberRecent: (input: never) => input,
      persistEpisode: vi.fn(async (input: { eventId: string }) => {
        persisted.push(input.eventId)
        return input
      })
    }
    expect(await flushOutbox(directory, { memory: memory as never, logger: silentLogger, timeoutMs: 2000 })).toBe(true)
    expect(persisted).toEqual([value.eventId])
    expect(await pendingEpisodeCount(directory)).toBe(0)
  })

  it('counts a file another flush already sent as done', async () => {
    const directory = await outbox()
    const value = episode()
    const path = await writeOutboxEvent(directory, value)
    const onError = vi.fn()
    const memory = {
      rememberRecent: (input: never) => input,
      persistEpisode: vi.fn(async (input: unknown) => {
        await unlink(path)
        return input
      })
    }
    const writer = new DurableEpisodeWriter(directory, memory as never, onError, 5)
    await writer.start()
    expect(await writer.flush(1000)).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    await writer.stop(0)
  })
})

describe('flushOutbox', () => {
  it('lets only one flush run per outbox', async () => {
    const directory = await outbox()
    await writeOutboxEvent(directory, episode())
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const memory = {
      rememberRecent: (input: never) => input,
      persistEpisode: vi.fn(async (input: unknown) => {
        await blocked
        return input
      })
    }
    const first = flushOutbox(directory, { memory: memory as never, logger: silentLogger, timeoutMs: 2000 })
    await vi.waitFor(() => expect(memory.persistEpisode).toHaveBeenCalled())
    expect(await flushOutbox(directory, { memory: memory as never, logger: silentLogger })).toBe(false)
    release()
    expect(await first).toBe(true)
    expect((await readdir(directory)).filter((name) => !name.startsWith('.'))).toEqual([])
  })

  it('keeps events on disk and resolves by its deadline while RushDB is down', async () => {
    const directory = await outbox()
    const value = episode()
    await writeOutboxEvent(directory, value)
    const warn = vi.fn()
    const memory = {
      rememberRecent: (input: never) => input,
      persistEpisode: vi.fn(async () => {
        throw new Error('offline')
      }),
      ensureIndexes: vi.fn(() => new Promise<void>(() => {}))
    }
    const started = Date.now()
    expect(await flushOutbox(directory, { memory, logger: { info: vi.fn(), warn }, timeoutMs: 600 })).toBe(false)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(await pendingEpisodeCount(directory)).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^RushDB index setup timed out after \d+ ms$/))
    expect(memory.persistEpisode).toHaveBeenCalled()
  })

  it('returns at once when the outbox is empty', async () => {
    const memory = { rememberRecent: vi.fn(), persistEpisode: vi.fn(), ensureIndexes: vi.fn() }
    expect(await flushOutbox(join(await outbox(), 'missing'), { memory: memory as never, logger: silentLogger })).toBe(
      true
    )
    expect(memory.ensureIndexes).not.toHaveBeenCalled()
  })
})
