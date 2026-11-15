import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json, listFiles, type GeneratedFile } from '../lib/files.ts'
import { HOOK_BUNDLE_NAME } from '../../packages/hooks/src/bundle.ts'
import {
  loadOpenAIReview,
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  type OpenAIInterface,
  type OpenAIReview
} from '../lib/openai.ts'
import { stdioLaunch, type Shared } from '../lib/shared.ts'
import { SKILLS_DIR } from '../lib/skills.ts'
import { SUGGESTED_PROMPTS } from './antigravity.ts'
import { githubRepo, renderTemplate } from './claude.ts'
import { rootVersion } from './gemini.ts'

/**
 * Codex marketplace build (plan O1, finding F3) and the hooks-free OpenAI directory build (plan O2), from the same
 * functions.
 *
 * The marketplace build uses the Codex compatibility layout (`.codex-plugin/plugin.json`, `.mcp.json`), not the
 * portable one the plan names: Codex 0.169.0 and 0.171.0-alpha.5 skip every plugin hook when the plugin has a portable
 * root `plugin.json`, and run them from this layout. The directory build has no hooks and stays portable.
 */
export const CODEX_PLUGIN_DIR = 'plugins/codex/rushdb'
export const CODEX_MARKETPLACE = '.agents/plugins/marketplace.json'
export const CODEX_MANIFEST = '.codex-plugin/plugin.json'
export const CODEX_MCP = '.mcp.json'
export const CODEX_HOOKS = 'hooks/hooks.json'
export const ICON = 'assets/icon.png'
export const LOGO = 'assets/logo.png'
/** Recall is capped at about 8 KB; Codex spills `additionalContext` over this many tokens to a file. */
export const ADDITIONAL_CONTEXT_LIMIT = 4000

export function setupSkillName(shared: Shared): string {
  return `${shared.listing.name}-setup`
}

/** Codex runs hook commands through the shell in the session's cwd and exports `PLUGIN_ROOT` to plugin hooks. */
function hookCommand(command: string): string {
  return `node "\${PLUGIN_ROOT}/hooks/${HOOK_BUNDLE_NAME}" ${command} --host codex`
}

function hook(command: string, extra: Record<string, unknown> = {}) {
  return { type: 'command', command: hookCommand(command), ...extra }
}

/**
 * Codex `hooks/hooks.json` (timeouts in seconds).
 * - `UserPromptSubmit` and `Stop` are synchronous, unlike plan O1's async: Codex cancels unfinished background hooks
 *   when the session ends, so `codex exec` would lose its last turn. Both only write the local outbox and spawn a
 *   detached flush; the 5 s timeout caps them if the disk or git lookup stalls.
 * - `SessionEnd` always runs synchronously within 1 s by default (3 s at most); `end` only spawns a detached flush.
 * - No `PostCompact`: Codex passes no compaction summary to it.
 */
export function codexHooks() {
  return {
    description:
      'RushDB automatic context: recall at session start, capture of finished turns, flush before compaction and at session end. Off unless auto_context is set.',
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|compact',
          hooks: [hook('recall', { timeout: 10, additionalContextLimit: ADDITIONAL_CONTEXT_LIMIT })]
        }
      ],
      UserPromptSubmit: [{ hooks: [hook('capture', { timeout: 5 })] }],
      Stop: [{ hooks: [hook('capture', { timeout: 5 })] }],
      PreCompact: [{ hooks: [hook('precompact', { timeout: 30 })] }],
      SessionEnd: [{ hooks: [hook('end', { timeout: 1 })] }]
    }
  }
}

/** `extensions.com.openai.interface`. Listing URLs are left out while they are null (plan decision D6). */
export function openaiInterface(shared: Shared, review: OpenAIReview, longDescription: string): OpenAIInterface {
  const { listing } = shared
  return {
    displayName: listing.displayName,
    shortDescription: listing.tagline,
    longDescription,
    developerName: listing.author.name,
    category: review.category,
    capabilities: review.capabilities,
    websiteURL: listing.urls.homepage,
    supportURL: listing.urls.support,
    ...(listing.urls.privacyPolicy ? { privacyPolicyURL: listing.urls.privacyPolicy } : {}),
    ...(listing.urls.termsOfService ? { termsOfServiceURL: listing.urls.termsOfService } : {}),
    defaultPrompt: SUGGESTED_PROMPTS,
    composerIcon: `./${ICON}`,
    logo: `./${LOGO}`
  }
}

/**
 * The marketplace build's `.codex-plugin/plugin.json`: components and `interface` at the root, as the Codex format
 * has them, and the onboarding skill under `extensions.com.openai`. The listing text mentions automatic context.
 */
export function codexPluginManifest(shared: Shared, version: string, review: OpenAIReview) {
  const { listing } = shared
  return {
    name: listing.name,
    version,
    description: listing.description,
    author: listing.author,
    homepage: listing.urls.homepage,
    repository: listing.urls.repository,
    license: listing.license,
    keywords: listing.keywords,
    skills: `./${SKILLS_DIR}/`,
    mcpServers: `./${CODEX_MCP}`,
    hooks: `./${CODEX_HOOKS}`,
    interface: openaiInterface(shared, review, listing.longDescription),
    extensions: { 'com.openai': { onboardingSkill: `./${SKILLS_DIR}/${setupSkillName(shared)}/SKILL.md` } }
  }
}

/** Codex `.mcp.json`: the hosted server by URL, with no headers; OAuth comes from discovery. */
export function codexMcpConfig(shared: Shared) {
  return { mcpServers: { [shared.mcp.serverName]: { url: shared.mcp.hosted.url } } }
}

/**
 * The directory build: no hooks and no onboarding skill (key setup is only for hooks), plus the review cases and
 * release notes the ZIP upload fills in. `demo_recording_url` stays out until the owner sets it, so the upload keeps
 * the dashboard value.
 */
export function openaiDirectoryManifest(shared: Shared, version: string, review: OpenAIReview) {
  const { listing } = shared
  const { demo_recording_url, ...rest } = review.review
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: listing.name,
    version,
    description: listing.description,
    author: listing.author,
    homepage: listing.urls.homepage,
    repository: listing.urls.repository,
    license: listing.license,
    keywords: listing.keywords,
    extensions: {
      'com.openai': {
        interface: openaiInterface(shared, review, review.directoryLongDescription),
        review: { ...rest, ...(demo_recording_url ? { demo_recording_url } : {}) },
        publication: review.publication
      }
    }
  }
}

/** Portable `mcp.json`: one remote server, streamable HTTP, no `headers` and no `auth` block (OAuth from discovery). */
export function openaiMcpConfig(shared: Shared) {
  const { mcp } = shared
  return { $schema: MCP_SCHEMA_URL, mcpServers: { [mcp.serverName]: { type: 'streamable-http', url: mcp.hosted.url } } }
}

export function codexMarketplace(shared: Shared, review: OpenAIReview) {
  const { listing } = shared
  return {
    name: listing.name,
    interface: { displayName: listing.displayName },
    plugins: [
      {
        name: listing.name,
        source: { source: 'local', path: `./${CODEX_PLUGIN_DIR}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: review.category
      }
    ]
  }
}

function templateValues(shared: Shared): Record<string, string> {
  const { listing, mcp, skills } = shared
  const launch = stdioLaunch(mcp)
  return {
    name: listing.name,
    displayName: listing.displayName,
    longDescription: listing.longDescription,
    marketplaceRepo: githubRepo(listing.urls.repository),
    repository: listing.urls.repository,
    docsUrl: listing.urls.docs,
    hostedUrl: mcp.hosted.url,
    serverName: mcp.serverName,
    stdioCommand: [launch.command, ...launch.args].join(' '),
    setupSkill: setupSkillName(shared),
    skills: skills.skills.map((skill) => `\`${skill}\``).join(', ')
  }
}

/** Synced skills, LICENSE, icon and logo: real copies, as every Codex install copies only the plugin folder. */
async function contentFiles(root: string): Promise<GeneratedFile[]> {
  const icon = await readFile(join(root, 'shared', ICON))
  const files: GeneratedFile[] = [
    { path: 'LICENSE', content: await readFile(join(root, 'LICENSE')) },
    { path: ICON, content: icon },
    { path: LOGO, content: icon }
  ]
  const skillsDir = join(root, SKILLS_DIR)
  for (const path of await listFiles(skillsDir)) {
    files.push({ path: `${SKILLS_DIR}/${path}`, content: await readFile(join(skillsDir, path)) })
  }
  return files
}

/** The plugin folder and the root marketplace. The hook bundle comes from `hookBundles`. */
export async function codexPlugin(shared: Shared, root: string): Promise<GeneratedFile[]> {
  const version = await rootVersion(root)
  const review = await loadOpenAIReview(root)
  const values = templateValues(shared)
  const template = (name: string) => readFile(join(root, 'shared/codex', name), 'utf8')
  const files: GeneratedFile[] = [
    { path: CODEX_MANIFEST, content: json(codexPluginManifest(shared, version, review)) },
    { path: CODEX_MCP, content: json(codexMcpConfig(shared)) },
    { path: CODEX_HOOKS, content: json(codexHooks()) },
    { path: 'README.md', content: renderTemplate(await template('README.md.tmpl'), values) },
    {
      path: `${SKILLS_DIR}/${setupSkillName(shared)}/SKILL.md`,
      content: renderTemplate(await template('setup-skill.md.tmpl'), values)
    },
    ...(await contentFiles(root))
  ]
  return [
    { path: CODEX_MARKETPLACE, content: json(codexMarketplace(shared, review)) },
    ...files.map((file) => ({ ...file, path: `${CODEX_PLUGIN_DIR}/${file.path}` }))
  ]
}

/** Files of the directory ZIP, relative to the plugin root (plan O2). */
export async function openaiDirectoryFiles(shared: Shared, root: string): Promise<GeneratedFile[]> {
  const version = await rootVersion(root)
  const review = await loadOpenAIReview(root)
  return [
    { path: 'plugin.json', content: json(openaiDirectoryManifest(shared, version, review)) },
    { path: 'mcp.json', content: json(openaiMcpConfig(shared)) },
    ...(await contentFiles(root))
  ]
}
