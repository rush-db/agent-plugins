// Runs the bundle against a local engine container started by `pnpm test:integration`
// (packages/core/scripts/with-engine.mjs), in direct mode, with a local OpenAI-compatible embedding stub.
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sha256 } from '@rushdb/agent-memory-contract'
import { bundleHooks, HOOK_BUNDLE_NAME } from '../src/bundle.ts'
import type { Command, Host } from '../src/hosts.ts'
import { fixture } from './helpers.ts'

const engineUrl = process.env.RUSHDB_TEST_ENGINE_URL
const engineToken = process.env.RUSHDB_TEST_ENGINE_TOKEN
const DIMENSIONS = 64
const CONTEXT_SCOPE = `e2e-${Date.now()}`

/** Hashed bag-of-words vectors behind an OpenAI-style `POST /embeddings`. */
function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    vector[parseInt(sha256(word).slice(0, 8), 16) % DIMENSIONS]! += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((value) => value / norm)
}

let embeddings: Server
let embeddingUrl: string
let script: string
let home: string

beforeAll(async () => {
  embeddings = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: embed(text) })) }))
    })
  })
  await new Promise<void>((done) => embeddings.listen(0, '127.0.0.1', done))
  embeddingUrl = `http://127.0.0.1:${(embeddings.address() as AddressInfo).port}/v1`
  const directory = await mkdtemp(join(tmpdir(), 'rushdb-hooks-e2e-'))
  script = join(directory, HOOK_BUNDLE_NAME)
  await writeFile(script, await bundleHooks(resolve(import.meta.dirname, '../../..')))
  home = await mkdtemp(join(tmpdir(), 'rushdb-hooks-e2e-home-'))
}, 60_000)

afterAll(async () => {
  await new Promise((done) => embeddings?.close(done))
})

function runBundle(command: Command, host: Host, stdin: unknown) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.state'),
    RUSHDB_AUTO_CONTEXT: 'recall+persist',
    RUSHDB_ENGINE_URL: engineUrl,
    RUSHDB_ENGINE_TOKEN: engineToken,
    RUSHDB_EMBEDDING_BASE_URL: embeddingUrl,
    RUSHDB_EMBEDDING_API_KEY: 'stub',
    RUSHDB_EMBEDDING_MODEL: 'stub',
    RUSHDB_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
    RUSHDB_CONTEXT_SCOPE: CONTEXT_SCOPE
  }
  return new Promise<{ code: number | null; stdout: string }>((done) => {
    const child = spawn(process.execPath, [script, command, '--host', host], { env, cwd: home })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('close', (code) => done({ code, stdout }))
    child.stdin.end(JSON.stringify(stdin))
  })
}

describe.skipIf(!engineUrl || !engineToken)('bundle against a local engine', () => {
  it('a Gemini session recalls what a Claude session captured, after the Claude hooks exited', async () => {
    // Session A (Claude): Stop captures the turn and starts a detached flush; SessionEnd returns at once.
    const stop = await runBundle('capture', 'claude', await fixture('claude', 'Stop', { cwd: home }))
    expect(stop).toEqual({ code: 0, stdout: '' })
    expect((await runBundle('end', 'claude', await fixture('claude', 'SessionEnd', { cwd: home }))).code).toBe(0)

    const outbox = join(home, '.state', 'rushdb', 'outbox')
    const deadline = Date.now() + 20_000
    while ((await readdir(outbox)).some((name) => name.endsWith('.json')) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 200))
    }
    expect((await readdir(outbox)).filter((name) => name.endsWith('.json'))).toEqual([])

    // Session B (Gemini), same project: SessionStart recalls the decision.
    const start = await runBundle('recall', 'gemini', await fixture('gemini', 'SessionStart', { cwd: home }))
    expect(start.code).toBe(0)
    const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext as string
    expect(context).toMatch(/^Context recalled from RushDB/)
    expect(context).toContain('pnpm workspaces')
  })
})
