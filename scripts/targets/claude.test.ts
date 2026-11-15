import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles } from '../lib/files.ts'
import { loadShared } from '../lib/shared.ts'
import {
  CLAUDE_MARKETPLACE,
  CLAUDE_PLUGIN_DIR,
  claudeHooks,
  claudePlugin,
  claudePluginManifest,
  githubRepo,
  renderTemplate
} from './claude.ts'

const root = resolve(import.meta.dirname, '../..')
const shared = await loadShared(root)
const files = await claudePlugin(shared, root)
const file = (path: string) => files.find((item) => item.path === path)?.content
const text = (path: string) => String(file(path))
const manifest = JSON.parse(text(`${CLAUDE_PLUGIN_DIR}/.claude-plugin/plugin.json`))

describe('claude plugin.json', () => {
  it('takes its listing from shared/ and its version from the root package', async () => {
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(manifest).toMatchObject({
      name: 'rushdb',
      displayName: 'RushDB',
      version,
      license: 'Apache-2.0',
      description: shared.listing.description
    })
    expect(manifest).toEqual(claudePluginManifest(shared, version))
  })

  it('connects only the hosted MCP server, with no key or npx (D2)', () => {
    expect(manifest.mcpServers).toEqual({ rushdb: { type: 'http', url: 'https://mcp.rushdb.com/mcp' } })
  })

  it('keeps the key optional and sensitive, and automatic context off by default (D1)', () => {
    const { userConfig } = manifest
    expect(Object.keys(userConfig)).toEqual(['api_key', 'api_url', 'auto_context', 'context_scope'])
    expect(userConfig.api_key).toMatchObject({ sensitive: true, required: false })
    expect(userConfig.api_key.default).toBeUndefined()
    expect(userConfig.auto_context).toMatchObject({ options: ['off', 'recall', 'recall+persist'], default: 'off' })
    for (const option of Object.values<Record<string, unknown>>(userConfig)) {
      expect(option).toMatchObject({ type: 'string', title: expect.any(String), description: expect.any(String) })
    }
  })

  it('sets privacyPolicyUrl only once shared/listing.json has one (D6)', () => {
    const withUrl = { ...shared, listing: { ...shared.listing, urls: { ...shared.listing.urls } } }
    withUrl.listing.urls.privacyPolicy = 'https://rushdb.com/privacy'
    expect(claudePluginManifest(withUrl, '0.1.0').privacyPolicyUrl).toBe('https://rushdb.com/privacy')
    if (shared.listing.urls.privacyPolicy === null) expect(manifest).not.toHaveProperty('privacyPolicyUrl')
  })
})

describe('claude hooks.json', () => {
  const { hooks } = claudeHooks()
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks))

  it('runs the bundle from the plugin root with no other variables', () => {
    for (const hook of commands) {
      expect(hook.command).toMatch(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/rushdb-hooks\.mjs" \w+ --host claude$/)
    }
  })

  it('maps each event to its command and timing', () => {
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd'])
    expect(hooks.SessionStart[0]).toMatchObject({ matcher: 'startup|resume|clear|compact' })
    expect(hooks.SessionStart[0]!.hooks[0]).toMatchObject({ command: expect.stringContaining(' recall '), timeout: 10 })
    expect(hooks.Stop[0]!.hooks[0]).toMatchObject({ command: expect.stringContaining(' capture '), async: true })
    expect(hooks.PreCompact[0]!.hooks[0]).toMatchObject({
      command: expect.stringContaining(' precompact '),
      timeout: 30
    })
    expect(hooks.PostCompact[0]!.hooks[0]!.command).toContain(' postcompact ')
    expect(hooks.SessionEnd[0]!.hooks[0]!.command).toContain(' end ')
  })
})

describe('claude marketplace', () => {
  it('lists the plugin folder by relative path under the same name', () => {
    expect(JSON.parse(text(CLAUDE_MARKETPLACE))).toMatchObject({
      name: 'rushdb',
      owner: { name: 'RushDB' },
      plugins: [{ name: 'rushdb', source: `./${CLAUDE_PLUGIN_DIR}` }]
    })
  })
})

describe('claude plugin folder', () => {
  it('copies every synced skill file byte for byte', async () => {
    for (const path of await listFiles(join(root, 'skills'))) {
      expect(file(`${CLAUDE_PLUGIN_DIR}/skills/${path}`)).toEqual(await readFile(join(root, 'skills', path)))
    }
  })

  it('ships a README of at least 40 words with the install line and the data section', () => {
    const readme = text(`${CLAUDE_PLUGIN_DIR}/README.md`)
    const prose = readme.replace(/```[\s\S]*?```/g, '')
    expect(prose.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40)
    expect(readme).toContain('/plugin install rushdb --marketplace rush-db/agent-plugins')
    expect(readme).toContain('## What leaves your machine')
    expect(readme).toContain('npx -y @rushdb/mcp-server@3.4.1')
    expect(readme).not.toMatch(/\{\{\w+\}\}/)
  })

  it('ships LICENSE and a square PNG icon between 512 and 2048 px', () => {
    expect(text(`${CLAUDE_PLUGIN_DIR}/LICENSE`)).toContain('Apache License')
    const icon = file(`${CLAUDE_PLUGIN_DIR}/${manifest.icon.slice(2)}`) as Buffer
    expect(icon.subarray(1, 4).toString('latin1')).toBe('PNG')
    const width = icon.readUInt32BE(16)
    const height = icon.readUInt32BE(20)
    expect(width).toBe(height)
    expect(width).toBeGreaterThanOrEqual(512)
    expect(width).toBeLessThanOrEqual(2048)
  })
})

describe('renderTemplate', () => {
  it('fills placeholders and throws on an unknown one', () => {
    expect(renderTemplate('{{a}} and {{b}}', { a: '1', b: '2' })).toBe('1 and 2')
    expect(() => renderTemplate('{{missing}}', {})).toThrow('{{missing}}')
  })
})

describe('githubRepo', () => {
  it('reads owner/repo from a GitHub URL', () => {
    expect(githubRepo('https://github.com/rush-db/agent-plugins')).toBe('rush-db/agent-plugins')
    expect(githubRepo('https://github.com/rush-db/agent-plugins.git')).toBe('rush-db/agent-plugins')
    expect(() => githubRepo('https://gitlab.com/rush-db/agent-plugins/x')).toThrow()
  })
})
