import { json, type GeneratedFile } from '../lib/files.ts'
import { HOOK_BUNDLE_NAME } from '../../packages/hooks/src/bundle.ts'
import { stdioLaunch, type Shared } from '../lib/shared.ts'
import { readContextTemplate, renderContext, rootVersion } from './gemini.ts'

/**
 * Antigravity plugin at the repo root (plan P0-9, finding F6). `.antigravity-plugin/plugin.json` takes precedence
 * over a root `plugin.json` in repos that serve several hosts; `mcp_config.json`, `hooks.json` and `skills/` sit at
 * the root and `skills/` is shared with the Gemini extension. `rules/<name>.md` carries the same context text as
 * `GEMINI.md`.
 */
export const AGY_MANIFEST = '.antigravity-plugin/plugin.json'
export const AGY_MCP = 'mcp_config.json'
export const AGY_HOOKS = 'hooks.json'
/** Plugin rules: markdown whose front matter sets `trigger`; ours is always on while the plugin is enabled. */
export const AGY_RULES_DIR = 'rules'
export const AGY_SCHEMA = 'https://antigravity.google/schemas/v1/plugin.json'

/** Marketplace starter prompts, at most 3: one each for search, analytics and the data model. */
export const SUGGESTED_PROMPTS = [
  'Search my RushDB records for anything about onboarding',
  'Count my RushDB records by label and show the top five',
  'Describe the data model of my RushDB project'
]

export function agyManifest(shared: Shared, version: string) {
  const { listing } = shared
  return {
    $schema: AGY_SCHEMA,
    name: listing.name,
    displayName: listing.displayName,
    description: listing.description,
    version,
    author: listing.author,
    homepage: listing.urls.homepage,
    repository: listing.urls.repository,
    license: listing.license,
    keywords: listing.keywords,
    suggestedPrompts: SUGGESTED_PROMPTS
  }
}

/**
 * The stdio server. Only required settings become `variables`: agy installs a plugin with variables disabled until
 * the user fills every one in, and has no default values. Optional settings such as `RUSHDB_API_URL` keep the MCP
 * server's own default.
 */
export function agyMcpConfig(shared: Shared) {
  const { mcp } = shared
  const required = Object.entries(mcp.stdio.env).filter(([, spec]) => spec.required)
  return {
    mcpServers: {
      [mcp.serverName]: {
        ...stdioLaunch(mcp),
        env: Object.fromEntries(required.map(([name]) => [name, `\${${name}}`])),
        variables: required.map(([name, spec]) => ({
          name,
          title: spec.description,
          description: `${spec.description}, from your project settings in RushDB`,
          link: shared.listing.urls.docs
        }))
      }
    }
  }
}

/**
 * agy runs hooks synchronously in the folder that holds `hooks.json` (timeouts in seconds), so commands use a path
 * relative to the root. Only `SessionStart` recall for now: agy's `Stop` input has no answer text, so capture stays
 * off until a recorded transcript shows where the turn text is.
 */
export function agyHooks(shared: Shared) {
  return {
    [`${shared.listing.name}-context`]: {
      SessionStart: [
        {
          type: 'command',
          command: `node ./hooks/${HOOK_BUNDLE_NAME} recall --host agy`,
          timeout: 10
        }
      ]
    }
  }
}

export async function antigravityPlugin(shared: Shared, root: string): Promise<GeneratedFile[]> {
  return [
    { path: AGY_MANIFEST, content: json(agyManifest(shared, await rootVersion(root))) },
    { path: AGY_MCP, content: json(agyMcpConfig(shared)) },
    { path: AGY_HOOKS, content: json(agyHooks(shared)) },
    {
      path: `${AGY_RULES_DIR}/${shared.listing.name}.md`,
      content: `---\ntrigger: always_on\n---\n\n${renderContext(
        shared,
        await readContextTemplate(root),
        `the \`RUSHDB_API_KEY\` variable of the ${shared.listing.displayName} plugin in \`/plugin\``
      )}`
    }
  ]
}
