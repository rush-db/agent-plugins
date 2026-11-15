import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Listing {
  name: string
  displayName: string
  fallbackName: string
  fallbackDisplayName: string
  /** OpenAI `shortDescription` limit: 30 characters. */
  tagline: string
  /** Claude directory one-liner limit: 200 characters. */
  description: string
  /** OpenAI `longDescription` limit: 4,000 characters; Claude directory description: 2,000. */
  longDescription: string
  keywords: string[]
  author: { name: string; url: string }
  license: string
  urls: {
    homepage: string
    docs: string
    repository: string
    support: string
    /** Null until the owner decides D6. */
    privacyPolicy: string | null
    termsOfService: string | null
  }
}

export interface McpEnvVar {
  description: string
  required: boolean
  sensitive: boolean
  default?: string
}

export interface McpConfig {
  serverName: string
  hosted: { type: 'http'; url: string }
  stdio: { package: string; version: string; env: Record<string, McpEnvVar> }
}

export interface SkillsPin {
  repository: string
  tag: string
  skills: string[]
  /**
   * Temporary: the full commit to sync while `tag` is not released yet.
   * Remove it and resync once the tag exists.
   */
  pendingCommit?: string
}

export interface Shared {
  listing: Listing
  mcp: McpConfig
  skills: SkillsPin
}

/** Lowest `rush-db/skills` tag the packages may ship (plan decision D4). */
export const MIN_SKILLS_TAG = 'v3.0.4'

const NAME = /^[a-z][a-z0-9-]*$/
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isHttpsUrl(value: unknown): boolean {
  if (!isString(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function checkLength(errors: string[], field: string, value: unknown, max: number): void {
  if (!isString(value)) errors.push(`${field} must be a non-empty string`)
  else if (value.length > max) errors.push(`${field} is ${value.length} characters; the limit is ${max}`)
}

/** -1, 0 or 1 for two `vX.Y.Z` tags. */
export function compareTags(a: string, b: string): number {
  const left = TAG.exec(a)
  const right = TAG.exec(b)
  if (!left || !right) throw new Error(`Not a vX.Y.Z tag: ${left ? b : a}`)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

export function validateListing(listing: Listing): string[] {
  const errors: string[] = []
  for (const field of ['name', 'fallbackName'] as const) {
    if (!isString(listing[field]) || !NAME.test(listing[field])) errors.push(`${field} must be lowercase kebab-case`)
  }
  for (const field of ['displayName', 'fallbackDisplayName'] as const) {
    if (!isString(listing[field])) errors.push(`${field} must be a non-empty string`)
  }
  checkLength(errors, 'tagline', listing.tagline, 30)
  checkLength(errors, 'description', listing.description, 200)
  checkLength(errors, 'longDescription', listing.longDescription, 2000)
  if (!Array.isArray(listing.keywords) || listing.keywords.length === 0) {
    errors.push('keywords must be a non-empty array')
  } else {
    for (const keyword of listing.keywords) {
      if (!isString(keyword) || !NAME.test(keyword))
        errors.push(`keyword ${JSON.stringify(keyword)} must be kebab-case`)
    }
    if (new Set(listing.keywords).size !== listing.keywords.length) errors.push('keywords must be unique')
  }
  // Positioning: RushDB stays use-case agnostic, so names never say "memory".
  for (const field of ['name', 'displayName', 'fallbackName', 'fallbackDisplayName'] as const) {
    if (isString(listing[field]) && /memory/i.test(listing[field])) errors.push(`${field} must not mention memory`)
  }
  if (!isString(listing.author?.name)) errors.push('author.name must be a non-empty string')
  if (!isHttpsUrl(listing.author?.url)) errors.push('author.url must be an https URL')
  if (listing.license !== 'Apache-2.0') errors.push('license must be Apache-2.0')
  for (const field of ['homepage', 'docs', 'repository', 'support'] as const) {
    if (!isHttpsUrl(listing.urls?.[field])) errors.push(`urls.${field} must be an https URL`)
  }
  for (const field of ['privacyPolicy', 'termsOfService'] as const) {
    const value = listing.urls?.[field]
    if (value !== null && !isHttpsUrl(value)) errors.push(`urls.${field} must be an https URL or null`)
  }
  return errors
}

export function validateMcp(mcp: McpConfig): string[] {
  const errors: string[] = []
  if (!isString(mcp.serverName) || !NAME.test(mcp.serverName)) errors.push('serverName must be lowercase kebab-case')
  if (mcp.hosted?.type !== 'http') errors.push('hosted.type must be "http"')
  if (!isHttpsUrl(mcp.hosted?.url)) errors.push('hosted.url must be an https URL')
  if (!isString(mcp.stdio?.package)) errors.push('stdio.package must be a non-empty string')
  // Exact pin: directory reviewers and reproducible installs both need it.
  if (!isString(mcp.stdio?.version) || !EXACT_SEMVER.test(mcp.stdio.version)) {
    errors.push('stdio.version must be an exact x.y.z version')
  }
  const env = mcp.stdio?.env ?? {}
  if (!env.RUSHDB_API_KEY) errors.push('stdio.env must declare RUSHDB_API_KEY')
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) errors.push(`stdio.env key ${key} must be UPPER_SNAKE_CASE`)
    if (!isString(value.description)) errors.push(`stdio.env.${key}.description must be a non-empty string`)
    if (typeof value.required !== 'boolean') errors.push(`stdio.env.${key}.required must be a boolean`)
    if (typeof value.sensitive !== 'boolean') errors.push(`stdio.env.${key}.sensitive must be a boolean`)
    if (value.sensitive && value.default !== undefined) errors.push(`stdio.env.${key} is sensitive and has a default`)
  }
  return errors
}

export function validateSkillsPin(pin: SkillsPin): string[] {
  const errors: string[] = []
  if (!isString(pin.repository)) errors.push('repository must be a non-empty string')
  if (!isString(pin.tag) || !TAG.test(pin.tag)) errors.push('tag must look like vX.Y.Z')
  else if (compareTags(pin.tag, MIN_SKILLS_TAG) < 0) errors.push(`tag must be ${MIN_SKILLS_TAG} or later`)
  if (!Array.isArray(pin.skills) || pin.skills.length === 0) errors.push('skills must be a non-empty array')
  else {
    for (const skill of pin.skills) {
      if (!isString(skill) || !NAME.test(skill)) errors.push(`skill ${JSON.stringify(skill)} must be kebab-case`)
    }
    if (new Set(pin.skills).size !== pin.skills.length) errors.push('skills must be unique')
  }
  if (pin.pendingCommit !== undefined && !/^[0-9a-f]{40}$/.test(pin.pendingCommit)) {
    errors.push('pendingCommit must be a full 40-character commit hash')
  }
  return errors
}

/** The pinned stdio launch every stdio-based manifest uses. */
export function stdioLaunch(mcp: McpConfig): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', `${mcp.stdio.package}@${mcp.stdio.version}`] }
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Reads and validates `shared/*.json`. Throws with every problem listed. */
export async function loadShared(root: string): Promise<Shared> {
  const dir = join(root, 'shared')
  const shared: Shared = {
    listing: await readJson<Listing>(join(dir, 'listing.json')),
    mcp: await readJson<McpConfig>(join(dir, 'mcp.json')),
    skills: await readJson<SkillsPin>(join(dir, 'skills.json'))
  }
  const errors = [
    ...validateListing(shared.listing).map((error) => `shared/listing.json: ${error}`),
    ...validateMcp(shared.mcp).map((error) => `shared/mcp.json: ${error}`),
    ...validateSkillsPin(shared.skills).map((error) => `shared/skills.json: ${error}`)
  ]
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return shared
}
