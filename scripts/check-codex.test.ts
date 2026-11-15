import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkCodex, checkCodexPlugin, validateCodexHooks, validateMarketplace } from './check-codex.ts'
import { CODEX_PLUGIN_DIR, codexHooks } from './targets/codex.ts'

const root = resolve(import.meta.dirname, '..')
const marketplace = JSON.parse(await readFile(join(root, '.agents/plugins/marketplace.json'), 'utf8'))

describe('check-codex', () => {
  it('passes on the committed marketplace and plugin', async () => {
    expect(await checkCodex(root)).toEqual([])
  })

  it('fails when a portable plugin.json sits next to .codex-plugin (Codex then skips the hooks)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rushdb-check-codex-'))
    await cp(join(root, CODEX_PLUGIN_DIR), dir, { recursive: true })
    await writeFile(join(dir, 'plugin.json'), '{}')
    expect(await checkCodexPlugin(dir, 'rushdb', 'copy')).toEqual([
      'copy: plugin.json must not exist: Codex then skips the plugin hooks'
    ])
  })

  it('fails on a missing referenced file and a name that differs from the marketplace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rushdb-check-codex-'))
    await cp(join(root, CODEX_PLUGIN_DIR), dir, { recursive: true })
    const manifestPath = join(dir, '.codex-plugin/plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.extensions['com.openai'].onboardingSkill = './skills/missing/SKILL.md'
    await writeFile(manifestPath, JSON.stringify(manifest))
    const errors = await checkCodexPlugin(dir, 'other', 'copy')
    expect(errors).toContain('copy/.codex-plugin/plugin.json: name must be "other", as in the marketplace')
    expect(errors).toContain(
      'copy/.codex-plugin/plugin.json: extensions.com.openai.onboardingSkill points at ./skills/missing/SKILL.md, which does not exist'
    )
  })
})

describe('validateMarketplace', () => {
  it('accepts the committed marketplace', () => {
    expect(validateMarketplace(marketplace)).toEqual({
      errors: [],
      entries: [{ name: 'rushdb', path: './plugins/codex/rushdb' }]
    })
  })

  it('requires policy and category, and ./ paths inside the root', () => {
    const entry = { name: 'rushdb', source: { source: 'local', path: '../outside' } }
    expect(validateMarketplace({ ...marketplace, plugins: [entry] }).errors).toEqual([
      'plugins[0].source.path must be a ./ path inside the marketplace root',
      'plugins[0].policy.installation must be one of AVAILABLE, INSTALLED_BY_DEFAULT, NOT_AVAILABLE',
      'plugins[0].policy.authentication must be one of ON_INSTALL, ON_USE',
      'plugins[0].category must be a non-empty string'
    ])
  })
})

describe('validateCodexHooks', () => {
  it('accepts the generated hooks', () => {
    expect(validateCodexHooks(codexHooks())).toEqual([])
  })

  it('rejects unknown events, a long or async SessionEnd, ignored matchers and other commands', () => {
    const command = 'node "${PLUGIN_ROOT}/hooks/rushdb-hooks.mjs" end --host codex'
    const errors = validateCodexHooks({
      hooks: {
        AfterAgent: [{ hooks: [{ type: 'command', command, timeout: 1 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 5, async: true }] }],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'python3 x.py', timeout: 1.5 }] }],
        PreCompact: [{ hooks: [{ type: 'command', command, timeout: 30, additionalContextLimit: 100 }] }]
      }
    })
    expect(errors).toEqual([
      'AfterAgent is not a Codex hook event',
      'SessionEnd[0].hooks[0].timeout can be at most 3 s for SessionEnd',
      'SessionEnd[0].hooks[0].async: SessionEnd always runs synchronously',
      'Stop[0].matcher is ignored by Codex for Stop',
      'Stop[0].hooks[0].command must run node "${PLUGIN_ROOT}/hooks/rushdb-hooks.mjs"',
      'Stop[0].hooks[0].timeout must be whole seconds',
      'PreCompact[0].hooks[0].additionalContextLimit has no effect on PreCompact'
    ])
  })
})
