import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { configFilePath, persistsContext, readConfigFile, resolveConfig, resolveStateDir } from './config.ts'

const home = '/home/test'

function enabled(env: NodeJS.ProcessEnv, file: Record<string, unknown> = {}) {
  const config = resolveConfig({ env, homeDir: home, readConfigFile: () => file })
  if (config.status !== 'enabled') throw new Error(`expected enabled, got ${config.status}`)
  return config
}

describe('resolveConfig: automatic-context switch', () => {
  it('is off by default', () => {
    const config = resolveConfig({ env: { RUSHDB_API_KEY: 'key' }, homeDir: home, readConfigFile: () => undefined })
    expect(config.status).toBe('off')
  })

  it('reads nothing else when the env turns it off', () => {
    const readConfigFile = vi.fn(() => ({ autoContext: 'recall+persist', apiKey: 'file-key' }))
    const config = resolveConfig({
      env: { CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT: 'off', RUSHDB_AUTO_CONTEXT: 'recall', RUSHDB_API_KEY: 'key' },
      homeDir: home,
      readConfigFile
    })
    expect(config.status).toBe('off')
    expect(readConfigFile).not.toHaveBeenCalled()
  })

  it('prefers the plugin option, then RUSHDB_AUTO_CONTEXT, then the config file', () => {
    expect(
      enabled({ CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT: 'recall', RUSHDB_AUTO_CONTEXT: 'off', RUSHDB_API_KEY: 'k' })
        .autoContext
    ).toBe('recall')
    expect(enabled({ RUSHDB_AUTO_CONTEXT: 'recall+persist', RUSHDB_API_KEY: 'k' }).autoContext).toBe('recall+persist')
    expect(enabled({ RUSHDB_API_KEY: 'k' }, { autoContext: 'recall' }).autoContext).toBe('recall')
  })

  it('treats an unknown value as off and reports it', () => {
    const config = resolveConfig({ env: { RUSHDB_AUTO_CONTEXT: 'always', RUSHDB_API_KEY: 'k' }, homeDir: home })
    expect(config.status).toBe('off')
    expect(config.warnings[0]).toMatch(/not one of off, recall, recall\+persist/)
  })

  it('ignores an unexpanded placeholder in the switch', () => {
    const config = resolveConfig({
      env: { CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT: '${user_config.auto_context}', RUSHDB_API_KEY: 'k' },
      homeDir: home,
      readConfigFile: () => ({ autoContext: 'recall' })
    })
    expect(config.autoContext).toBe('recall')
  })

  it('persists only with recall+persist', () => {
    expect(persistsContext(enabled({ RUSHDB_AUTO_CONTEXT: 'recall', RUSHDB_API_KEY: 'k' }))).toBe(false)
    expect(persistsContext(enabled({ RUSHDB_AUTO_CONTEXT: 'recall+persist', RUSHDB_API_KEY: 'k' }))).toBe(true)
  })
})

describe('resolveConfig: key and target', () => {
  const on = { RUSHDB_AUTO_CONTEXT: 'recall' }

  it('takes the plugin option before RUSHDB_API_KEY before the config file', () => {
    const file = { apiKey: 'file-key' }
    expect(
      enabled({ ...on, CLAUDE_PLUGIN_OPTION_API_KEY: 'option-key', RUSHDB_API_KEY: 'env-key' }, file).connection.apiKey
    ).toBe('option-key')
    expect(enabled({ ...on, RUSHDB_API_KEY: 'env-key' }, file).connection.apiKey).toBe('env-key')
    expect(enabled(on, file).connection.apiKey).toBe('file-key')
  })

  it('skips a literal ${user_config.api_key} and falls through', () => {
    const literal = '${user_config.api_key}'
    expect(enabled({ ...on, CLAUDE_PLUGIN_OPTION_API_KEY: literal, RUSHDB_API_KEY: 'env-key' }).connection.apiKey).toBe(
      'env-key'
    )
    expect(enabled({ ...on, RUSHDB_API_KEY: literal }, { apiKey: 'file-key' }).connection.apiKey).toBe('file-key')
  })

  it('is disabled without a key', () => {
    const config = resolveConfig({ env: { ...on, RUSHDB_API_KEY: '${user_config.api_key}' }, homeDir: home })
    expect(config.status).toBe('disabled')
  })

  it('uses RUSHDB_API_URL, defaulting to the SDK (Cloud)', () => {
    expect(enabled({ ...on, RUSHDB_API_KEY: 'k' }).connection.url).toBeUndefined()
    expect(
      enabled({ ...on, RUSHDB_API_KEY: 'k', RUSHDB_API_URL: 'https://db.example.com/api/v1' }).connection.url
    ).toBe('https://db.example.com/api/v1')
  })

  it('reaches a standalone engine in direct mode, with an embedding provider', () => {
    const engine = { ...on, RUSHDB_ENGINE_URL: 'http://127.0.0.1:3000', RUSHDB_ENGINE_TOKEN: 'token' }
    expect(resolveConfig({ env: engine, homeDir: home, readConfigFile: () => undefined }).status).toBe('disabled')
    const config = enabled({
      ...engine,
      RUSHDB_EMBEDDING_API_KEY: 'embed-key',
      RUSHDB_EMBEDDING_MODEL: 'text-embedding-3-small',
      RUSHDB_EMBEDDING_DIMENSIONS: '256'
    })
    expect(config.connection).toMatchObject({ engineUrl: 'http://127.0.0.1:3000', engineToken: 'token' })
    expect(config.connection.embedder?.dimensions).toBe(256)
    expect(config.secrets).toEqual(['token', 'embed-key'])
  })

  it('takes the context scope from the plugin option, the env or the file', () => {
    expect(enabled({ ...on, RUSHDB_API_KEY: 'k', RUSHDB_CONTEXT_SCOPE: 'team-a' }).contextScope).toBe('team-a')
    expect(enabled({ ...on, RUSHDB_API_KEY: 'k' }, { contextScope: 'file-scope' }).contextScope).toBe('file-scope')
  })
})

describe('paths', () => {
  it('orders the state directory CLAUDE_PLUGIN_DATA, PLUGIN_DATA, XDG_STATE_HOME', () => {
    expect(resolveStateDir({ CLAUDE_PLUGIN_DATA: '/a', PLUGIN_DATA: '/b' }, home)).toBe('/a')
    expect(resolveStateDir({ PLUGIN_DATA: '/b' }, home)).toBe('/b')
    expect(resolveStateDir({ XDG_STATE_HOME: '/x' }, home)).toBe('/x/rushdb')
    expect(resolveStateDir({}, home)).toBe('/home/test/.local/state/rushdb')
  })

  it('finds the config file under XDG_CONFIG_HOME', () => {
    expect(configFilePath({ XDG_CONFIG_HOME: '/x' }, home)).toBe('/x/rushdb/config.json')
    expect(configFilePath({}, home)).toBe('/home/test/.config/rushdb/config.json')
  })

  it('reads the config file and warns when others can read it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rushdb-core-config-'))
    const path = join(directory, 'rushdb', 'config.json')
    await mkdir(join(directory, 'rushdb'))
    await writeFile(path, JSON.stringify({ api_key: 'file-key', autoContext: 'recall' }))
    await chmod(path, 0o644)
    const warnings: string[] = []
    expect(readConfigFile(path, warnings)).toMatchObject({ apiKey: 'file-key', autoContext: 'recall' })
    expect(warnings[0]).toMatch(/chmod 600/)

    const config = resolveConfig({ env: { XDG_CONFIG_HOME: directory }, homeDir: home })
    expect(config.status).toBe('enabled')

    await writeFile(path, 'not json')
    await chmod(path, 0o600)
    const more: string[] = []
    expect(readConfigFile(path, more)).toBeUndefined()
    expect(more[0]).toMatch(/not a JSON object/)
  })
})
