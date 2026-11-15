import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadShared } from './lib/shared.ts'
import { syncSkills } from './lib/skills.ts'

// Usage: pnpm sync:skills [--repo <URL or path to a rush-db/skills checkout>]
// The tag and the skill list always come from shared/skills.json.
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { repo: { type: 'string' } } })
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { skills: pin } = await loadShared(root)
  const source = await syncSkills(root, pin, values.repo ?? pin.repository)
  console.log(`Synced ${source.skills.join(', ')} from ${source.tag} (${source.commit.slice(0, 12)}) into skills/`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
