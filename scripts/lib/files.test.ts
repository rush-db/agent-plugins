import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertUniquePaths, findDrift, findSymlinks, json, listFiles, writeGenerated } from './files.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-plugins-files-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('json', () => {
  it('writes two-space JSON with a trailing newline', () => {
    expect(json({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n')
  })
})

describe('assertUniquePaths', () => {
  it('rejects two generators writing one path', () => {
    expect(() =>
      assertUniquePaths([
        { path: 'a.json', content: '' },
        { path: 'a.json', content: '' }
      ])
    ).toThrow('Two generators write a.json')
  })

  it.each(['/etc/passwd', '../outside', 'a//b', ''])('rejects the unsafe path %j', (path) => {
    expect(() => assertUniquePaths([{ path, content: '' }])).toThrow('relative and normalized')
  })
})

describe('writeGenerated and findDrift', () => {
  const files = [
    { path: 'plugins/x/plugin.json', content: json({ name: 'x' }) },
    { path: 'plugins/x/icon.png', content: Buffer.from([0, 1, 2]) }
  ]

  it('writes missing files and then reports no drift', async () => {
    expect(await findDrift(root, files)).toEqual([
      { path: 'plugins/x/plugin.json', reason: 'missing' },
      { path: 'plugins/x/icon.png', reason: 'missing' }
    ])
    expect(await writeGenerated(root, files)).toEqual(['plugins/x/plugin.json', 'plugins/x/icon.png'])
    expect(await findDrift(root, files)).toEqual([])
    expect(await writeGenerated(root, files)).toEqual([])
  })

  it('reports a generated file edited by hand, and a rebuild restores it', async () => {
    await writeGenerated(root, files)
    await writeFile(join(root, 'plugins/x/plugin.json'), '{"name":"edited"}\n')
    expect(await findDrift(root, files)).toEqual([{ path: 'plugins/x/plugin.json', reason: 'changed' }])
    await writeGenerated(root, files)
    expect(await readFile(join(root, 'plugins/x/plugin.json'), 'utf8')).toBe(json({ name: 'x' }))
  })
})

describe('listFiles and findSymlinks', () => {
  it('lists files in path order and finds symlinks', async () => {
    await mkdir(join(root, 'b'), { recursive: true })
    await writeFile(join(root, 'b/2.md'), '')
    await writeFile(join(root, 'a.md'), '')
    expect(await listFiles(root)).toEqual(['a.md', 'b/2.md'])
    expect(await findSymlinks(root)).toEqual([])

    await symlink(join(root, 'a.md'), join(root, 'b/link.md'))
    expect(await findSymlinks(root)).toEqual(['b/link.md'])
    await expect(listFiles(root)).rejects.toThrow('Symlink not allowed: b/link.md')
  })

  it('treats a missing directory as having no symlinks', async () => {
    expect(await findSymlinks(join(root, 'missing'))).toEqual([])
  })
})
