import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Directory listing, review cases and release notes for OpenAI (plan O2). */
export const OPENAI_REVIEW = 'shared/openai-review.json'
export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const SCHEMAS_DIR = join(import.meta.dirname, '..', 'schemas', 'agent-plugins-1.0.0')

/** Public submission limits from developers.openai.com/plugins/deploy/submission. */
export const LIMITS = {
  displayName: 30,
  shortDescription: 30,
  longDescription: 4000,
  developerName: 80,
  capabilities: 20,
  capability: 120,
  defaultPrompts: 3,
  defaultPrompt: 128,
  url: 1024
}
/** Initial MCP review needs exactly this many cases. */
export const POSITIVE_CASES = 5
export const NEGATIVE_CASES = 3
/** ZIP metadata rejects these keys anywhere: reviewer access goes only into the dashboard form. */
export const FORBIDDEN_KEYS = ['test_credentials', 'reviewer_instructions']

export interface ReviewCase {
  description: string
  prompt: string
  tools_triggered?: string
  expected_behavior?: string
  file_attachment_urls?: string[]
  expected_output_url?: string
}

export interface OpenAIReview {
  /** Dashboard category title, shared by the directory listing and the Codex marketplace entry. */
  category: string
  capabilities: string[]
  /** `longDescription` of the hooks-free directory build; the marketplace build uses `listing.longDescription`. */
  directoryLongDescription: string
  review: {
    test_cases: { positive: ReviewCase[]; negative: ReviewCase[] }
    /** Filled in by the owner before submission; null leaves it out of the ZIP. */
    demo_recording_url: string | null
    commerce: boolean
    commerce_description: string
  }
  publication: { release_notes: string }
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function isHttpsUrl(value: unknown): boolean {
  if (!isString(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function checkLength(errors: string[], field: string, value: unknown, max: number): void {
  if (!isString(value)) errors.push(`${field} must be a non-empty string`)
  else if (value.length > max) errors.push(`${field} is ${value.length} characters; the limit is ${max}`)
}

/**
 * Strings that look like a credential: `password: …`, `api key = …`, a bearer token, or a long unbroken token.
 * Review cases and listing text are public, so none of these belong in them.
 */
const CREDENTIAL_PATTERNS = [
  /\b(?:password|passwd|secret|api[ _-]?key|access[ _-]?token|client[ _-]?secret)\s*[:=]\s*\S/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /(?<![\w/.-])[A-Za-z0-9_-]{32,}(?![\w/.-])/
]

/** Every place in `value` with a forbidden key or a string that looks like a credential, as `path: reason`. */
export function findCredentials(value: unknown, path = '$'): string[] {
  const found: string[] = []
  if (typeof value === 'string') {
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) found.push(`${path}: looks like a credential`)
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findCredentials(item, `${path}[${index}]`)))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(key))
        found.push(`${path}.${key}: not allowed; enter reviewer access in the dashboard`)
      found.push(...findCredentials(item, `${path}.${key}`))
    }
  }
  return found
}

function checkCase(errors: string[], field: string, item: ReviewCase, positive: boolean): void {
  checkLength(errors, `${field}.description`, item?.description, LIMITS.longDescription)
  if (!isString(item?.prompt)) errors.push(`${field}.prompt must be a non-empty string`)
  if (positive) {
    if (!isString(item.tools_triggered)) errors.push(`${field}.tools_triggered must be a non-empty string`)
    else if (!/^[a-zA-Z][\w]*(?:, [a-zA-Z][\w]*)*$/.test(item.tools_triggered)) {
      errors.push(`${field}.tools_triggered must be tool names separated by ", "`)
    }
    if (!isString(item.expected_behavior)) errors.push(`${field}.expected_behavior must be a non-empty string`)
  } else {
    for (const key of ['tools_triggered', 'expected_behavior'] as const) {
      if (item?.[key] !== undefined) errors.push(`${field}.${key} is only for positive cases`)
    }
  }
  for (const url of item?.file_attachment_urls ?? []) {
    if (!isHttpsUrl(url)) errors.push(`${field}.file_attachment_urls must hold https URLs`)
  }
  if (item?.expected_output_url !== undefined && !isHttpsUrl(item.expected_output_url)) {
    errors.push(`${field}.expected_output_url must be an https URL`)
  }
}

/** The review cases: exactly 5 positive and 3 negative, complete, unique prompts, nothing that looks like a secret. */
export function validateTestCases(testCases: OpenAIReview['review']['test_cases'] | undefined): string[] {
  const errors: string[] = []
  const positive = Array.isArray(testCases?.positive) ? testCases.positive : []
  const negative = Array.isArray(testCases?.negative) ? testCases.negative : []
  if (positive.length !== POSITIVE_CASES) {
    errors.push(`test_cases.positive has ${positive.length} cases; OpenAI review needs exactly ${POSITIVE_CASES}`)
  }
  if (negative.length !== NEGATIVE_CASES) {
    errors.push(`test_cases.negative has ${negative.length} cases; OpenAI review needs exactly ${NEGATIVE_CASES}`)
  }
  positive.forEach((item, index) => checkCase(errors, `test_cases.positive[${index}]`, item, true))
  negative.forEach((item, index) => checkCase(errors, `test_cases.negative[${index}]`, item, false))
  const prompts = [...positive, ...negative].map((item) => item?.prompt)
  if (new Set(prompts).size !== prompts.length) errors.push('test_cases prompts must be unique')
  return errors
}

export function validateReview(review: OpenAIReview): string[] {
  const errors: string[] = []
  if (!isString(review.category)) errors.push('category must be a non-empty string')
  if (!Array.isArray(review.capabilities) || review.capabilities.length > LIMITS.capabilities) {
    errors.push(`capabilities must be an array of at most ${LIMITS.capabilities}`)
  } else {
    review.capabilities.forEach((item, index) => checkLength(errors, `capabilities[${index}]`, item, LIMITS.capability))
  }
  checkLength(errors, 'directoryLongDescription', review.directoryLongDescription, LIMITS.longDescription)
  errors.push(...validateTestCases(review.review?.test_cases))
  const demo = review.review?.demo_recording_url
  if (demo !== null && !isHttpsUrl(demo)) errors.push('review.demo_recording_url must be an https URL or null')
  if (typeof review.review?.commerce !== 'boolean') errors.push('review.commerce must be a boolean')
  checkLength(errors, 'publication.release_notes', review.publication?.release_notes, LIMITS.longDescription)
  errors.push(...findCredentials(review))
  return errors
}

/** Reads and validates `shared/openai-review.json`. Throws with every problem listed. */
export async function loadOpenAIReview(root: string): Promise<OpenAIReview> {
  const path = join(root, OPENAI_REVIEW)
  let review: OpenAIReview
  try {
    review = JSON.parse(await readFile(path, 'utf8')) as OpenAIReview
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const errors = validateReview(review)
  if (errors.length > 0) throw new Error(errors.map((error) => `${OPENAI_REVIEW}: ${error}`).join('\n'))
  return review
}

export interface OpenAIInterface {
  displayName: string
  shortDescription: string
  longDescription: string
  developerName: string
  category: string
  capabilities: string[]
  websiteURL?: string
  supportURL?: string
  privacyPolicyURL?: string
  termsOfServiceURL?: string
  defaultPrompt?: string[]
  composerIcon: string
  logo: string
}

const URL_FIELDS = ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'] as const

/**
 * Listing text limits and paths of `extensions.com.openai.interface`. With `submission`, the four listing URLs that
 * MCP review requires must be set; otherwise a missing one is only reported by the caller as pending.
 */
export function validateInterface(iface: Partial<OpenAIInterface> | undefined, options: { submission: boolean }) {
  const errors: string[] = []
  const pending: string[] = []
  if (!iface || typeof iface !== 'object') return { errors: ['interface must be an object'], pending }
  checkLength(errors, 'interface.displayName', iface.displayName, LIMITS.displayName)
  checkLength(errors, 'interface.shortDescription', iface.shortDescription, LIMITS.shortDescription)
  checkLength(errors, 'interface.longDescription', iface.longDescription, LIMITS.longDescription)
  checkLength(errors, 'interface.developerName', iface.developerName, LIMITS.developerName)
  if (!isString(iface.category)) errors.push('interface.category must be a non-empty string')
  if (!Array.isArray(iface.capabilities)) errors.push('interface.capabilities must be an array')
  if (iface.displayName && /\b(?:mcp|plugin)\b/i.test(iface.displayName)) {
    errors.push('interface.displayName must not say MCP or Plugin')
  }
  for (const field of URL_FIELDS) {
    const value = iface[field]
    if (value === undefined) (options.submission ? errors : pending).push(`interface.${field} is not set`)
    else if (!isHttpsUrl(value) || value.length > LIMITS.url) errors.push(`interface.${field} must be an https URL`)
  }
  const prompts = iface.defaultPrompt ?? []
  if (!Array.isArray(prompts) || prompts.length > LIMITS.defaultPrompts) {
    errors.push(`interface.defaultPrompt must be an array of at most ${LIMITS.defaultPrompts}`)
  } else {
    prompts.forEach((prompt, index) => {
      checkLength(errors, `interface.defaultPrompt[${index}]`, prompt, LIMITS.defaultPrompt)
      if (/@\w/.test(prompt)) errors.push(`interface.defaultPrompt[${index}] must not @mention an app`)
    })
    if (new Set(prompts).size !== prompts.length) errors.push('interface.defaultPrompt must be unique')
  }
  for (const field of ['composerIcon', 'logo'] as const) {
    if (!isPluginPath(iface[field])) errors.push(`interface.${field} must be a ./ path inside the plugin`)
  }
  return { errors, pending }
}

/** A `./`-prefixed path that stays inside the plugin root; a directory may end in `/`. */
export function isPluginPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('./') || value.length <= 2 || value.includes('\\')) return false
  return !value
    .replace(/\/$/, '')
    .split('/')
    .some((part) => part === '..' || part === '')
}

/** Width and height of a PNG, or undefined when `data` is not one. */
export function pngSize(data: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString('latin1', 12, 16) !== 'IHDR') {
    return undefined
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/** Square PNG icons of 48 to 4096 px and at most 5 MiB, as the directory accepts. */
export function checkIcon(field: string, data: Buffer | undefined): string[] {
  if (!data) return [`${field} file is missing`]
  const size = pngSize(data)
  if (!size) return [`${field} must be a PNG`]
  const errors: string[] = []
  if (size.width !== size.height) errors.push(`${field} must be square, is ${size.width}x${size.height}`)
  if (size.width < 48 || size.width > 4096) errors.push(`${field} must be 48 to 4096 px, is ${size.width}`)
  if (data.length > 5 * 1024 * 1024) errors.push(`${field} must be at most 5 MiB`)
  return errors
}

type Validate = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null }

/** ajv validators for the Agent Plugins 1.0.0 `plugin.json` and `mcp.json` schemas, vendored in scripts/schemas. */
export async function agentPluginsSchemas(): Promise<{
  plugin: (data: unknown) => string[]
  mcp: (data: unknown) => string[]
}> {
  const require = createRequire(import.meta.url)
  const Ajv2020 = (
    require('ajv/dist/2020') as { default: new (options: object) => { compile(schema: object): Validate } }
  ).default
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const compile = async (file: string) => {
    const validate = ajv.compile(JSON.parse(await readFile(join(SCHEMAS_DIR, file), 'utf8')) as object)
    return (data: unknown) =>
      validate(data)
        ? []
        : (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim())
  }
  return { plugin: await compile('plugin.schema.json'), mcp: await compile('mcp.schema.json') }
}

/** SKILL.md front matter: `name` equal to its folder and a string `description`. */
export function checkSkillFile(path: string, text: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return [`${path} has no YAML front matter`]
  const folder = path.split('/').at(-2)
  const name = /^name:\s*(.+)$/m
    .exec(match[1]!)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  const errors: string[] = []
  if (name !== folder) errors.push(`${path} front matter name ${JSON.stringify(name)} must match its folder ${folder}`)
  if (!/^description:\s*\S/m.test(match[1]!)) errors.push(`${path} front matter needs a description`)
  return errors
}
