import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConnection } from '../src/config.ts'
import { RequestTimeoutError, Transport } from '../src/transport.ts'
import { credentials, settingsFor, standInRushDB, tempDir, until, type StandInRushDB } from './helpers.ts'

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

/**
 * Runs one request to the blackhole in a child process and returns how long the process lived. Only a separate
 * process shows whether a connect still in progress keeps the event loop, and so dsh, alive.
 */
function childLifetime(timeoutMs: number, closeAfterMs?: number): Promise<number> {
  const script = `
    const { Transport } = await import(${JSON.stringify(transportModule)})
    const transport = new Transport({ timeoutMs: ${timeoutMs} })
    transport.fetch(${JSON.stringify(BLACKHOLE_URL)}).catch(() => {})
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
