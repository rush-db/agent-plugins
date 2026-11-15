import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMemoryEpisodeV1 } from '@rushdb/agent-memory-contract'
import { RECALL_HEADING, silentLogger } from '@rushdb/agent-plugins-core'
import { AutoContext, COMPACTION_FLUSH_MS, DISPOSE_FLUSH_MS } from '../src/context.ts'
import { CONTEXT_SOURCE_KIND, type PreStepDecision } from '../src/host.ts'
import {
  clientsFor,
  filesUnder,
  hang,
  memoryStub,
  session,
  settingsFor,
  tempDir,
  turnEvents,
  until,
  userMessage,
  type MemoryStub
} from './helpers.ts'

const noRemote = async () => undefined
const recalled = [{ id: 'e1', label: 'EPISODE' as const, text: 'Decision: use pnpm workspaces.', score: 0.9 }]

async function autoContext(
  config: Parameters<typeof settingsFor>[1],
  memory: MemoryStub,
  values?: Record<string, string>
) {
  const home = await tempDir()
  const settings = settingsFor(home, config)
  const auto = new AutoContext({
    settings,
    clients: clientsFor(settings, memory, {}, values),
    logger: silentLogger,
    gitRemote: noRemote
  })
  return { auto, home, settings }
}

function enter(...messages: ReturnType<typeof userMessage>[]): PreStepDecision {
  return { kind: 'enter', messages }
}

function payload(decision: PreStepDecision, id = 'session-a', origin?: 'subagent') {
  return {
    agent: { session: session(id, origin ? { origin } : {}) } as never,
    messages: decision.kind === 'enter' ? decision.messages : [],
    signal: new AbortController().signal
  }
}

describe('agent/pre-step recall', () => {
  it('puts one rushdb-context message in front of the prompt', async () => {
    const recall = vi.fn(async () => recalled)
    const { auto } = await autoContext({ autoContext: { recall: true } }, memoryStub({ recall }))
    const prompt = userMessage('Which package manager do we use?')
    const original = enter(prompt)

    const result = await auto.preStep(payload(original), async () => original)

    expect(result.kind).toBe('enter')
    const messages = (result as Extract<PreStepDecision, { kind: 'enter' }>).messages
    expect(messages).toHaveLength(2)
    expect(messages[0]!.source).toEqual({ kind: CONTEXT_SOURCE_KIND, form: 'recall' })
    expect(messages[0]!.role).toBe('user')
    const text = (messages[0]!.content[0] as { text: string }).text
    expect(text).toContain(RECALL_HEADING)
    expect(text).toContain('use pnpm workspaces')
    expect(messages[1]).toBe(prompt)
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Which package manager do we use?',
        limit: 6,
        excludeSessionId: 'session-a',
        agentId: 'agent-plugins',
        profileId: 'default'
      })
    )
    expect(auto.injectedSessions.has('session-a')).toBe(true)
  })

  it('returns the original decision when recall throws', async () => {
    const { auto } = await autoContext(
      { autoContext: { recall: true } },
      memoryStub({
        recall: async () => {
          throw new Error('network down')
        }
      })
    )
    const original = enter(userMessage('What did we decide about the API?'))
    expect(await auto.preStep(payload(original), async () => original)).toBe(original)
    expect(auto.injectedSessions.size).toBe(0)
  })

  it('returns the original decision when recall times out', async () => {
    const { auto } = await autoContext(
      { autoContext: { recall: true }, recallTimeoutMs: 100 },
      memoryStub({ recall: hang })
    )
    const original = enter(userMessage('What did we decide about the API?'))
    const started = Date.now()
    expect(await auto.preStep(payload(original), async () => original)).toBe(original)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('returns the original decision when RushDB is not configured', async () => {
    const recall = vi.fn(async () => recalled)
    const { auto } = await autoContext({ autoContext: { recall: true } }, memoryStub({ recall }), {})
    const original = enter(userMessage('What did we decide about the API?'))
    expect(await auto.preStep(payload(original), async () => original)).toBe(original)
    expect(recall).not.toHaveBeenCalled()
  })

  it('returns the original decision when the turn is cancelled during recall', async () => {
    const { auto } = await autoContext({ autoContext: { recall: true } }, memoryStub({ recall: hang }))
    const original = enter(userMessage('What did we decide about the API?'))
    const controller = new AbortController()
    const pending = auto.preStep({ ...payload(original), signal: controller.signal }, async () => original)
    controller.abort()
    expect(await pending).toBe(original)
  })

  it('leaves continuation steps, rejected steps, short prompts and subagents alone', async () => {
    const recall = vi.fn(async () => recalled)
    const { auto } = await autoContext({ autoContext: { recall: true } }, memoryStub({ recall }))
    const continuation = enter()
    expect(await auto.preStep(payload(continuation), async () => continuation)).toBe(continuation)
    const rejected: PreStepDecision = { kind: 'reject' }
    expect(await auto.preStep(payload(enter(userMessage('hello there'))), async () => rejected)).toBe(rejected)
    const short = enter(userMessage('ok'))
    expect(await auto.preStep(payload(short), async () => short)).toBe(short)
    const sub = enter(userMessage('Which package manager do we use?'))
    expect(await auto.preStep(payload(sub, 'sub-1', 'subagent'), async () => sub)).toBe(sub)
    expect(recall).not.toHaveBeenCalled()
  })

  it('does nothing with recall off', async () => {
    const recall = vi.fn(async () => recalled)
    const { auto } = await autoContext({ autoContext: { capture: true } }, memoryStub({ recall }))
    const original = enter(userMessage('Which package manager do we use?'))
    expect(await auto.preStep(payload(original), async () => original)).toBe(original)
    expect(recall).not.toHaveBeenCalled()
  })
})

describe('session/event capture', () => {
  it('stores each completed turn once, with sourceEventId <session>:<turn>', async () => {
    const persisted: AgentMemoryEpisodeV1[] = []
    const { auto } = await autoContext(
      { autoContext: { capture: true } },
      memoryStub({
        persistEpisode: async (episode) => (persisted.push(episode as AgentMemoryEpisodeV1), episode as never)
      })
    )
    const a = session('session-a')
    for (const event of turnEvents(3, 'Which package manager?', 'We use pnpm workspaces.'))
      auto.onSessionEvent(a, event)
    await until(() => persisted.length === 1)
    const episode = persisted[0]!
    expect(episode.sourceEventId).toBe('session-a:3')
    expect(episode.externalSessionId).toBe('session-a')
    expect(episode.turnIndex).toBe(3)
    expect(episode.runtime).toBe('custom')
    expect(episode.provenance).toBe('dsh:turn_end')
    expect(episode.userText).toBe('Which package manager?')
    expect(episode.assistantText).toBe('We use pnpm workspaces.')
    await auto.dispose()
  })

  it('skips aborted turns, injected context and subagent sessions', async () => {
    const persistEpisode = vi.fn(async (episode: unknown) => episode as never)
    const { auto } = await autoContext({ autoContext: { capture: true } }, memoryStub({ persistEpisode }))
    for (const event of turnEvents(1, 'Stop that', 'Stopping', 'aborted')) auto.onSessionEvent(session('s'), event)
    for (const event of turnEvents(1, 'Sub prompt', 'Sub answer')) {
      auto.onSessionEvent(session('sub', { origin: 'subagent' }), event)
    }
    const injected = {
      type: 'user/message',
      data: { ...userMessage('recalled'), source: { kind: CONTEXT_SOURCE_KIND } }
    }
    const events = turnEvents(2, 'Real prompt', 'Real answer')
    events.splice(1, 0, injected as never)
    const captured = vi.fn()
    vi.spyOn(auto, 'episodeFor').mockImplementation(async (...args) => {
      captured(args[2])
      return null
    })
    for (const event of events) auto.onSessionEvent(session('s'), event)
    await until(() => captured.mock.calls.length === 1)
    expect(captured).toHaveBeenCalledWith({ turn: 2, userTexts: ['Real prompt'], assistantText: 'Real answer' })
    expect(persistEpisode).not.toHaveBeenCalled()
  })

  it('keeps turns in the outbox while RushDB is unreachable, and never throws', async () => {
    const { auto, settings } = await autoContext(
      { autoContext: { capture: true } },
      memoryStub({
        persistEpisode: async () => {
          throw new Error('ECONNREFUSED')
        }
      })
    )
    for (const event of turnEvents(0, 'Remember this?', 'Yes.')) auto.onSessionEvent(session('s'), event)
    await until(async () => (await filesUnder(settings.outboxDirectory)).some((file) => file.endsWith('.json')))
    const [file] = (await filesUnder(settings.outboxDirectory)).filter((name) => name.endsWith('.json'))
    const stored = JSON.parse(await readFile(join(settings.outboxDirectory, file!), 'utf8')) as AgentMemoryEpisodeV1
    expect(stored.sourceEventId).toBe('s:0')
    expect(await auto.flush(100)).toBe(false)
    await auto.dispose()
  })

  it('bounds the flush on dispose when RushDB hangs', async () => {
    const { auto } = await autoContext({ autoContext: { capture: true } }, memoryStub({ persistEpisode: hang }))
    for (const event of turnEvents(0, 'A prompt here', 'An answer here')) auto.onSessionEvent(session('s'), event)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await auto.dispose()
    expect(Date.now() - started).toBeLessThan(DISPOSE_FLUSH_MS + 1000)
  })

  it('does nothing with capture off', async () => {
    const persistEpisode = vi.fn()
    const { auto, home } = await autoContext({ autoContext: { recall: true } }, memoryStub({ persistEpisode }))
    for (const event of turnEvents(0, 'A prompt here', 'An answer here')) auto.onSessionEvent(session('s'), event)
    auto.start()
    await auto.dispose()
    expect(persistEpisode).not.toHaveBeenCalled()
    expect(await filesUnder(home)).toEqual([])
  })
})

describe('compaction', () => {
  it('flushes the outbox in the background when compaction starts', async () => {
    const { auto } = await autoContext({ autoContext: { capture: true } }, memoryStub())
    const flush = vi.spyOn(auto, 'flush').mockResolvedValue(true)
    expect(() =>
      auto.onSessionEvent(session('s'), { type: 'compaction/start', data: { compactionId: 'c1', turn: 2 } } as never)
    ).not.toThrow()
    expect(flush).toHaveBeenCalledWith(COMPACTION_FLUSH_MS)
  })
})
