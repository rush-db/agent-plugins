import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { PreStepDecision } from '../src/host.ts'
import { fakeRushDB, type FakeRushDB } from '../../hooks/test/helpers.ts'
import { credentials, filesUnder, session, tempDir, turnEvents, until, userMessage } from './helpers.ts'

type Listener = (...args: any[]) => any

/** A Cordis context stand-in with the services the plugin injects. */
function stubContext(values: Record<string, string> = {}, options: { credentialStore?: boolean } = {}) {
  const listeners = new Map<string, Listener>()
  const tools: Array<{ name: string; execute: Listener }> = []
  const disposers: Array<() => unknown> = []
  const exclusions: Array<(request: { sessionId: string }) => boolean> = []
  const injected: string[][] = []
  const logs: string[] = []
  const creds = credentials(values)
  const store = {
    resolve: async (ref: string) => {
      const value = await creds.resolve(ref)
      return value === undefined ? undefined : { value, source: 'environment' }
    }
  }
  const ctx = {
    get: (service: string) => (service === 'credentials' && options.credentialStore !== false ? store : undefined),
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
    inject: (services: string[], callback: (child: unknown) => void) => {
      injected.push(services)
      callback({
        sessionLogDeepSeek: {
          registerExclusion: (exclude: (request: { sessionId: string }) => boolean) => {
            exclusions.push(exclude)
            return async () => {}
          }
        }
      })
    },
    effect: (execute: () => () => unknown) => {
      disposers.push(execute())
      return () => {}
    },
    logger: { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) }
  }
  return { ctx: ctx as never, listeners, tools, disposers, exclusions, injected, logs, creds }
}

let server: FakeRushDB | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await server?.close()
  server = undefined
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

    expect(stub.tools.map((tool) => tool.name)).toEqual([
      'rushdb_search',
      'rushdb_query',
      'rushdb_aggregate',
      'rushdb_remember'
    ])
    expect([...stub.listeners.keys()]).toEqual([])
    expect(stub.disposers).toEqual([])
    expect(stub.injected).toEqual([])
    expect(stub.creds.calls).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await filesUnder(home)).toEqual([])
  })

  it('stays off with excludeFromLogUpload set and nothing else', async () => {
    const stub = stubContext()
    apply(stub.ctx, Config({ excludeFromLogUpload: true }))
    expect([...stub.listeners.keys()]).toEqual([])
    expect(stub.injected).toEqual([])
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

    for (const event of turnEvents(1, 'Which package manager do we use?', 'pnpm workspaces.')) {
      stub.listeners.get('session/event')!(a, event)
    }
    await until(() =>
      server!.requests.some((request) => request.method === 'POST' && request.body.includes('"session-a:1"'))
    )
    const sent = server.requests.find((request) => request.body.includes('"session-a:1"'))!
    expect(sent.body).toContain('"runtime":"custom"')
    expect(sent.body).not.toContain('test-key-123')

    stub.listeners.get('agent/disposed')!({ agent: { id: a.id } })
    for (const dispose of stub.disposers) await dispose()
    // Delivered turns leave the outbox.
    const outbox = await filesUnder(join(home, 'rushdb', 'outbox'))
    expect(outbox.filter((file) => file.endsWith('.json'))).toEqual([])
  })

  it('excludes sessions that received RushDB context from the DeepSeek log upload, when asked', async () => {
    const stub = stubContext()
    apply(stub.ctx, Config({ autoContext: { recall: true }, excludeFromLogUpload: true }))
    expect(stub.injected).toEqual([['sessionLogDeepSeek']])
    expect(stub.exclusions).toHaveLength(1)
    expect(stub.exclusions[0]!({ sessionId: 'never-injected' })).toBe(false)
  })

  it('logs through dsh with credentials masked', async () => {
    server = await fakeRushDB('fail')
    const home = await tempDir()
    vi.stubEnv('DSH_HOME', home)
    const stub = stubContext({ RUSHDB_API_KEY: 'test-key-123' })
    apply(stub.ctx, Config({ url: server.url, autoContext: { capture: true } }))
    for (const event of turnEvents(0, 'A prompt here', 'An answer here')) {
      stub.listeners.get('session/event')!(session('s'), event)
    }
    await until(() => stub.logs.some((line) => line.includes('RushDB write failed')), 10_000)
    expect(stub.logs.every((line) => line.startsWith('rushdb: ') && !line.includes('test-key-123'))).toBe(true)
    for (const dispose of stub.disposers) await dispose()
  })
})
