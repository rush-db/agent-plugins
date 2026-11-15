import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConnection } from '../src/config.ts'
import { RequestTimeoutError, Transport } from '../src/transport.ts'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import {
  credentials,
  fakeProxy,
  settingsFor,
  standInRushDB,
  tempDir,
  until,
  type FakeProxy,
  type StandInRushDB
} from './helpers.ts'

let api: StandInRushDB | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

describe('Transport', () => {
  it('sends JSON and reads the JSON answer', async () => {
    api = await standInRushDB('ok')
    const response = await new Transport().httpClient.makeRequest(`${api.url}/records/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      requestData: { labels: ['EPISODE'] }
    })
    expect(response.getStatusCode()).toBe(200)
    expect(await response.toJSON()).toEqual({ success: true, data: [], total: 0 })
    expect(api.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/records/search',
      body: '{"labels":["EPISODE"]}'
    })
  })

  it('ends a request at its deadline and drops the connection', async () => {
    api = await standInRushDB('hang')
    const transport = new Transport({ timeoutMs: 200 })
    const started = Date.now()
    await expect(transport.httpClient.makeRequest(`${api.url}/x`, { method: 'GET' })).rejects.toBeInstanceOf(
      RequestTimeoutError
    )
    expect(Date.now() - started).toBeLessThan(1000)
    await until(() => api!.open() === 0, 2000)
    expect(api.requests[0]!.abandoned).toBe(true)
  })

  it('applies an operation scope to every request inside it, through awaits', async () => {
    api = await standInRushDB('hang')
    const transport = new Transport({ timeoutMs: 60_000 })
    const pending = transport.run({ timeoutMs: 150 }, async () => {
      await Promise.resolve()
      return transport.httpClient.makeRequest(`${api!.url}/x`, { method: 'GET' })
    })
    await expect(pending).rejects.toThrow('within 150 ms')
  })

  it('cancels a scope’s requests when its signal aborts', async () => {
    api = await standInRushDB('hang')
    const transport = new Transport({ timeoutMs: 60_000 })
    const controller = new AbortController()
    const pending = transport.run({ signal: controller.signal }, () =>
      transport.httpClient.makeRequest(`${api!.url}/x`, { method: 'GET' })
    )
    await until(() => api!.open() === 1)
    controller.abort(new Error('turn cancelled'))
    await expect(pending).rejects.toThrow('turn cancelled')
    await until(() => api!.open() === 0, 2000)
  })

  it('cancels every open request on close, and later ones fail at once', async () => {
    api = await standInRushDB('hang')
    const transport = new Transport({ timeoutMs: 60_000 })
    const pending = transport.httpClient.makeRequest(`${api.url}/x`, { method: 'GET' })
    await until(() => api!.open() === 1)
    const started = Date.now()
    transport.close()
    await expect(pending).rejects.toThrow('the plugin unloaded')
    expect(Date.now() - started).toBeLessThan(500)
    await until(() => api!.open() === 0, 2000)
    await expect(transport.httpClient.makeRequest(`${api.url}/y`, { method: 'GET' })).rejects.toThrow()
  })

  it('also carries the embedding provider’s requests', async () => {
    api = await standInRushDB('hang')
    const transport = new Transport({ timeoutMs: 200 })
    const settings = settingsFor(await tempDir(), {
      engineUrl: 'http://127.0.0.1:9',
      embedding: { baseUrl: api.url, model: 'm', dimensions: 4 }
    })
    const connection = await resolveConnection(
      settings,
      credentials({ RUSHDB_ENGINE_TOKEN: 'token-1234', RUSHDB_EMBEDDING_API_KEY: 'embed-1234' }),
      transport.fetch
    )
    await expect(connection.options.embedder!.embed(['text'])).rejects.toBeInstanceOf(RequestTimeoutError)
    expect(api.requests[0]!.path).toBe('/api/v1/embeddings')
  })
})

/** An address that drops packets: a TCP connect to it neither succeeds nor fails. */
const BLACKHOLE_URL = process.env.RUSHDB_TEST_BLACKHOLE_URL ?? 'http://10.255.255.1/api/v1'
const transportModule = fileURLToPath(new URL('../src/transport.ts', import.meta.url))
const proxyModule = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-http-proxy')

/**
 * Runs one request to the blackhole in a child process and returns how long the process lived. Only a separate
 * process shows whether a connect still in progress keeps the event loop, and so dsh, alive.
 */
function childLifetime(
  timeoutMs: number,
  closeAfterMs?: number,
  options: { env?: Record<string, string>; url?: string } = {}
): Promise<number> {
  // With `env`, the child installs dsh's proxy policy from it first, as dsh's launcher does.
  const script = `
    const { installProxyFromEnvironment } = await import(${JSON.stringify(proxyModule)})
    const env = ${JSON.stringify(options.env ?? {})}
    await installProxyFromEnvironment({ get: (name) => (env[name] === undefined ? undefined : { value: env[name] }) }, () => {})
    const { Transport } = await import(${JSON.stringify(transportModule)})
    const transport = new Transport({ timeoutMs: ${timeoutMs} })
    transport.fetch(${JSON.stringify(options.url ?? BLACKHOLE_URL)}).catch(() => {})
    ${closeAfterMs === undefined ? '' : `setTimeout(() => transport.close(), ${closeAfterMs})`}
  `
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', () => resolve(Date.now() - started))
  })
}

describe('a RushDB address that drops packets', () => {
  it('lets the process exit at the request deadline, not at Node’s 10 s connect timeout', async () => {
    expect(await childLifetime(1500)).toBeLessThan(4000)
  })

  it('lets the process exit at once when the transport closes, whatever the deadline', async () => {
    expect(await childLifetime(60_000, 300)).toBeLessThan(2500)
  })
})

describe('dsh’s HTTP proxy', () => {
  /** Only the fake proxy resolves this host; a direct request to it fails. */
  const PROXIED_URL = 'http://rushdb.proxy-test.invalid/api/v1'
  let proxy: FakeProxy | undefined
  let uninstall: (() => Promise<void>) | undefined

  /** Installs dsh's proxy policy from `env`, as dsh's launcher does from the launch environment. */
  async function installPolicy(env: Record<string, string>) {
    uninstall = await installProxyFromEnvironment(
      { get: (name) => (env[name] === undefined ? undefined : { value: env[name] }) },
      () => {}
    )
  }

  afterEach(async () => {
    await uninstall?.()
    uninstall = undefined
    await proxy?.close()
    proxy = undefined
  })

  it('goes direct without a proxy', async () => {
    api = await standInRushDB('ok')
    proxy = await fakeProxy(api.url)
    await installPolicy({})
    const response = await new Transport().httpClient.makeRequest(`${api.url}/records/search`, {
      method: 'POST',
      requestData: {}
    })
    expect(response.getStatusCode()).toBe(200)
    expect(api.requests).toHaveLength(1)
    expect(proxy.requests).toEqual([])
  })

  it('goes through HTTP_PROXY, as dsh routes every request', async () => {
    api = await standInRushDB('ok')
    proxy = await fakeProxy(api.url)
    await installPolicy({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url })
    const response = await new Transport().httpClient.makeRequest(`${PROXIED_URL}/records/search`, {
      method: 'POST',
      requestData: { labels: ['EPISODE'] }
    })
    expect(response.getStatusCode()).toBe(200)
    expect(proxy.requests).toEqual([`POST ${PROXIED_URL}/records/search`])
    expect(api.requests[0]).toMatchObject({ path: '/api/v1/records/search', body: '{"labels":["EPISODE"]}' })
  })

  it('goes direct for a host NO_PROXY lists', async () => {
    api = await standInRushDB('ok')
    proxy = await fakeProxy(api.url)
    await installPolicy({ HTTP_PROXY: proxy.url, NO_PROXY: 'rushdb.proxy-test.invalid' })
    await expect(new Transport().httpClient.makeRequest(`${PROXIED_URL}/x`, { method: 'GET' })).rejects.toThrow()
    expect(proxy.requests).toEqual([])
  })

  it('keeps the deadline through the proxy, and drops the proxy connection', async () => {
    api = await standInRushDB('hang')
    proxy = await fakeProxy(api.url)
    await installPolicy({ HTTP_PROXY: proxy.url })
    const started = Date.now()
    await expect(
      new Transport({ timeoutMs: 300 }).httpClient.makeRequest(`${PROXIED_URL}/x`, { method: 'GET' })
    ).rejects.toBeInstanceOf(RequestTimeoutError)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(proxy.requests).toEqual([`GET ${PROXIED_URL}/x`])
    await until(() => proxy!.open() === 0, 2000)
  })

  it('keeps the deadline on a tunnel the proxy never opens (HTTPS_PROXY, CONNECT)', async () => {
    api = await standInRushDB('ok')
    proxy = await fakeProxy(api.url)
    await installPolicy({ HTTPS_PROXY: proxy.url })
    await expect(
      new Transport({ timeoutMs: 300 }).httpClient.makeRequest('https://rushdb.proxy-test.invalid/api/v1/x', {
        method: 'GET'
      })
    ).rejects.toThrow()
    expect(proxy.requests).toEqual(['CONNECT rushdb.proxy-test.invalid:443'])
    await until(() => proxy!.open() === 0, 3000)
  })

  it('cancels proxied requests at once on close', async () => {
    api = await standInRushDB('hang')
    proxy = await fakeProxy(api.url)
    await installPolicy({ HTTP_PROXY: proxy.url })
    const transport = new Transport({ timeoutMs: 60_000 })
    const pending = transport.httpClient.makeRequest(`${PROXIED_URL}/x`, { method: 'GET' })
    await until(() => api!.open() === 1)
    const started = Date.now()
    transport.close()
    await expect(pending).rejects.toThrow('the plugin unloaded')
    expect(Date.now() - started).toBeLessThan(500)
    await until(() => proxy!.open() === 0, 2000)
  })

  it('lets the process exit at the deadline, and at once on close, when the proxy drops packets', async () => {
    const env = { HTTP_PROXY: BLACKHOLE_URL.replace(/\/api\/v1$/, '') }
    expect(await childLifetime(1500, undefined, { env, url: PROXIED_URL })).toBeLessThan(4000)
    expect(await childLifetime(60_000, 300, { env, url: PROXIED_URL })).toBeLessThan(2500)
  })
})
