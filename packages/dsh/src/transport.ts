/**
 * Every RushDB request this plugin makes, and every embedding request, goes through one transport on `fetch`, so each
 * has a deadline and the plugin can cancel what is still open when it unloads. Without it a RushDB that accepts the
 * connection and never answers holds headless dsh open after the answer until the SDK's own 80 s timeout, or longer
 * when the network drops packets.
 *
 * Requests use undici's own `fetch` and `Agent`s, one per deadline, whose connect timeout is that deadline: an aborted
 * request alone doesn't end a TCP connect still in progress, and Node's default connect timeout is 10 s. The sockets
 * the agents open are tracked, and `close()` destroys them, so a connect to an address that drops packets can't keep
 * the process alive after unload.
 *
 * Patterned on packages/pi/src/transport.ts (branch feat/p2-pi); kept inside this package until both are unified.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Socket } from 'node:net'
import type RushDB from '@rushdb/javascript-sdk'
import { Agent, buildConnector, fetch as undiciFetch } from 'undici'

type SDKOptions = NonNullable<ConstructorParameters<typeof RushDB>[1]>
export type HttpClient = NonNullable<SDKOptions['httpClient']>
type RequestConfig = Parameters<HttpClient['makeRequest']>[1]

/** Deadline of a request outside any operation: outbox writes, index setup. */
export const REQUEST_TIMEOUT_MS = 10_000

/** What one operation (a recall, a tool call) adds to its requests: a deadline and a way to cancel them. */
export interface RequestScope {
  signal?: AbortSignal
  timeoutMs?: number
}

export class RequestTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`RushDB did not answer within ${timeoutMs} ms`)
    this.name = 'RequestTimeoutError'
  }
}

function requestBody(config: RequestConfig): BodyInit | undefined {
  const { rawBody, requestData } = config
  if (rawBody instanceof Uint8Array || (typeof Blob !== 'undefined' && rawBody instanceof Blob)) return rawBody
  if (rawBody !== undefined) throw new Error('RushDB transport does not stream request bodies')
  return requestData === undefined ? undefined : JSON.stringify(requestData)
}

export class Transport {
  private readonly closer = new AbortController()
  private readonly scopes = new AsyncLocalStorage<RequestScope>()
  private readonly defaultTimeoutMs: number
  /** One agent per deadline, so each request's connect timeout is its own deadline. */
  private readonly agents = new Map<number, Agent>()
  private readonly sockets = new Set<Socket>()

  public constructor(options: { timeoutMs?: number } = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  private dispatcher(timeoutMs: number): Agent {
    let agent = this.agents.get(timeoutMs)
    if (!agent) {
      const connect = buildConnector({ timeout: timeoutMs })
      agent = new Agent({
        connect: (options, callback) => {
          // undici's connector returns the socket it is connecting, though its types say void.
          const socket = connect(options, callback) as unknown as Socket | undefined
          if (socket) {
            this.sockets.add(socket)
            socket.once('close', () => this.sockets.delete(socket))
          }
          return socket
        }
      })
      this.agents.set(timeoutMs, agent)
    }
    return agent
  }

  /**
   * Runs `task` with `scope` applied to every request it starts, including in nested awaits. An inner scope keeps the
   * outer one's signal too.
   */
  public run<T>(scope: RequestScope, task: () => Promise<T>): Promise<T> {
    const outer = this.scopes.getStore()
    const signals = [outer?.signal, scope.signal].filter((signal): signal is AbortSignal => signal !== undefined)
    const merged: RequestScope = {
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      timeoutMs: scope.timeoutMs ?? outer?.timeoutMs
    }
    return this.scopes.run(merged, task)
  }

  /** `fetch` with the current scope's deadline and cancellation, and the transport's own. */
  public readonly fetch: typeof fetch = async (input, init) => {
    const scope = this.scopes.getStore()
    const timeoutMs = scope?.timeoutMs ?? this.defaultTimeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signals = [this.closer.signal, timeout, scope?.signal, init?.signal ?? undefined].filter(
      (signal): signal is AbortSignal => signal !== undefined
    )
    try {
      const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        signal: AbortSignal.any(signals),
        dispatcher: this.dispatcher(timeoutMs)
      })
      return response as unknown as Response
    } catch (error) {
      if (timeout.aborted && !this.closer.signal.aborted && !scope?.signal?.aborted) {
        throw new RequestTimeoutError(timeoutMs)
      }
      const cancelled = [this.closer.signal, scope?.signal].find((signal) => signal?.aborted)
      if (cancelled) throw cancelled.reason instanceof Error ? cancelled.reason : new Error('RushDB request cancelled')
      throw error
    }
  }

  /** The RushDB SDK's HTTP client on `fetch`. */
  public readonly httpClient: HttpClient = {
    makeRequest: async (url, config) => {
      const response = await this.fetch(url, {
        method: config.method,
        headers: config.headers as HeadersInit | undefined,
        body: requestBody(config)
      })
      return {
        getStatusCode: () => response.status,
        getHeaders: () => Object.fromEntries(response.headers.entries()),
        getRawResponse: () => response,
        toStream: () => {
          throw new Error('RushDB transport does not stream responses')
        },
        toJSON: () => response.json()
      }
    }
  } as HttpClient

  /** Cancels every open request and connect; later requests fail at once. */
  public close(reason = 'RushDB requests cancelled: the plugin unloaded'): void {
    if (!this.closer.signal.aborted) this.closer.abort(new Error(reason))
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    for (const agent of this.agents.values()) agent.destroy().catch(() => {})
    this.agents.clear()
  }
}
