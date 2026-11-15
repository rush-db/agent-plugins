import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Host } from '../src/hosts.ts'

export const fixtures = join(import.meta.dirname, 'fixtures')

/** A host's recorded stdin, with the transcript path and working directory filled in. */
export async function fixture(host: Host, event: string, values: { cwd: string; transcript?: string }) {
  const text = await readFile(join(fixtures, host, `${event}.json`), 'utf8')
  return JSON.parse(
    text
      .replaceAll('"CWD"', JSON.stringify(values.cwd))
      .replaceAll('"TRANSCRIPT"', JSON.stringify(values.transcript ?? join(fixtures, `${host}-transcript.jsonl`)))
  ) as Record<string, unknown>
}

export interface FakeRushDB {
  url: string
  requests: Array<{ method: string; path: string; body: string }>
  close(): Promise<void>
}

/**
 * A stand-in RushDB API on a free local port. `ok` answers every request with an empty success, `hang` never
 * answers, `fail` answers 500.
 */
export async function fakeRushDB(mode: 'ok' | 'hang' | 'fail'): Promise<FakeRushDB> {
  const requests: FakeRushDB['requests'] = []
  const open = new Set<IncomingMessage>()
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      requests.push({ method: request.method ?? '', path: request.url ?? '', body })
      if (mode === 'hang') {
        open.add(request)
        return
      }
      response.writeHead(mode === 'ok' ? 200 : 500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(mode === 'ok' ? { success: true, data: [], total: 0 } : { success: false, message: 'down' })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const request of open) request.socket.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
