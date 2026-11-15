import { spawn } from 'node:child_process'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeRushDB, fixture, type FakeRushDB } from '../../packages/hooks/test/helpers.ts'
import { loadOpenAIReview } from '../lib/openai.ts'
import { loadShared } from '../lib/shared.ts'
import {
  ADDITIONAL_CONTEXT_LIMIT,
  CODEX_HOOKS,
  CODEX_MANIFEST,
  CODEX_MARKETPLACE,
  CODEX_MCP,
  CODEX_PLUGIN_DIR,
  codexHooks,
  codexPlugin,
  openaiDirectoryFiles
} from './codex.ts'

const root = resolve(import.meta.dirname, '../..')
const shared = await loadShared(root)
const review = await loadOpenAIReview(root)
const files = await codexPlugin(shared, root)
const text = (path: string) => String(files.find((item) => item.path === path)?.content)
const pluginJson = (path: string) => JSON.parse(text(`${CODEX_PLUGIN_DIR}/${path}`))
const manifest = pluginJson(CODEX_MANIFEST)

describe('codex marketplace', () => {
  it('lists the compatibility-layout folder with policy and category', () => {
    expect(JSON.parse(text(CODEX_MARKETPLACE))).toEqual({
      name: 'rushdb',
      interface: { displayName: 'RushDB' },
      plugins: [
        {
          name: 'rushdb',
          source: { source: 'local', path: './plugins/codex/rushdb' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: review.category
        }
      ]
    })
  })
})

describe('codex plugin folder', () => {
  it('uses the Codex compatibility layout only: a portable plugin.json makes Codex skip the hooks', () => {
    const paths = files.map((file) => file.path)
    expect(paths).toContain(`${CODEX_PLUGIN_DIR}/${CODEX_MANIFEST}`)
    expect(paths).toContain(`${CODEX_PLUGIN_DIR}/${CODEX_MCP}`)
    expect(paths).not.toContain(`${CODEX_PLUGIN_DIR}/plugin.json`)
    expect(paths).not.toContain(`${CODEX_PLUGIN_DIR}/mcp.json`)
  })

  it('declares components, interface and the onboarding skill', () => {
    expect(manifest).toMatchObject({
      name: 'rushdb',
      skills: './skills/',
      mcpServers: './.mcp.json',
      hooks: './hooks/hooks.json',
      interface: {
        displayName: 'RushDB',
        shortDescription: shared.listing.tagline,
        longDescription: shared.listing.longDescription,
        composerIcon: './assets/icon.png',
        logo: './assets/logo.png'
      },
      extensions: { 'com.openai': { onboardingSkill: './skills/rushdb-setup/SKILL.md' } }
    })
    expect(manifest).not.toHaveProperty('$schema')
  })

  it('connects only the hosted MCP server, with no headers or key', () => {
    expect(pluginJson(CODEX_MCP)).toEqual({ mcpServers: { rushdb: { url: 'https://mcp.rushdb.com/mcp' } } })
  })

  it('ships the setup skill rendered, and it never asks for the key in chat', () => {
    const skill = text(`${CODEX_PLUGIN_DIR}/skills/rushdb-setup/SKILL.md`)
    expect(skill).toMatch(/^---\nname: rushdb-setup\ndescription: /)
    expect(skill).not.toMatch(/\{\{\w+\}\}/)
    expect(skill).toContain('Never ask for a RushDB API key in the chat')
    expect(skill).toContain('codex mcp login rushdb')
    expect(text(`${CODEX_PLUGIN_DIR}/README.md`)).not.toMatch(/\{\{\w+\}\}/)
  })

  it('names no memory in the plugin or its display name', () => {
    expect(`${manifest.name} ${manifest.interface.displayName}`).not.toMatch(/memory/i)
  })
})

describe('codex hooks.json', () => {
  const { hooks } = codexHooks()
  const handler = (event: keyof typeof hooks) => hooks[event][0]!.hooks[0]!

  it('runs the bundle from PLUGIN_ROOT with --host codex', () => {
    for (const event of Object.keys(hooks) as Array<keyof typeof hooks>) {
      expect(handler(event).command).toMatch(/^node "\$\{PLUGIN_ROOT\}\/hooks\/rushdb-hooks\.mjs" \w+ --host codex$/)
    }
    expect(JSON.parse(text(`${CODEX_PLUGIN_DIR}/${CODEX_HOOKS}`))).toEqual(codexHooks())
  })

  it('recalls on startup, resume and compaction with a 4,000-token context limit', () => {
    expect(hooks.SessionStart[0]!.matcher).toBe('startup|resume|compact')
    expect(handler('SessionStart')).toMatchObject({ timeout: 10, additionalContextLimit: ADDITIONAL_CONTEXT_LIMIT })
  })

  it('captures synchronously (Codex cancels background hooks at session end) within 5 s', () => {
    for (const event of ['UserPromptSubmit', 'Stop'] as const) {
      expect(handler(event)).toMatchObject({ timeout: 5 })
      expect(handler(event)).not.toHaveProperty('async')
    }
  })

  it('keeps SessionEnd inside its 1 s budget and PreCompact at 30 s', () => {
    expect(handler('SessionEnd')).toMatchObject({ timeout: 1 })
    expect(handler('PreCompact')).toMatchObject({ timeout: 30 })
  })
})

describe('openai directory files', () => {
  it('are portable and hooks-free, with review cases and no onboarding skill', async () => {
    const directory = await openaiDirectoryFiles(shared, root)
    const paths = directory.map((file) => file.path)
    expect(paths).toEqual(expect.arrayContaining(['plugin.json', 'mcp.json', 'assets/logo.png', 'LICENSE']))
    expect(paths.some((path) => path.startsWith('hooks') || path.startsWith('.codex-plugin'))).toBe(false)
    expect(paths.some((path) => path.includes('rushdb-setup'))).toBe(false)
    const plugin = JSON.parse(String(directory.find((file) => file.path === 'plugin.json')!.content))
    const openai = plugin.extensions['com.openai']
    expect(Object.keys(openai)).toEqual(['interface', 'review', 'publication'])
    expect(openai.interface.longDescription).toBe(review.directoryLongDescription)
    expect(openai.review.test_cases.positive).toHaveLength(5)
    expect(openai.review.test_cases.negative).toHaveLength(3)
    expect(openai.review).not.toHaveProperty('demo_recording_url')
  })
})

describe('codex hooks.json commands run through the shell', () => {
  let server: FakeRushDB | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /**
   * Runs every generated hooks.json command through `sh -c`, as Codex does, against the committed bundle (`pnpm build
   * --check` keeps it equal to the sources), with a key and the fake API URL in the env.
   */
  async function runAllHooks(extraEnv: NodeJS.ProcessEnv) {
    server = await fakeRushDB('ok')
    const home = await mkdtemp(join(tmpdir(), 'rushdb-codex-home-'))
    const data = await mkdtemp(join(tmpdir(), 'rushdb-codex-data-'))
    const outputs: Record<string, { code: number | null; stdout: string }> = {}
    for (const [event, groups] of Object.entries(codexHooks().hooks)) {
      const stdin = await fixture('codex', event, { cwd: home })
      outputs[event] = await new Promise((done) => {
        const child = spawn('sh', ['-c', groups[0]!.hooks[0]!.command], {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_STATE_HOME: join(home, '.state'),
            PLUGIN_ROOT: join(root, CODEX_PLUGIN_DIR),
            PLUGIN_DATA: data,
            CLAUDE_PLUGIN_ROOT: join(root, CODEX_PLUGIN_DIR),
            CLAUDE_PLUGIN_DATA: data,
            RUSHDB_API_KEY: 'test-key',
            RUSHDB_API_URL: server!.url,
            ...extraEnv
          }
        })
        let stdout = ''
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.on('close', (code) => done({ code, stdout }))
        child.stdin.end(JSON.stringify(stdin))
      })
    }
    return { home, data, outputs }
  }

  it('with automatic context off (the default) send no request and write no file for any event', async () => {
    const { home, data, outputs } = await runAllHooks({})
    for (const [event, result] of Object.entries(outputs)) {
      expect(result, event).toEqual({ code: 0, stdout: event === 'Stop' ? '{}' : '' })
    }
    expect(server!.requests).toEqual([])
    expect(await readdir(data)).toEqual([])
    expect(await readdir(home)).toEqual([])
  }, 30_000)

  it('with recall+persist do reach the API and the plugin data folder (the check above is not vacuous)', async () => {
    const { data, outputs } = await runAllHooks({ RUSHDB_AUTO_CONTEXT: 'recall+persist' })
    for (const [event, result] of Object.entries(outputs)) expect(result.code, event).toBe(0)
    expect(outputs.Stop!.stdout).toBe('{}')
    expect(server!.requests.length).toBeGreaterThan(0)
    expect(await readdir(data)).toEqual(expect.arrayContaining(['sessions']))
  }, 30_000)
})
