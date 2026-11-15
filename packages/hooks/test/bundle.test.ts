// Runs the real bundle as a host would: node rushdb-hooks.mjs <command> --host <host>, JSON on stdin.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { bundleHooks, HOOK_BUNDLE_LIMIT, HOOK_BUNDLE_NAME } from '../src/bundle.ts'
import type { Command, Host } from '../src/hosts.ts'
import { fakeRushDB, fixture, type FakeRushDB } from './helpers.ts'

const repoRoot = resolve(import.meta.dirname, '../../..')

let bundle: string
let script: string
let home: string
let server: FakeRushDB | undefined

beforeAll(async () => {
  bundle = await bundleHooks(repoRoot)
  // Alone in an empty directory: no node_modules, no package.json, as in a plugin folder.
  const directory = await mkdtemp(join(tmpdir(), 'rushdb-hooks-bundle-'))
  script = join(directory, HOOK_BUNDLE_NAME)
  await writeFile(script, bundle)
}, 60_000)

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function newHome() {
  home = await mkdtemp(join(tmpdir(), 'rushdb-hooks-home-'))
  return home
}

function baseEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.state'),
    ...extra
  }
}

function runBundle(command: Command, host: Host, stdin: unknown, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolvePromise) => {
    const started = Date.now()
    const child = spawn(process.execPath, [script, command, '--host', host], { env, cwd: home })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr, ms: Date.now() - started }))
    child.stdin.end(stdin === undefined ? '' : JSON.stringify(stdin))
  })
}

const outboxDir = () => join(home, '.state', 'rushdb', 'outbox')
const pending = async () =>
  (await readdir(outboxDir()).catch(() => [])).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))

describe('bundle', () => {
  it('is under 256 KiB and not minified', () => {
    const size = Buffer.byteLength(bundle)
    expect(size).toBeLessThan(HOOK_BUNDLE_LIMIT)
    expect(bundle.split('\n').length).toBeGreaterThan(1000)
    expect(bundle).toContain('async function runHook(')
    expect(bundle).toMatch(/^\/\/ rushdb-hooks\.mjs/)
  })
})

describe('automatic context off', () => {
  const events: Array<[Host, string, Command, string]> = [
    ['claude', 'SessionStart', 'recall', ''],
    ['claude', 'Stop', 'capture', ''],
    ['claude', 'SessionEnd', 'end', ''],
    ['codex', 'Stop', 'capture', '{}'],
    ['codex', 'UserPromptSubmit', 'capture', ''],
    ['gemini', 'SessionStart', 'recall', '{}'],
    ['gemini', 'AfterAgent', 'capture', '{}']
  ]

  it('makes no network call and writes nothing, with a key set', async () => {
    server = await fakeRushDB('ok')
    await newHome()
    for (const [host, event, command, expected] of events) {
      const result = await runBundle(
        command,
        host,
        await fixture(host, event, { cwd: home }),
        baseEnv({ RUSHDB_API_KEY: 'test-key', RUSHDB_API_URL: server.url })
      )
      expect(result).toMatchObject({ code: 0, stdout: expected })
    }
    expect(server.requests).toEqual([])
    expect(await readdir(home)).toEqual([])
  })

  it('without a key (switch on) also exits 0 with the empty answer', async () => {
    await newHome()
    const result = await runBundle(
      'recall',
      'claude',
      await fixture('claude', 'SessionStart', { cwd: home }),
      baseEnv({ RUSHDB_AUTO_CONTEXT: 'recall+persist' })
    )
    expect(result).toMatchObject({ code: 0, stdout: '' })
  })

  it('a bad command line exits 0', async () => {
    await newHome()
    const result = await runBundle('nope' as Command, 'claude', {}, baseEnv({}))
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^usage:/)
  })
})

describe('network failures', () => {
  it('recall against an API that never answers exits 0 within its timeout and logs it', async () => {
    server = await fakeRushDB('hang')
    await newHome()
    const result = await runBundle(
      'recall',
      'gemini',
      await fixture('gemini', 'SessionStart', { cwd: home }),
      baseEnv({ RUSHDB_AUTO_CONTEXT: 'recall', RUSHDB_API_KEY: 'test-key', RUSHDB_API_URL: server.url })
    )
    expect(result).toMatchObject({ code: 0, stdout: '{}' })
    expect(result.ms).toBeLessThan(3000)
    expect(await readFile(join(home, '.state', 'rushdb', 'hooks.log'), 'utf8')).toMatch(/recall timed out/)
  })

  it('recall against a closed port logs the failed search', async () => {
    await newHome()
    const result = await runBundle(
      'recall',
      'claude',
      await fixture('claude', 'SessionStart', { cwd: home }),
      baseEnv({
        RUSHDB_AUTO_CONTEXT: 'recall',
        RUSHDB_API_KEY: 'test-key',
        RUSHDB_API_URL: 'http://127.0.0.1:9/api/v1'
      })
    )
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(await readFile(join(home, '.state', 'rushdb', 'hooks.log'), 'utf8')).toMatch(/recall search failed/)
  })

  it('end returns in under 300 ms with a slow API and a full outbox', async () => {
    server = await fakeRushDB('hang')
    await newHome()
    const env = baseEnv({
      RUSHDB_AUTO_CONTEXT: 'recall+persist',
      RUSHDB_API_KEY: 'test-key',
      RUSHDB_API_URL: server.url
    })
    await runBundle('capture', 'gemini', await fixture('gemini', 'AfterAgent', { cwd: home }), env)
    const result = await runBundle('end', 'codex', await fixture('codex', 'SessionEnd', { cwd: home }), env)
    expect(result).toMatchObject({ code: 0, stdout: '' })
    // Node's own start-up is part of the measured time.
    expect(result.ms).toBeLessThan(300)
  })
})

describe('detached flush', () => {
  it('finishes after the hook that started it has exited', async () => {
    server = await fakeRushDB('ok')
    await newHome()
    const env = baseEnv({
      RUSHDB_AUTO_CONTEXT: 'recall+persist',
      RUSHDB_API_KEY: 'test-key',
      RUSHDB_API_URL: server.url
    })
    await mkdir(join(home, '.state', 'rushdb', 'outbox'), { recursive: true })
    // The Stop hook writes the episode, starts the flush and exits straight away.
    const result = await runBundle('capture', 'claude', await fixture('claude', 'Stop', { cwd: home }), env)
    expect(result).toMatchObject({ code: 0, stdout: '' })
    await vi.waitFor(
      async () => {
        expect(await pending()).toEqual([])
        expect(server!.requests.some((request) => request.body.includes('pnpm workspaces'))).toBe(true)
      },
      { timeout: 10_000, interval: 100 }
    )
  })
})
