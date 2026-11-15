import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadShared, type Shared } from '../lib/shared.ts'
import { agyHooks, agyManifest, agyMcpConfig, antigravityPlugin } from './antigravity.ts'

const repoRoot = resolve(import.meta.dirname, '../..')
let shared: Shared

beforeEach(async () => {
  shared = await loadShared(repoRoot)
})

describe('Antigravity plugin', () => {
  it('fills the Marketplace fields, with at most 3 suggested prompts', () => {
    const manifest = agyManifest(shared, '0.1.0')
    expect(manifest).toMatchObject({ name: 'rushdb', displayName: 'RushDB', version: '0.1.0', license: 'Apache-2.0' })
    expect(manifest.description.length).toBeGreaterThan(0)
    expect(manifest.suggestedPrompts.length).toBeLessThanOrEqual(3)
  })

  it('passes the key and the API URL through variables, naming the Cloud URL as the default', () => {
    const server = agyMcpConfig(shared).mcpServers.rushdb!
    expect(server).toMatchObject({
      command: 'npx',
      args: ['-y', '@rushdb/mcp-server@3.4.1'],
      env: { RUSHDB_API_KEY: '${RUSHDB_API_KEY}', RUSHDB_API_URL: '${RUSHDB_API_URL}' }
    })
    expect(server.variables.map((variable) => variable.name)).toEqual(['RUSHDB_API_KEY', 'RUSHDB_API_URL'])
    expect(server.variables[1]!.description).toContain('For RushDB Cloud use https://api.rushdb.com/api/v1')
    expect(JSON.stringify(server)).not.toContain(':-')
  })

  it('runs recall at session start from the root, with no capture hook yet', () => {
    expect(agyHooks(shared)).toEqual({
      'rushdb-context': {
        SessionStart: [{ type: 'command', command: 'node ./hooks/rushdb-hooks.mjs recall --host agy', timeout: 10 }]
      }
    })
  })

  it('writes an always-on rule with the agy way to set the key', async () => {
    const files = await antigravityPlugin(shared, repoRoot)
    expect(files.map((file) => file.path)).toEqual([
      '.antigravity-plugin/plugin.json',
      'mcp_config.json',
      'hooks.json',
      'rules/rushdb.md'
    ])
    const rule = files[3]!.content as string
    expect(rule).toMatch(/^---\ntrigger: always_on\n---\n\n<!-- GENERATED/)
    expect(rule).toContain('variable of the RushDB plugin in `/plugin` connects the MCP tools')
    expect(rule).toContain('the hooks only recall and never store turns')
    expect(rule).not.toContain('store finished turns themselves')
  })
})
