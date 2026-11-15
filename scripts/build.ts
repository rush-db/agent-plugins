import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDrift, findSymlinks, writeGenerated, type GeneratedFile } from './lib/files.ts'
import { hookBundles } from './lib/hooks.ts'
import { loadShared, type Shared } from './lib/shared.ts'
import { checkSkills } from './lib/skills.ts'

/** Turns the shared sources into files. Each platform step adds its generator here. */
export type Generator = (shared: Shared, root: string) => Promise<GeneratedFile[]> | GeneratedFile[]

export const generators: Generator[] = [(_shared, root) => hookBundles(root)]

/** Top-level paths that hold generated output and must never contain symlinks. */
export const GENERATED_ROOTS = ['skills', 'plugins', 'hooks', 'commands', '.claude-plugin', '.agents']

export interface BuildResult {
  /** Files written, or in check mode the files that differ. */
  changed: string[]
  errors: string[]
}

export async function build(root: string, options: { check: boolean; generators?: Generator[] }): Promise<BuildResult> {
  const shared = await loadShared(root)
  const files: GeneratedFile[] = []
  for (const generate of options.generators ?? generators) files.push(...(await generate(shared, root)))

  const errors = await checkSkills(root, shared.skills)
  let changed: string[]
  if (options.check) {
    const drift = await findDrift(root, files)
    changed = drift.map((item) => item.path)
    errors.push(...drift.map((item) => `${item.path} is ${item.reason}; run pnpm build`))
  } else {
    changed = await writeGenerated(root, files)
  }
  for (const dir of GENERATED_ROOTS) {
    for (const link of await findSymlinks(resolve(root, dir))) errors.push(`${dir}/${link} is a symlink`)
  }
  return { changed, errors }
}

async function main(): Promise<void> {
  const check = process.argv.slice(2).includes('--check')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { changed, errors } = await build(root, { check })
  if (errors.length > 0) {
    console.error(errors.map((error) => `✗ ${error}`).join('\n'))
    process.exitCode = 1
    return
  }
  if (check) console.log('Generated files are up to date.')
  else console.log(changed.length > 0 ? `Wrote ${changed.join(', ')}` : 'Generated files are up to date.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
