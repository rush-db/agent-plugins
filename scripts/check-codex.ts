import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_BUNDLE_NAME } from '../packages/hooks/src/bundle.ts'
import { listFiles } from './lib/files.ts'
import { checkIcon, checkSkillFile, isHttpsUrl, isPluginPath, validateInterface } from './lib/openai.ts'
import { CODEX_MANIFEST, CODEX_MARKETPLACE, CODEX_MCP } from './targets/codex.ts'

/**
 * Checks the Codex marketplace and every plugin it lists, as committed (plan O1). Codex has no validator command and
 * agent-plugins.org publishes no marketplace or hooks schema, so the rules come from the Codex docs
 * (developers.openai.com/plugins/build/plugins, learn.chatgpt.com/docs/hooks) and from what Codex 0.169.0 does.
 */

const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const INSTALLATION = ['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']
const AUTHENTICATION = ['ON_INSTALL', 'ON_USE']
/** Events a Codex hooks.json may declare. */
export const CODEX_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'PreCompact',
  'PostCompact',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'PreModelRequest',
  'PostModelRequest',
  'Interrupt'
]
/** Codex ignores a matcher on these events. */
const NO_MATCHER = ['UserPromptSubmit', 'Stop', 'Interrupt']
/** Only these events can return `additionalContext`. */
const CONTEXT_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SubagentStart']
/** `SessionEnd` and `Interrupt` run within 1 s by default and 3 s at most. */
const SHORT_EVENTS = ['SessionEnd', 'Interrupt']

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export interface MarketplaceEntry {
  name: string
  path: string
}

/** The marketplace file's own rules, and the local plugin folders it points at. */
export function validateMarketplace(marketplace: unknown): { errors: string[]; entries: MarketplaceEntry[] } {
  const errors: string[] = []
  const entries: MarketplaceEntry[] = []
  if (!isObject(marketplace)) return { errors: ['marketplace must be a JSON object'], entries }
  if (!isString(marketplace.name) || !NAME.test(marketplace.name)) errors.push('name must be lowercase kebab-case')
  if (!isObject(marketplace.interface) || !isString(marketplace.interface.displayName)) {
    errors.push('interface.displayName must be a non-empty string')
  }
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  if (plugins.length === 0) errors.push('plugins must be a non-empty array')
  plugins.forEach((plugin: unknown, index) => {
    const where = `plugins[${index}]`
    if (!isObject(plugin)) return errors.push(`${where} must be an object`)
    if (!isString(plugin.name) || !NAME.test(plugin.name)) errors.push(`${where}.name must be lowercase kebab-case`)
    const source = plugin.source
    const path = typeof source === 'string' ? source : isObject(source) ? source.path : undefined
    if (isObject(source) && source.source !== 'local') errors.push(`${where}.source.source must be "local"`)
    if (!isPluginPath(path)) errors.push(`${where}.source.path must be a ./ path inside the marketplace root`)
    else if (isString(plugin.name)) entries.push({ name: plugin.name, path })
    const policy = isObject(plugin.policy) ? plugin.policy : {}
    if (!INSTALLATION.includes(policy.installation as string)) {
      errors.push(`${where}.policy.installation must be one of ${INSTALLATION.join(', ')}`)
    }
    if (!AUTHENTICATION.includes(policy.authentication as string)) {
      errors.push(`${where}.policy.authentication must be one of ${AUTHENTICATION.join(', ')}`)
    }
    if (!isString(plugin.category)) errors.push(`${where}.category must be a non-empty string`)
  })
  return { errors, entries }
}

/**
 * A Codex `hooks.json`: known events, command handlers that run our bundle from `${PLUGIN_ROOT}`, timeouts in whole
 * seconds, `SessionEnd` within 3 s and never async, and no setting Codex ignores or warns about.
 */
export function validateCodexHooks(config: unknown): string[] {
  const errors: string[] = []
  if (!isObject(config) || !isObject(config.hooks)) return ['hooks.json must be an object with a "hooks" object']
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!CODEX_EVENTS.includes(event)) errors.push(`${event} is not a Codex hook event`)
    if (!Array.isArray(groups) || groups.length === 0) {
      errors.push(`${event} must be a non-empty array of matcher groups`)
      continue
    }
    groups.forEach((group: unknown, groupIndex) => {
      const where = `${event}[${groupIndex}]`
      if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) {
        return errors.push(`${where} must have a non-empty "hooks" array`)
      }
      if (group.matcher !== undefined) {
        if (NO_MATCHER.includes(event)) errors.push(`${where}.matcher is ignored by Codex for ${event}`)
        else if (typeof group.matcher !== 'string') errors.push(`${where}.matcher must be a string`)
      }
      group.hooks.forEach((handler: unknown, index) => {
        const at = `${where}.hooks[${index}]`
        if (!isObject(handler)) return errors.push(`${at} must be an object`)
        if (handler.type !== 'command') errors.push(`${at}.type must be "command"`)
        const command = handler.command
        if (!isString(command) || !command.startsWith(`node "\${PLUGIN_ROOT}/hooks/${HOOK_BUNDLE_NAME}" `)) {
          errors.push(`${at}.command must run node "\${PLUGIN_ROOT}/hooks/${HOOK_BUNDLE_NAME}"`)
        } else if (!/ --host codex$/.test(command)) {
          errors.push(`${at}.command must end with --host codex`)
        }
        const timeout = handler.timeout
        if (!Number.isInteger(timeout) || (timeout as number) <= 0) errors.push(`${at}.timeout must be whole seconds`)
        if (SHORT_EVENTS.includes(event)) {
          if ((timeout as number) > 3) errors.push(`${at}.timeout can be at most 3 s for ${event}`)
          if (handler.async !== undefined) errors.push(`${at}.async: ${event} always runs synchronously`)
        }
        if (handler.additionalContextLimit !== undefined) {
          if (!CONTEXT_EVENTS.includes(event)) errors.push(`${at}.additionalContextLimit has no effect on ${event}`)
          else if (
            !Number.isInteger(handler.additionalContextLimit) ||
            (handler.additionalContextLimit as number) <= 0
          ) {
            errors.push(`${at}.additionalContextLimit must be a positive integer`)
          }
        }
      })
    })
  }
  return errors
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function readJson(path: string, errors: string[], label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    errors.push(`${label}: cannot read: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** One plugin folder in the Codex compatibility layout. `label` prefixes every error. */
export async function checkCodexPlugin(dir: string, name: string, label: string): Promise<string[]> {
  const errors: string[] = []
  const add = (list: string[], prefix = label) => errors.push(...list.map((error) => `${prefix}: ${error}`))
  // Codex 0.169.0 and 0.171.0-alpha.5 skip every plugin hook when a portable root plugin.json exists.
  for (const portable of ['plugin.json', 'mcp.json']) {
    if (await exists(join(dir, portable))) add([`${portable} must not exist: Codex then skips the plugin hooks`])
  }
  const manifest = await readJson(join(dir, CODEX_MANIFEST), errors, `${label}/${CODEX_MANIFEST}`)
  if (!isObject(manifest)) return errors
  const at = `${label}/${CODEX_MANIFEST}`
  const local: string[] = []
  if (manifest.name !== name) local.push(`name must be ${JSON.stringify(name)}, as in the marketplace`)
  if (!isString(manifest.version) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) local.push('version must be x.y.z')
  if (!isString(manifest.description)) local.push('description must be a non-empty string')
  if (!isObject(manifest.author) || !isString(manifest.author.name))
    local.push('author.name must be a non-empty string')
  const iface = manifest.interface as Json | undefined
  const { errors: interfaceErrors } = validateInterface(iface, { submission: false })
  local.push(...interfaceErrors)
  const openai = isObject(manifest.extensions) && isObject(manifest.extensions['com.openai'])
  const onboarding = openai ? (manifest.extensions as Json)['com.openai'] : undefined
  const paths: Record<string, unknown> = {
    skills: manifest.skills,
    mcpServers: manifest.mcpServers,
    hooks: manifest.hooks,
    'extensions.com.openai.onboardingSkill': isObject(onboarding) ? onboarding.onboardingSkill : undefined,
    'interface.composerIcon': iface?.composerIcon,
    'interface.logo': iface?.logo
  }
  for (const [field, value] of Object.entries(paths)) {
    if (!isPluginPath(value)) local.push(`${field} must be a ./ path inside the plugin`)
    else if (!(await exists(join(dir, value)))) local.push(`${field} points at ${value}, which does not exist`)
  }
  if (manifest.mcpServers !== `./${CODEX_MCP}`) local.push(`mcpServers must be ./${CODEX_MCP}`)
  add(local, at)

  for (const field of ['composerIcon', 'logo'] as const) {
    const path = iface?.[field]
    if (isPluginPath(path))
      add(checkIcon(`interface.${field}`, await readFile(join(dir, path)).catch(() => undefined)), at)
  }

  const mcp = await readJson(join(dir, CODEX_MCP), errors, `${label}/${CODEX_MCP}`)
  if (isObject(mcp)) {
    const servers = isObject(mcp.mcpServers) ? Object.entries(mcp.mcpServers) : []
    const mcpErrors: string[] = []
    if (servers.length !== 1) mcpErrors.push('mcpServers must hold exactly one server')
    for (const [server, config] of servers) {
      if (!isObject(config) || !isHttpsUrl(config.url)) mcpErrors.push(`${server}.url must be an https URL`)
      else if (isObject(config.headers) && Object.keys(config.headers).length > 0) {
        mcpErrors.push(`${server}.headers must be empty: no credentials in the plugin`)
      }
    }
    add(mcpErrors, `${label}/${CODEX_MCP}`)
  }

  if (isPluginPath(manifest.hooks)) {
    const hooks = await readJson(join(dir, manifest.hooks), errors, `${label}/${manifest.hooks.slice(2)}`)
    if (hooks !== undefined) add(validateCodexHooks(hooks), `${label}/${manifest.hooks.slice(2)}`)
    if (!(await exists(join(dir, 'hooks', HOOK_BUNDLE_NAME)))) add([`hooks/${HOOK_BUNDLE_NAME} is missing`])
  }

  if (isPluginPath(manifest.skills) && (await exists(join(dir, manifest.skills)))) {
    const skillsDir = join(dir, manifest.skills)
    const skillFiles = (await listFiles(skillsDir)).filter((path) => /^[^/]+\/SKILL\.md$/.test(path))
    if (skillFiles.length === 0) add(['skills/ holds no <name>/SKILL.md'])
    for (const path of skillFiles) {
      add(checkSkillFile(`skills/${path}`, await readFile(join(skillsDir, path), 'utf8')))
    }
  }
  return errors
}

/** The root marketplace and every plugin it lists. */
export async function checkCodex(root: string): Promise<string[]> {
  const errors: string[] = []
  const marketplace = await readJson(join(root, CODEX_MARKETPLACE), errors, CODEX_MARKETPLACE)
  if (marketplace === undefined) return errors
  const { errors: marketplaceErrors, entries } = validateMarketplace(marketplace)
  errors.push(...marketplaceErrors.map((error) => `${CODEX_MARKETPLACE}: ${error}`))
  for (const entry of entries) {
    const dir = join(root, entry.path)
    if (!(await exists(dir))) {
      errors.push(`${CODEX_MARKETPLACE}: ${entry.path} does not exist`)
      continue
    }
    errors.push(...(await checkCodexPlugin(dir, entry.name, entry.path.slice(2))))
  }
  return errors
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const errors = await checkCodex(root)
  if (errors.length > 0) {
    console.error(errors.map((error) => `✗ ${error}`).join('\n'))
    process.exitCode = 1
    return
  }
  console.log(`Codex marketplace ${CODEX_MARKETPLACE} and its plugins pass.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
