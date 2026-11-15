import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { assertUniquePaths, type GeneratedFile } from './lib/files.ts'
import { loadShared } from './lib/shared.ts'
import { openaiDirectoryFiles } from './targets/codex.ts'

/** Where `pnpm build:openai-zip` writes the ZIP the owner uploads at platform.openai.com/plugins (plan O2). */
export const OPENAI_ZIP = 'dist/openai/rushdb.zip'
/** Fixed entry time, so the same sources give the same bytes. ZIP stores local time, so this is local midnight. */
const MTIME = new Date(2026, 0, 1)

/** A ZIP with the plugin root at the top level, entries sorted, deflated, and no directory entries. */
export function zipFiles(files: GeneratedFile[]): Uint8Array {
  assertUniquePaths(files)
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 9 }]> = {}
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const content = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content
    entries[file.path] = [new Uint8Array(content), { mtime: MTIME, level: 9 }]
  }
  return zipSync(entries)
}

/** Builds the hooks-free directory ZIP from `shared/` and returns its path. */
export async function buildOpenAIZip(root: string, out = join(root, OPENAI_ZIP)): Promise<string> {
  const files = await openaiDirectoryFiles(await loadShared(root), root)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, zipFiles(files))
  return out
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const out = await buildOpenAIZip(root, process.argv[2] ? resolve(process.argv[2]) : undefined)
  console.log(`Wrote ${out}; check it with pnpm check:openai`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
