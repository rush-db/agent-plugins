/**
 * Every RushDB request this plugin makes, and every embedding request, goes through one transport on `fetch`, so each
 * has a deadline and the plugin can cancel what is still open when it unloads. Without it a RushDB that accepts the
 * connection and never answers holds headless dsh open after the answer until the SDK's own 80 s timeout, or longer
 * when the network drops packets.
 *
 * Requests use undici's own `fetch` with dispatchers of their own, one per deadline, whose connect timeout is that
 * deadline: an aborted request alone doesn't end a TCP connect still in progress, and Node's default connect timeout is
 * 10 s. The sockets they open are tracked, and `close()` destroys them, so a connect to an address that drops packets
 * can't keep the process alive after unload.
 *
 * Own dispatchers would bypass dsh's HTTP proxy, which dsh installs as undici's global dispatcher. So each request asks
 * dsh's policy (`proxyRouteFor`, which applies HTTP(S)_PROXY, ALL_PROXY and NO_PROXY as dsh resolved them at launch)
 * how to go: through a `ProxyAgent` to the proxy it names, built the way dsh builds its own, or direct. Both kinds get
 * the deadline as connect timeout and have their sockets tracked; dsh's own global dispatcher is never touched.
 *
 * Patterned on packages/pi/src/transport.ts (branch feat/p2-pi); kept inside this package until both are unified.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Socket } from 'node:net'
import type RushDB from '@rushdb/javascript-sdk'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { Agent, buildConnector, Client, Pool, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'

type Connector = buildConnector.connector

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

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input
  return new URL(typeof input === 'string' ? input : input.url)
}

export class Transport {
  private readonly closer = new AbortController()
  private readonly scopes = new AsyncLocalStorage<RequestScope>()
  private readonly defaultTimeoutMs: number
  /** One dispatcher per route and deadline, so each request's connect timeout is its own deadline. */
  private readonly agents = new Map<string, Dispatcher>()
  private readonly sockets = new Set<Socket>()

  public constructor(options: { timeoutMs?: number } = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  /** `connect` with every socket it opens tracked, so `close()` can destroy one still connecting. */
  private tracked(connect: Connector): Connector {
    return ((options, callback) => {
      // undici's connector returns the socket it is connecting, though its types say void. The tunnel connector of a
      // ProxyAgent returns a promise instead; its socket comes from the proxy client's connector, tracked there.
      const socket = connect(options, callback) as unknown
      if (socket && typeof (socket as Socket).destroy === 'function' && typeof (socket as Socket).once === 'function') {
        const tracked = socket as Socket
        this.sockets.add(tracked)
        tracked.once('close', () => this.sockets.delete(tracked))
      }
      return socket
    }) as Connector
  }

  private dispatcher(url: URL, timeoutMs: number): Dispatcher {
    const route = proxyRouteFor(url)
    const key = route.proxied ? `${timeoutMs} ${route.proxy}` : String(timeoutMs)
    let agent = this.agents.get(key)
    if (agent) return agent
    if (route.proxied) {
      // The same ProxyAgent dsh's own policy dispatcher builds, with the deadline as connect timeout (to the proxy,
      // and to RushDB through a tunnel) and both connectors tracked.
      const pool =
        (extra: Pool.Options = {}) =>
        (origin: string | URL, options: object): Dispatcher => {
          const passed = { ...(options as Pool.Options), ...extra }
          const connect = typeof passed.connect === 'function' ? this.tracked(passed.connect) : passed.connect
          return passed.connections === 1
            ? new Client(origin, { ...passed, connect })
            : new Pool(origin, { ...passed, connect })
        }
      agent = new ProxyAgent({
        uri: route.proxy,
        connectTimeout: timeoutMs,
        // The proxy client sends the tunnel's CONNECT without the request's signal; the deadline as headers timeout
        // ends a CONNECT the proxy never answers instead of undici's 300 s default.
        clientFactory: pool({ headersTimeout: timeoutMs }) as ProxyAgent.Options['clientFactory'],
        factory: pool()
      })
    } else {
      agent = new Agent({ connect: this.tracked(buildConnector({ timeout: timeoutMs })) })
    }
    this.agents.set(key, agent)
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
        dispatcher: this.dispatcher(requestUrl(input), timeoutMs)
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
