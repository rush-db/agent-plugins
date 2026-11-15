import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** One file the build owns. `path` is relative to the repo root and uses forward slashes. */
export interface GeneratedFile {
  path: string
  content: string | Buffer
}

export interface Drift {
  path: string
  reason: 'missing' | 'changed'
}

/** JSON as every generator writes it: two-space indent and a trailing newline. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function toBuffer(content: string | Buffer): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content
}

function assertRelative(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Generated path must be relative and normalized: ${JSON.stringify(path)}`)
  }
}

/** Fails on duplicate or unsafe paths, so two generators never fight over one file. */
export function assertUniquePaths(files: GeneratedFile[]): void {
  const seen = new Set<string>()
  for (const file of files) {
    assertRelative(file.path)
    if (seen.has(file.path)) throw new Error(`Two generators write ${file.path}`)
    seen.add(file.path)
  }
}

export async function writeGenerated(root: string, files: GeneratedFile[]): Promise<string[]> {
  assertUniquePaths(files)
  const written: string[] = []
  for (const file of files) {
    const target = join(root, file.path)
    const content = toBuffer(file.content)
    const current = await readFile(target).catch(() => undefined)
    if (current?.equals(content)) continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    written.push(file.path)
  }
  return written
}

export async function findDrift(root: string, files: GeneratedFile[]): Promise<Drift[]> {
  assertUniquePaths(files)
  const drift: Drift[] = []
  for (const file of files) {
    const current = await readFile(join(root, file.path)).catch(() => undefined)
    if (current === undefined) drift.push({ path: file.path, reason: 'missing' })
    else if (!current.equals(toBuffer(file.content))) drift.push({ path: file.path, reason: 'changed' })
  }
  return drift
}

/** Every regular file under `dir`, relative to it, sorted. Throws on symlinks. */
export async function listFiles(dir: string): Promise<string[]> {
  const result: string[] = []
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed: ${relative(dir, path)}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) result.push(relative(dir, path).split(sep).join('/'))
    }
  }
  await walk(dir)
  return result.sort()
}

/** Paths of symlinks under `dir`, relative to it. A missing `dir` has none. */
export async function findSymlinks(dir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) found.push(relative(dir, path).split(sep).join('/'))
      else if (entry.isDirectory()) await walk(path)
    }
  }
  const stat = await lstat(dir).catch(() => undefined)
  if (stat?.isDirectory()) await walk(dir)
  return found.sort()
}
