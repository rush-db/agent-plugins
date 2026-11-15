import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { PreStepDecision, SessionEvent } from '../src/host.ts'
import { DISPOSE_FLUSH_MS } from '../src/context.ts'
import { fakeRushDB, type FakeRushDB } from '../../hooks/test/helpers.ts'
import {
  contextMessage,
  credentials,
  filesUnder,
  session,
  standInRushDB,
  tempDir,
  turnEvents,
  until,
  userMessage,
  type StandInRushDB
} from './helpers.ts'

type Listener = (...args: any[]) => any

/** A session as dsh keeps it: header, log, and how much of the log a fork inherited. */
interface StubSession {
  id: string
  header: { cwd?: string; origin?: 'subagent' }
  events: SessionEvent[]
}

interface Projection {
  init(): unknown
  apply(state: unknown, event: SessionEvent): unknown
  stateSchema: { parse(value: unknown): unknown }
}

/** A Cordis context stand-in with the services the plugin injects. */
function stubContext(
  values: Record<string, string> = {},
  options: { credentialStore?: boolean; sessions?: StubSession[] } = {}
) {
  const listeners = new Map<string, Listener>()
  const tools: Array<{ name: string; execute: Listener }> = []
  const disposers: Array<() => unknown> = []
  const exclusions: Array<(request: { sessionId: string }) => boolean> = []
  const injected: string[][] = []
  const pending: Promise<unknown>[] = []
  const logs: string[] = []
  const creds = credentials(values)
  const store = {
    resolve: async (ref: string) => {
      const value = await creds.resolve(ref)
      return value === undefined ? undefined : { value, source: 'environment' }
    }
  }
  const sessions = new Map((options.sessions ?? []).map((entry) => [entry.id, entry]))
  const services = {
    sessions: { get: (id: string) => sessions.get(id) },
    // Folds the whole log from `init`, as dsh does for a resumed session with no checkpoint.
    sessionProjections: {
      register: async (definition: Projection) => {
        // A persisted checkpoint goes through `parse` before it seeds a fold.
        definition.stateSchema.parse(definition.init())
        return {
          stateOf: (entry: StubSession) => entry.events.reduce(definition.apply, definition.init())
        }
      }
    },
    sessionLogDeepSeek: {
      registerExclusion: (exclude: (request: { sessionId: string }) => boolean) => {
        exclusions.push(exclude)
        return async () => {}
      }
    }
  }
  const ctx = {
    get: (service: string) => (service === 'credentials' && options.credentialStore !== false ? store : undefined),
    ...services,
    tools: {
      register: (tool: { name: string; execute: Listener }) => {
        tools.push(tool)
        return () => {}
      }
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener)
      return () => true
    },
    inject: (names: string[], callback: (child: unknown) => unknown) => {
      injected.push(names)
      pending.push(Promise.resolve(callback(services)))
    },
    effect: (execute: () => () => unknown) => {
      disposers.push(execute())
      return () => {}
    },
    logger: { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) }
  }
  const ready = () => Promise.all(pending)
  const unload = async () => {
    for (const dispose of disposers) await dispose()
  }
  return { ctx: ctx as never, listeners, tools, disposers, exclusions, injected, logs, creds, ready, unload, sessions }
}

const event = (type: string, data: unknown) => ({ type, data }) as unknown as SessionEvent
const hit = { __id: 'f1', __label: 'MEMORY_FACT', factId: 'f1', text: 'Decision: use pnpm workspaces.', __score: 0.9 }

let server: FakeRushDB | undefined
let standIn: StandInRushDB | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await server?.close()
  await standIn?.close()
  server = undefined
  standIn = undefined
})

describe('plugin shape', () => {
  it('exports a Cordis plugin with a Schemastery config whose automatic context is off', () => {
    expect(name).toBe('rushdb')
    expect(inject).toEqual(['tools', 'agents', 'sessions'])
    const defaults = Config({})
    expect(defaults.autoContext).toEqual({ recall: false, capture: false })
    expect(defaults.apiKeyRef).toBe('RUSHDB_API_KEY')
    expect(defaults.recallTimeoutMs).toBe(1500)
    expect(defaults.recallLimit).toBe(6)
    expect(defaults.includeSubagents).toBe(false)
    expect(defaults.excludeFromLogUpload).toBe(false)
    expect(defaults.outboxPath).toBe('rushdb/outbox')
  })
})

describe('automatic context off (the default)', () => {
  it('registers the four tools and nothing else: no listeners, no credential reads, no requests, no files', async () => {
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' })

    apply(stub.ctx, Config({}))
    // dsh would now run sessions; with nothing registered there is nothing for them to reach.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await stub.unload()

    expect(stub.tools.map((tool) => tool.name)).toEqual([
      'rushdb_search',
      'rushdb_query',
      'rushdb_aggregate',
      'rushdb_remember'
    ])
    expect([...stub.listeners.keys()]).toEqual([])
    // Only the unload effect, which cancels open tool requests.
    expect(stub.disposers).toHaveLength(1)
    expect(stub.injected).toEqual([])
    expect(stub.creds.calls).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await filesUnder(home)).toEqual([])
  })
})

describe('credentials', () => {
  it('fall back to the launch environment when the profile has no credential store (headless)', async () => {
    server = await fakeRushDB('ok')
    vi.stubEnv('RUSHDB_API_KEY', 'env-key-5678')
    const stub = stubContext({}, { credentialStore: false })
    apply(stub.ctx, Config({ url: server.url }))
    const query = stub.tools.find((tool) => tool.name === 'rushdb_query')!
    await query.execute({ labels: ['Order'] }, { signal: new AbortController().signal })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.path).toBe('/api/v1/records/search')
  })
})

describe('automatic context on', () => {
  it('recalls before the prompt and stores the finished turn through the real SDK', async () => {
    server = await fakeRushDB('ok')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' })
    apply(stub.ctx, Config({ url: server.url, autoContext: { recall: true, capture: true }, contextScope: 'test' }))
    expect([...stub.listeners.keys()].sort()).toEqual([
      'agent/created',
      'agent/disposed',
      'agent/pre-step',
      'session/disposed',
      'session/event'
    ])

    const a = session('session-a')
    stub.listeners.get('agent/created')!({ agent: { id: a.id, session: a }, source: 'startup' })
    const decision: PreStepDecision = { kind: 'enter', messages: [userMessage('Which package manager do we use?')] }
    const result = await stub.listeners.get('agent/pre-step')!(
      { agent: { session: a }, messages: decision.messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => decision
    )
    // The fake API has nothing stored, so the decision comes back as it was, after a real recall request.
    expect(result).toBe(decision)
    expect(server.requests.some((request) => request.path.endsWith('/ai/search'))).toBe(true)

    for (const entry of turnEvents(1, 'Which package manager do we use?', 'pnpm workspaces.')) {
      stub.listeners.get('session/event')!(a, entry)
    }
    await until(() =>
      server!.requests.some((request) => request.method === 'POST' && request.body.includes('"session-a:1"'))
    )
    const sent = server.requests.find((request) => request.body.includes('"session-a:1"'))!
    expect(sent.body).toContain('"runtime":"custom"')
    expect(sent.body).not.toContain('test-key-123')

    stub.listeners.get('agent/disposed')!({ agent: { id: a.id } })
    await stub.unload()
    // Delivered turns leave the outbox.
    const outbox = await filesUnder(join(home, 'rushdb', 'outbox'))
    expect(outbox.filter((file) => file.endsWith('.json'))).toEqual([])
  })

  it('logs through dsh with credentials masked', async () => {
    server = await fakeRushDB('fail')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' })
    apply(stub.ctx, Config({ url: server.url, autoContext: { capture: true } }))
    for (const entry of turnEvents(0, 'A prompt here', 'An answer here')) {
      stub.listeners.get('session/event')!(session('s'), entry)
    }
    await until(() => stub.logs.some((line) => line.includes('RushDB write failed')), 10_000)
    expect(stub.logs.every((line) => line.startsWith('rushdb: ') && !line.includes('test-key-123'))).toBe(true)
    await stub.unload()
  })
})

describe('excludeFromLogUpload', () => {
  /** An earlier run's log: a turn whose prompt got recalled RushDB context. */
  const earlierRun = (id: string, header: StubSession['header'] = {}): StubSession => ({
    id,
    header,
    events: [
      event('turn/start', { turn: 1 }),
      event('user/message', contextMessage()),
      event('user/message', userMessage('Which package manager do we use?')),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ]
  })

  it('keeps a resumed session out of the upload, although this process never injected into it', async () => {
    const resumed = earlierRun('session-resumed')
    // The resumed turn: recall finds nothing this time, so no new context message.
    resumed.events.push(event('turn/start', { turn: 2 }), event('user/message', userMessage('And the test runner?')))
    const plain: StubSession = { id: 'session-plain', header: {}, events: [event('user/message', userMessage('Hi'))] }
    const stub = stubContext({}, { sessions: [resumed, plain] })

    apply(stub.ctx, Config({ autoContext: { recall: true }, excludeFromLogUpload: true }))
    await stub.ready()

    expect(stub.injected).toEqual([['sessionLogDeepSeek', 'sessionProjections', 'sessions']])
    const [exclude] = stub.exclusions
    expect(exclude!({ sessionId: 'session-resumed' })).toBe(true)
    expect(exclude!({ sessionId: 'session-plain' })).toBe(false)
    expect(exclude!({ sessionId: 'session-unknown' })).toBe(false)
  })

  it('keeps it out with automatic context turned off since', async () => {
    const stub = stubContext({}, { sessions: [earlierRun('session-resumed')] })
    apply(stub.ctx, Config({ excludeFromLogUpload: true }))
    await stub.ready()
    expect([...stub.listeners.keys()]).toEqual([])
    expect(stub.exclusions[0]!({ sessionId: 'session-resumed' })).toBe(true)
  })

  it('keeps out a subagent session seeded from one with RushDB context', async () => {
    const child = earlierRun('session-child', { origin: 'subagent' })
    child.events.push(event('session/end-seed', {}), event('user/message', userMessage('Subtask')))
    const stub = stubContext({}, { sessions: [child] })
    apply(stub.ctx, Config({ excludeFromLogUpload: true }))
    await stub.ready()
    expect(stub.exclusions[0]!({ sessionId: 'session-child' })).toBe(true)
  })

  it('keeps a session out after its agent is disposed and it continues under a new one', async () => {
    standIn = await standInRushDB('ok', { searchHits: [hit] })
    const live: StubSession = { id: 'session-live', header: { cwd: '/work/project' }, events: [] }
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' }, { sessions: [live] })
    apply(stub.ctx, Config({ url: standIn.url, autoContext: { recall: true }, excludeFromLogUpload: true }))
    await stub.ready()

    const decision: PreStepDecision = { kind: 'enter', messages: [userMessage('Which package manager do we use?')] }
    const result = (await stub.listeners.get('agent/pre-step')!(
      { agent: { session: live }, messages: decision.messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => decision
    )) as Extract<PreStepDecision, { kind: 'enter' }>
    expect(result.messages[0]!.source.kind).toBe('rushdb-context')
    stub.listeners.get('agent/disposed')!({ agent: { id: live.id } })
    expect(stub.exclusions[0]!({ sessionId: 'session-live' })).toBe(true)
    await stub.unload()
  })
})

describe('a RushDB that accepts the connection and never answers', () => {
  it('recall gives up at recallTimeoutMs and leaves no request open', async () => {
    standIn = await standInRushDB('hang')
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' })
    apply(stub.ctx, Config({ url: standIn.url, autoContext: { recall: true }, recallTimeoutMs: 300 }))
    const a = session('session-a')
    const decision: PreStepDecision = { kind: 'enter', messages: [userMessage('Which package manager do we use?')] }
    const started = Date.now()
    const result = await stub.listeners.get('agent/pre-step')!(
      { agent: { session: a }, messages: decision.messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => decision
    )
    expect(result).toBe(decision)
    expect(Date.now() - started).toBeLessThan(1000)
    await until(() => standIn!.requests.length > 0 && standIn!.open() === 0, 2000)
    expect(standIn.requests.every((request) => request.abandoned)).toBe(true)
  })

  it('a tool call ends with an error at its deadline and leaves no request open', async () => {
    standIn = await standInRushDB('hang')
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' })
    apply(stub.ctx, Config({ url: standIn.url }))
    const query = stub.tools.find((tool) => tool.name === 'rushdb_query')!
    // dsh's tool-call timeout policy aborts the call's signal at the tool's timeoutMs.
    const pending = query.execute({ labels: ['Order'] }, { signal: AbortSignal.timeout(300) })
    await expect(pending).rejects.toThrow()
    await until(() => standIn!.requests.length === 1 && standIn!.open() === 0, 2000)
    expect(standIn.requests[0]!.abandoned).toBe(true)
  })

  it('unload is bounded, cancels open requests, and the outbox keeps the turn for the next run', async () => {
    standIn = await standInRushDB('hang')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' })
    apply(stub.ctx, Config({ url: standIn.url, autoContext: { capture: true } }))
    for (const entry of turnEvents(1, 'Which package manager do we use?', 'pnpm workspaces.')) {
      stub.listeners.get('session/event')!(session('session-a'), entry)
    }
    await until(() => standIn!.open() > 0, 5000)

    const started = Date.now()
    await stub.unload()
    expect(Date.now() - started).toBeLessThan(DISPOSE_FLUSH_MS + 1000)
    await until(() => standIn!.open() === 0, 2000)

    const outbox = join(home, 'rushdb', 'outbox')
    const files = (await readdir(outbox)).filter((file) => file.endsWith('.json'))
    expect(files).toHaveLength(1)
    const kept = JSON.parse(await readFile(join(outbox, files[0]!), 'utf8')) as { sourceEventId: string }
    expect(kept.sourceEventId).toBe('session-a:1')

    // The next run, with RushDB answering, delivers it and empties the outbox.
    server = await fakeRushDB('ok')
    const next = stubContext({ RUSHDB_API_KEY: 'test-key-123' })
    apply(next.ctx, Config({ url: server.url, autoContext: { capture: true } }))
    await until(() => server!.requests.some((request) => request.body.includes('"session-a:1"')), 10_000)
    await until(async () => (await readdir(outbox)).filter((file) => file.endsWith('.json')).length === 0, 5000)
    await next.unload()
  })
})
