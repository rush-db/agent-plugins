import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { build, type Generator } from './build.ts'
import { json } from './lib/files.ts'
import { createSkillsRepo, skillMarkdown } from './lib/fixtures.ts'
import type { SkillsPin } from './lib/shared.ts'
import { syncSkills } from './lib/skills.ts'

const repoRoot = resolve(import.meta.dirname, '..')

let work: string
let root: string

// A stand-in for the platform generators added in later steps.
const manifest: Generator = (shared) => [
  { path: 'plugins/test/plugin.json', content: json({ name: shared.listing.name, url: shared.mcp.hosted.url }) }
]

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'agent-plugins-build-'))
  root = join(work, 'repo')
  await cp(join(repoRoot, 'shared'), join(root, 'shared'), { recursive: true })
  const pin: SkillsPin = { ...JSON.parse(await readFile(join(root, 'shared/skills.json'), 'utf8')), tag: 'v3.0.5' }
  await writeFile(join(root, 'shared/skills.json'), json(pin))
  const upstream = join(work, 'skills')
  await createSkillsRepo(
    upstream,
    pin.tag,
    Object.fromEntries(pin.skills.map((skill) => [`${skill}/SKILL.md`, skillMarkdown(skill)]))
  )
  await syncSkills(root, pin, upstream)
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

describe('build', () => {
  it('passes --check on an empty build', async () => {
    expect(await build(root, { check: true, generators: [] })).toEqual({ changed: [], errors: [] })
  })

  it('fails --check until the build has written its files', async () => {
    expect(await build(root, { check: true, generators: [manifest] })).toEqual({
      changed: ['plugins/test/plugin.json'],
      errors: ['plugins/test/plugin.json is missing; run pnpm build']
    })
    expect(await build(root, { check: false, generators: [manifest] })).toEqual({
      changed: ['plugins/test/plugin.json'],
      errors: []
    })
    expect(await build(root, { check: true, generators: [manifest] })).toEqual({ changed: [], errors: [] })
  })

  it('fails --check when a generated file is edited by hand', async () => {
    await build(root, { check: false, generators: [manifest] })
    await writeFile(join(root, 'plugins/test/plugin.json'), '{}\n')
    expect((await build(root, { check: true, generators: [manifest] })).errors).toEqual([
      'plugins/test/plugin.json is changed; run pnpm build'
    ])
  })

  it('fails --check when a synced skill is edited by hand', async () => {
    await writeFile(join(root, 'skills/rushdb-query-builder/SKILL.md'), skillMarkdown('rushdb-query-builder', 'Edit'))
    expect((await build(root, { check: true, generators: [] })).errors).toEqual([
      'skills/ differs from what pnpm sync:skills wrote; do not edit synced skills by hand'
    ])
  })

  it('fails on a symlink in generated output', async () => {
    await mkdir(join(root, 'plugins/test'), { recursive: true })
    await symlink('../../shared/listing.json', join(root, 'plugins/test/listing.json'))
    expect((await build(root, { check: true, generators: [] })).errors).toEqual([
      'plugins/test/listing.json is a symlink'
    ])
  })

  it('stops on invalid shared sources before writing anything', async () => {
    await writeFile(join(root, 'shared/mcp.json'), '{}')
    await expect(build(root, { check: false, generators: [manifest] })).rejects.toThrow('shared/mcp.json')
    await expect(readFile(join(root, 'plugins/test/plugin.json'))).rejects.toThrow()
  })
})
