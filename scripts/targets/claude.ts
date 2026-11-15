import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json, listFiles, type GeneratedFile } from '../lib/files.ts'
import { HOOK_BUNDLE_NAME } from '../../packages/hooks/src/bundle.ts'
import { stdioLaunch, type Shared } from '../lib/shared.ts'
import { SKILLS_DIR } from '../lib/skills.ts'

/** The plugin folder: Claude Code, the Claude directory bundle and Qwen Code all install it (plan P0-5, P0-6). */
export const CLAUDE_PLUGIN_DIR = 'plugins/claude/rushdb'
export const CLAUDE_MARKETPLACE = '.claude-plugin/marketplace.json'
const ICON = 'assets/icon.png'

/** Every hook command runs the bundle from the plugin root, quoted, with no other variables (directory rule). */
function hookCommand(command: string): string {
  return `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${HOOK_BUNDLE_NAME}" ${command} --host claude`
}

function hook(command: string, extra: Record<string, unknown> = {}) {
  return { type: 'command', command: hookCommand(command), ...extra }
}

/**
 * Claude `hooks/hooks.json`. Qwen Code runs the same file after a marketplace install.
 * - `SessionStart` re-fires after `/clear` and compaction, so recall covers those too.
 * - `Stop` is async: capture never delays the next prompt.
 * - `SessionEnd` has a 1.5 s budget that plugin timeouts don't raise; `end` only spawns a detached flush.
 */
export function claudeHooks() {
  return {
    description:
      'RushDB automatic context: recall at session start, capture of finished turns, flush around compaction and at session end. Off unless auto_context is set.',
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [hook('recall', { timeout: 10 })] }],
      Stop: [{ hooks: [hook('capture', { async: true, timeout: 30 })] }],
      PreCompact: [{ hooks: [hook('precompact', { timeout: 30 })] }],
      PostCompact: [{ hooks: [hook('postcompact', { timeout: 15 })] }],
      SessionEnd: [{ hooks: [hook('end', { timeout: 2 })] }]
    }
  }
}

export function claudePluginManifest(shared: Shared, version: string) {
  const { listing, mcp } = shared
  const apiUrl = mcp.stdio.env.RUSHDB_API_URL?.default
  return {
    name: listing.name,
    displayName: listing.displayName,
    version,
    description: listing.description,
    author: listing.author,
    homepage: listing.urls.homepage,
    repository: listing.urls.repository,
    license: listing.license,
    keywords: listing.keywords,
    icon: `./${ICON}`,
    documentationUrl: listing.urls.docs,
    supportUrl: listing.urls.support,
    // Unset until the owner decides D6; the directory asks for it before submission.
    ...(listing.urls.privacyPolicy ? { privacyPolicyUrl: listing.urls.privacyPolicy } : {}),
    ...(listing.urls.termsOfService ? { termsOfServiceUrl: listing.urls.termsOfService } : {}),
    userConfig: {
      api_key: {
        type: 'string',
        title: 'RushDB API key',
        description:
          'Project API key from the RushDB dashboard. Only the automatic-context hooks use it; the MCP tools sign in with OAuth.',
        sensitive: true,
        required: false
      },
      api_url: {
        type: 'string',
        title: 'RushDB API URL',
        description: 'Leave the default for RushDB Cloud; set your own URL for a self-hosted RushDB.',
        ...(apiUrl ? { default: apiUrl } : {})
      },
      auto_context: {
        type: 'string',
        title: 'Automatic context',
        description:
          'off: hooks do nothing. recall: recall earlier context at session start. recall+persist: also store finished turns in RushDB.',
        options: ['off', 'recall', 'recall+persist'],
        // Owner decision D1: off everywhere.
        default: 'off'
      },
      context_scope: {
        type: 'string',
        title: 'Context scope',
        description:
          'Optional name that replaces the project key, to share context across folders or keep it apart. Empty: one scope per git remote or folder.',
        required: false
      }
    },
    // Owner decision D2: the hosted OAuth server, so no key or npx sits in the plugin.
    mcpServers: { [mcp.serverName]: { type: mcp.hosted.type, url: mcp.hosted.url } }
  }
}

export function claudeMarketplace(shared: Shared) {
  const { listing } = shared
  return {
    name: listing.name,
    owner: listing.author,
    description: `${listing.displayName} plugins for agent platforms`,
    plugins: [{ name: listing.name, source: `./${CLAUDE_PLUGIN_DIR}`, description: listing.description }]
  }
}

/** `owner/repo` of a GitHub URL, for the `--marketplace` install line. */
export function githubRepo(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!match) throw new Error(`Not a GitHub repository URL: ${url}`)
  return match[1]!
}

/** Replaces every `{{key}}`; throws on a key it has no value for, so a typo never ships. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Template has no value for {{${key}}}`)
    return value
  })
}

export function claudeReadme(shared: Shared, template: string): string {
  const { listing, mcp, skills } = shared
  const launch = stdioLaunch(mcp)
  return renderTemplate(template, {
    name: listing.name,
    displayName: listing.displayName,
    longDescription: listing.longDescription,
    marketplaceRepo: githubRepo(listing.urls.repository),
    repository: listing.urls.repository,
    hostedUrl: mcp.hosted.url,
    apiUrl: mcp.stdio.env.RUSHDB_API_URL?.default ?? '',
    serverName: mcp.serverName,
    stdioCommand: [launch.command, ...launch.args].join(' '),
    skills: skills.skills.map((skill) => `\`${skill}\``).join(', ')
  })
}

/**
 * The Claude plugin folder and the root marketplace. Skills, LICENSE and the icon are real copies: the directory
 * takes no symlinks, and every install copies only the plugin folder. The hook bundle comes from `hookBundles`.
 */
export async function claudePlugin(shared: Shared, root: string): Promise<GeneratedFile[]> {
  const version = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version
  const template = await readFile(join(root, 'shared/claude/README.md.tmpl'), 'utf8')
  const files: GeneratedFile[] = [
    { path: CLAUDE_MARKETPLACE, content: json(claudeMarketplace(shared)) },
    { path: `${CLAUDE_PLUGIN_DIR}/.claude-plugin/plugin.json`, content: json(claudePluginManifest(shared, version)) },
    { path: `${CLAUDE_PLUGIN_DIR}/hooks/hooks.json`, content: json(claudeHooks()) },
    { path: `${CLAUDE_PLUGIN_DIR}/README.md`, content: claudeReadme(shared, template) },
    { path: `${CLAUDE_PLUGIN_DIR}/LICENSE`, content: await readFile(join(root, 'LICENSE')) },
    { path: `${CLAUDE_PLUGIN_DIR}/${ICON}`, content: await readFile(join(root, 'shared', ICON)) }
  ]
  const skillsDir = join(root, SKILLS_DIR)
  for (const path of await listFiles(skillsDir)) {
    files.push({ path: `${CLAUDE_PLUGIN_DIR}/${SKILLS_DIR}/${path}`, content: await readFile(join(skillsDir, path)) })
  }
  return files
}
