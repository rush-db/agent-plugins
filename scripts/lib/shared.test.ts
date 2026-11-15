import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareTags,
  loadShared,
  stdioLaunch,
  validateListing,
  validateMcp,
  validateSkillsPin,
  type Listing,
  type McpConfig,
  type SkillsPin
} from './shared.ts'

const repoRoot = resolve(import.meta.dirname, '../..')

async function readShared<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(repoRoot, 'shared', name), 'utf8')) as T
}

describe('the committed shared sources', () => {
  it('load and validate', async () => {
    const shared = await loadShared(repoRoot)
    expect(shared.listing.name).toBe('rushdb')
    expect(shared.mcp.hosted.url).toBe('https://mcp.rushdb.com/mcp')
  })

  it('pin the stdio server to an exact version', async () => {
    const mcp = await readShared<McpConfig>('mcp.json')
    expect(stdioLaunch(mcp)).toEqual({ command: 'npx', args: ['-y', `@rushdb/mcp-server@${mcp.stdio.version}`] })
  })

  it('ship the four skills from decision D4', async () => {
    const pin = await readShared<SkillsPin>('skills.json')
    expect(pin.skills).toEqual([
      'rushdb-query-builder',
      'rushdb-data-modeling',
      'rushdb-faceted-search',
      'rushdb-agent-memory'
    ])
  })
})

describe('validateListing', () => {
  it('enforces listing length limits', async () => {
    const listing = await readShared<Listing>('listing.json')
    expect(validateListing({ ...listing, tagline: 'x'.repeat(31) })).toEqual([
      'tagline is 31 characters; the limit is 30'
    ])
    expect(validateListing({ ...listing, description: 'x'.repeat(201) })).toEqual([
      'description is 201 characters; the limit is 200'
    ])
  })

  it('keeps memory out of names', async () => {
    const listing = await readShared<Listing>('listing.json')
    expect(validateListing({ ...listing, displayName: 'RushDB Memory' })).toEqual([
      'displayName must not mention memory'
    ])
  })

  it('allows a null privacy policy until it is decided, but not a non-https URL', async () => {
    const listing = await readShared<Listing>('listing.json')
    expect(validateListing({ ...listing, urls: { ...listing.urls, privacyPolicy: null } })).toEqual([])
    expect(validateListing({ ...listing, urls: { ...listing.urls, privacyPolicy: 'http://example.com' } })).toEqual([
      'urls.privacyPolicy must be an https URL or null'
    ])
  })
})

describe('validateMcp', () => {
  it('rejects a version range and a sensitive default', async () => {
    const mcp = await readShared<McpConfig>('mcp.json')
    const env = { ...mcp.stdio.env, RUSHDB_API_KEY: { ...mcp.stdio.env.RUSHDB_API_KEY, default: 'x' } }
    expect(validateMcp({ ...mcp, stdio: { ...mcp.stdio, version: '^3.4.1', env } })).toEqual([
      'stdio.version must be an exact x.y.z version',
      'stdio.env.RUSHDB_API_KEY is sensitive and has a default'
    ])
  })
})

describe('validateSkillsPin', () => {
  const pin: SkillsPin = { repository: 'https://github.com/rush-db/skills.git', tag: 'v3.0.4', skills: ['rushdb-a'] }

  it('accepts v3.0.4 and later', () => {
    expect(validateSkillsPin(pin)).toEqual([])
    expect(validateSkillsPin({ ...pin, tag: 'v3.1.0' })).toEqual([])
  })

  it('rejects tags before v3.0.4 and duplicate skills', () => {
    expect(validateSkillsPin({ ...pin, tag: 'v3.0.3', skills: ['rushdb-a', 'rushdb-a'] })).toEqual([
      'tag must be v3.0.4 or later',
      'skills must be unique'
    ])
  })

  it('compares tags numerically', () => {
    expect(compareTags('v3.0.10', 'v3.0.4')).toBe(1)
    expect(compareTags('v3.0.4', 'v3.0.4')).toBe(0)
    expect(compareTags('v2.9.9', 'v3.0.0')).toBe(-1)
  })
})

describe('loadShared', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('lists every problem with its file', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-plugins-shared-'))
    await cp(join(repoRoot, 'shared'), join(root, 'shared'), { recursive: true })
    const pin = await readShared<SkillsPin>('skills.json')
    await writeFile(join(root, 'shared/skills.json'), JSON.stringify({ ...pin, tag: 'main' }))
    await expect(loadShared(root)).rejects.toThrow('shared/skills.json: tag must look like vX.Y.Z')
  })
})
