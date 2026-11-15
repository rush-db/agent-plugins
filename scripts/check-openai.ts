import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import {
  agentPluginsSchemas,
  checkIcon,
  checkSkillFile,
  findCredentials,
  isHttpsUrl,
  isPluginPath,
  validateInterface,
  validateTestCases,
  type OpenAIInterface
} from './lib/openai.ts'
import { OPENAI_ZIP } from './build-openai-zip.ts'

/**
 * Checks the OpenAI directory ZIP (plan O2) against the public submission rules
 * (developers.openai.com/plugins/deploy/submission): no lifecycle hooks and no app references, one remote MCP server
 * with no headers or auth block, listing limits, exactly 5 positive and 3 negative review cases, and no credentials.
 * With `--submission`, the listing URLs and the demo recording the owner adds before submitting are required too;
 * without it they are listed as pending.
 */

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parse(entries: Map<string, Buffer>, path: string, errors: string[]): unknown {
  const data = entries.get(path)
  if (!data) {
    errors.push(`${path} is missing`)
    return undefined
  }
  try {
    return JSON.parse(data.toString('utf8')) as unknown
  } catch {
    errors.push(`${path} is not JSON`)
    return undefined
  }
}

export interface OpenAICheck {
  errors: string[]
  /** What the owner still has to add before submitting (D6 URLs, the demo recording). */
  pending: string[]
}

/** Checks the ZIP's entries, keyed by path. */
export async function checkOpenAIPackage(
  entries: Map<string, Buffer>,
  options: { submission: boolean }
): Promise<OpenAICheck> {
  const errors: string[] = []
  const pending: string[] = []
  for (const path of entries.keys()) {
    if (path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '')) {
      errors.push(`${path}: unsafe path`)
    }
    if (/(^|\/)hooks(\/|\.json$)/.test(path)) errors.push(`${path}: lifecycle hooks are not accepted`)
    if (/(^|\/)\.app\.json$/.test(path)) errors.push(`${path}: app references are not accepted`)
    if (/^\.(codex|claude)-plugin\//.test(path) || path === '.mcp.json') {
      errors.push(`${path}: the directory build is portable only`)
    }
  }

  const schemas = await agentPluginsSchemas()
  const manifest = parse(entries, 'plugin.json', errors)
  const mcp = parse(entries, 'mcp.json', errors)
  if (manifest !== undefined) errors.push(...schemas.plugin(manifest).map((error) => `plugin.json${error}`))
  if (mcp !== undefined) errors.push(...schemas.mcp(mcp).map((error) => `mcp.json${error}`))

  if (isObject(mcp) && isObject(mcp.mcpServers)) {
    const servers = Object.entries(mcp.mcpServers)
    if (servers.length !== 1) errors.push(`mcp.json must declare exactly one server, has ${servers.length}`)
    for (const [name, server] of servers) {
      if (!isObject(server)) continue
      if (server.type !== 'streamable-http') errors.push(`mcp.json ${name}: the directory needs streamable-http`)
      if (!isHttpsUrl(server.url)) errors.push(`mcp.json ${name}: url must be https`)
      if (isObject(server.headers) && Object.keys(server.headers).length > 0) {
        errors.push(`mcp.json ${name}: headers must be empty`)
      }
      if (server.extensions !== undefined) errors.push(`mcp.json ${name}: no auth block; OAuth comes from discovery`)
    }
  }

  const openai = isObject(manifest) && isObject(manifest.extensions) ? manifest.extensions['com.openai'] : undefined
  if (!isObject(openai)) {
    errors.push('plugin.json extensions.com.openai must be an object')
    return { errors, pending }
  }
  for (const key of ['hooks', 'apps']) {
    if (openai[key] !== undefined) errors.push(`plugin.json extensions.com.openai.${key} is not accepted`)
  }
  const iface = openai.interface as Partial<OpenAIInterface> | undefined
  const listing = validateInterface(iface, options)
  errors.push(...listing.errors.map((error) => `plugin.json ${error}`))
  pending.push(...listing.pending)
  for (const field of ['composerIcon', 'logo'] as const) {
    const path = iface?.[field]
    if (isPluginPath(path)) errors.push(...checkIcon(`interface.${field}`, entries.get(path.slice(2))))
  }
  if (openai.onboardingSkill !== undefined) {
    const path = openai.onboardingSkill
    if (!isPluginPath(path) || !entries.has(path.slice(2)))
      errors.push('onboardingSkill must point at a packaged SKILL.md')
  }

  const review = isObject(openai.review) ? openai.review : {}
  errors.push(...validateTestCases(review.test_cases as never).map((error) => `review.${error}`))
  if (review.demo_recording_url === undefined) {
    ;(options.submission ? errors : pending).push('review.demo_recording_url is not set')
  } else if (!isHttpsUrl(review.demo_recording_url)) {
    errors.push('review.demo_recording_url must be an https URL')
  }
  const publication = isObject(openai.publication) ? openai.publication : {}
  if (typeof publication.release_notes !== 'string' || !publication.release_notes.trim()) {
    errors.push('publication.release_notes must be a non-empty string')
  }
  errors.push(...findCredentials(manifest).map((error) => `plugin.json ${error}`))

  const skills = [...entries.keys()].filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
  if (skills.length === 0) errors.push('skills/ holds no <name>/SKILL.md')
  for (const path of skills) errors.push(...checkSkillFile(path, entries.get(path)!.toString('utf8')))
  return { errors, pending }
}

export function readZip(data: Uint8Array): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  for (const [path, content] of Object.entries(unzipSync(data))) {
    if (!path.endsWith('/')) entries.set(path, Buffer.from(content))
  }
  return entries
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const zip = resolve(root, args.find((arg) => !arg.startsWith('--')) ?? OPENAI_ZIP)
  const { errors, pending } = await checkOpenAIPackage(readZip(await readFile(zip)), {
    submission: args.includes('--submission')
  })
  if (errors.length > 0) {
    console.error(errors.map((error) => `✗ ${error}`).join('\n'))
    process.exitCode = 1
    return
  }
  console.log(`${zip} passes the directory checks.`)
  if (pending.length > 0) {
    console.log('Still needed before submission (the owner adds these):')
    for (const item of pending) console.log(`  - ${item}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
