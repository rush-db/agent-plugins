import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOpenAIZip, zipFiles } from './build-openai-zip.ts'
import { checkOpenAIPackage, readZip } from './check-openai.ts'
import { findCredentials, isPluginPath, validateReview, type OpenAIReview } from './lib/openai.ts'

const root = resolve(import.meta.dirname, '..')
const out = join(await mkdtemp(join(tmpdir(), 'rushdb-openai-zip-')), 'rushdb.zip')
await buildOpenAIZip(root, out)
const zip = await readFile(out)
const review = JSON.parse(await readFile(join(root, 'shared/openai-review.json'), 'utf8')) as OpenAIReview

/** The built ZIP's entries with `change` applied to plugin.json, plus extra files. */
function variant(change: (manifest: any) => void, extra: Record<string, string> = {}) {
  const entries = readZip(zip)
  const manifest = JSON.parse(entries.get('plugin.json')!.toString('utf8'))
  change(manifest)
  entries.set('plugin.json', Buffer.from(JSON.stringify(manifest)))
  for (const [path, content] of Object.entries(extra)) entries.set(path, Buffer.from(content))
  return entries
}

const check = (entries: Map<string, Buffer>) => checkOpenAIPackage(entries, { submission: false })

describe('the OpenAI directory ZIP', () => {
  it('passes, with only the owner-supplied items pending (D6 URLs, demo recording)', async () => {
    const result = await check(readZip(zip))
    expect(result.errors).toEqual([])
    expect(result.pending).toEqual([
      'interface.privacyPolicyURL is not set',
      'interface.termsOfServiceURL is not set',
      'review.demo_recording_url is not set'
    ])
    const submission = await checkOpenAIPackage(readZip(zip), { submission: true })
    expect(submission.errors).toHaveLength(3)
  })

  it('is byte-for-byte reproducible', async () => {
    const again = join(await mkdtemp(join(tmpdir(), 'rushdb-openai-zip-')), 'rushdb.zip')
    await buildOpenAIZip(root, again)
    expect((await readFile(again)).equals(zip)).toBe(true)
  })

  it('passes --submission once the URLs and the demo recording are set', async () => {
    const entries = variant((manifest) => {
      const openai = manifest.extensions['com.openai']
      openai.interface.privacyPolicyURL = 'https://rushdb.com/privacy'
      openai.interface.termsOfServiceURL = 'https://rushdb.com/terms'
      openai.review.demo_recording_url = 'https://rushdb.com/demo'
    })
    expect(await checkOpenAIPackage(entries, { submission: true })).toEqual({ errors: [], pending: [] })
  })

  it('fails on hooks, app references and a hooks key', async () => {
    const entries = variant((manifest) => (manifest.extensions['com.openai'].hooks = './hooks/hooks.json'), {
      'hooks/hooks.json': '{}',
      '.app.json': '{}'
    })
    expect((await check(entries)).errors).toEqual(
      expect.arrayContaining([
        'hooks/hooks.json: lifecycle hooks are not accepted',
        '.app.json: app references are not accepted',
        'plugin.json extensions.com.openai.hooks is not accepted'
      ])
    )
  })

  it('fails on MCP headers and an auth block', async () => {
    const entries = readZip(zip)
    entries.set(
      'mcp.json',
      Buffer.from(
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: {
            rushdb: { type: 'streamable-http', url: 'https://mcp.rushdb.com/mcp', headers: { 'X-Key': 'k' } }
          }
        })
      )
    )
    expect((await check(entries)).errors).toEqual(['mcp.json rushdb: headers must be empty'])
  })

  it('fails ajv on a key the portable schema does not allow', async () => {
    const entries = variant((manifest) => (manifest.interface = {}))
    expect((await check(entries)).errors).toEqual(['plugin.json/ must NOT have additional properties'])
  })

  it('fails on a wrong number of cases, a long subtitle and reviewer credentials', async () => {
    const entries = variant((manifest) => {
      const openai = manifest.extensions['com.openai']
      openai.review.test_cases.positive.pop()
      openai.interface.shortDescription = 'Query, search and analyze all of your data'
      openai.review.test_credentials = { username: 'reviewer' }
    })
    expect((await check(entries)).errors).toEqual(
      expect.arrayContaining([
        'plugin.json interface.shortDescription is 42 characters; the limit is 30',
        'review.test_cases.positive has 4 cases; OpenAI review needs exactly 5',
        'plugin.json $.extensions.com.openai.review.test_credentials: not allowed; enter reviewer access in the dashboard'
      ])
    )
  })
})

describe('shared/openai-review.json', () => {
  it('covers RAG, query and analytics with exactly 5 positive and 3 negative cases', () => {
    expect(validateReview(review)).toEqual([])
    const tools = review.review.test_cases.positive.map((item) => item.tools_triggered).join(', ')
    expect(tools).toMatch(/semanticSearch/)
    expect(tools).toMatch(/findRecords/)
    expect(review.review.test_cases.positive.map((item) => item.description.split(':')[0])).toEqual(
      expect.arrayContaining(['RAG', 'Query', 'Analytics'])
    )
  })
})

describe('findCredentials', () => {
  it('flags credential-looking text and forbidden keys, not ordinary text', () => {
    expect(findCredentials({ a: 'password: hunter2', b: 'Bearer abcdefghijklmnopqrstuvwxyz' })).toEqual([
      '$.a: looks like a credential',
      '$.b: looks like a credential'
    ])
    expect(findCredentials({ c: 'x'.repeat(40) })).toEqual(['$.c: looks like a credential'])
    expect(findCredentials({ reviewer_instructions: 'log in' })).toEqual([
      '$.reviewer_instructions: not allowed; enter reviewer access in the dashboard'
    ])
    expect(findCredentials({ url: 'https://mcp.rushdb.com/mcp', text: 'Use your API key from the dashboard' })).toEqual(
      []
    )
  })
})

describe('isPluginPath', () => {
  it('accepts ./ paths inside the plugin and nothing else', () => {
    expect(['./skills/', './assets/icon.png', './.mcp.json'].every(isPluginPath)).toBe(true)
    expect(['skills/', '../x', './a/../b', '/abs', './', './a//b'].some(isPluginPath)).toBe(false)
  })
})

describe('zipFiles', () => {
  it('rejects duplicate paths', () => {
    expect(() =>
      zipFiles([
        { path: 'a', content: '1' },
        { path: 'a', content: '2' }
      ])
    ).toThrow(/Two generators write a/)
  })
})
