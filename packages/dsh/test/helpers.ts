import { mkdtemp, readdir } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RushDBAgentMemory } from '@rushdb/agent-memory-contract'
import {
  createUserMessage,
  CONTEXT_SOURCE_KIND,
  type Session,
  type SessionEvent,
  type UserMessage
} from '../src/host.ts'
import { ClientCache, type CreateClient } from '../src/client.ts'
import { resolveSettings, type Config, type Credentials, type Settings } from '../src/config.ts'

export async function tempDir(prefix = 'rushdb-dsh-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Every file under `directory`, relative; [] when it doesn't exist. */
export async function filesUnder(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { recursive: true })).map(String)
  } catch {
    return []
  }
}

export function settingsFor(dshHome: string, config: Config = {}): Settings {
  return resolveSettings(config, { DSH_HOME: dshHome })
}

/** A secret source holding `values` by credential name. */
export function credentials(values: Record<string, string> = {}): Credentials & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    resolve: async (name: string) => {
      calls.push(name)
      return values[name]
    }
  }
}

export type MemoryStub = Pick<
  RushDBAgentMemory,
  'recall' | 'persistEpisode' | 'persistFact' | 'rememberRecent' | 'ensureIndexes'
>

export function memoryStub(overrides: Partial<MemoryStub> = {}): MemoryStub {
  return {
    recall: async () => [],
    persistEpisode: async (episode) => episode as never,
    persistFact: async (fact) => fact as never,
    rememberRecent: (episode) => episode as never,
    ensureIndexes: async () => {},
    ...overrides
  }
}

export function clientsFor(
  settings: Settings,
  memory: MemoryStub,
  db: unknown = {},
  values: Record<string, string> = { RUSHDB_API_KEY: 'test-key-123' }
): ClientCache {
  const create: CreateClient = () => ({ db: db as never, memory: memory as never })
  return new ClientCache(settings, credentials(values), create)
}

export function session(
  id: string,
  header: { cwd?: string; origin?: 'subagent' } = {}
): Pick<Session, 'id' | 'header'> {
  return { id: id as Session['id'], header: { cwd: '/work/project', ...header } as Session['header'] }
}

export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The session events dsh emits for one turn, in order. */
export function turnEvents(turn: number, prompt: string, answer: string, reason = 'completed'): SessionEvent[] {
  const event = (type: string, data: unknown) => ({ type, data }) as unknown as SessionEvent
  return [
    event('turn/start', { turn }),
    event('user/message', userMessage(prompt)),
    event('assistant/message', {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
      stream: []
    }),
    event('assistant/message', {
      turn,
      step: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
      stream: []
    }),
    event('turn/end', { turn, reason: { kind: reason } })
  ]
}

export function hang<T>(): Promise<T> {
  return new Promise(() => {})
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A user message carrying recalled RushDB context, as the pre-step inserts it. */
export function contextMessage(text = 'Context recalled from RushDB (historical, may be outdated).'): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: CONTEXT_SOURCE_KIND, form: 'recall' } })
}

export interface StandInRequest {
  method: string
  path: string
  body: string
  /** The client dropped the connection before an answer. */
  abandoned: boolean
}

export interface StandInRushDB {
  url: string
  requests: StandInRequest[]
  /** Requests whose connection is still open, waiting for an answer that never comes. */
  open(): number
  close(): Promise<void>
}

/**
 * A local RushDB API stand-in. `ok` answers every request (recall searches with `searchHits`); `hang` accepts the
 * connection, reads the request and never answers.
 */
export async function standInRushDB(
  mode: 'ok' | 'hang',
  options: { searchHits?: Array<Record<string, unknown>> } = {}
): Promise<StandInRushDB> {
  const requests: StandInRequest[] = []
  const pending = new Set<ServerResponse>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const entry: StandInRequest = { method: request.method ?? '', path: request.url ?? '', body, abandoned: false }
      requests.push(entry)
      if (mode === 'hang') {
        pending.add(response)
        response.on('close', () => {
          entry.abandoned = !response.writableEnded
          pending.delete(response)
        })
        return
      }
      const hits = entry.path.endsWith('/ai/search') ? (options.searchHits ?? []) : []
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: true, data: hits, total: hits.length }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    open: () => pending.size,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export interface FakeProxy {
  url: string
  /** `METHOD absolute-url` for forwarded requests, `CONNECT host:port` for tunnels. */
  requests: string[]
  /** Client connections still open. */
  open(): number
  close(): Promise<void>
}

/**
 * A local HTTP proxy that records what goes through it. Forwarded requests (`GET http://host/...`) all go to
 * `upstream`, whatever host they name, so a hostname nothing else resolves reaches a local stand-in. CONNECT requests
 * are recorded and never answered.
 */
export async function fakeProxy(upstream: string): Promise<FakeProxy> {
  const requests: string[] = []
  const sockets = new Set<import('node:net').Socket>()
  const target = new URL(upstream)
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    const url = new URL(request.url ?? '/')
    const forwarded = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      }
    )
    forwarded.on('error', () => response.destroy())
    response.on('close', () => forwarded.destroy())
    request.pipe(forwarded)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('connect', (request, socket) => {
    requests.push(`CONNECT ${request.url}`)
    // The server hands the socket over half-open; close this side when the client ends its own.
    socket.on('end', () => socket.destroy())
    socket.on('error', () => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    open: () => sockets.size,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}
