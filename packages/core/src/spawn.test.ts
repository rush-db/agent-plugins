import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { spawnDetached, spawnDetachedFlush } from './flush.ts'

describe('spawnDetached', () => {
  it('returns at once and the child finishes on its own', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rushdb-core-spawn-'))
    const script = join(directory, 'child.mjs')
    const marker = join(directory, 'done')
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'\nsetTimeout(() => writeFileSync(process.argv[3], process.argv[2]), 300)\n`
    )
    const started = Date.now()
    expect(spawnDetachedFlush(script, [marker])).toBe(true)
    expect(Date.now() - started).toBeLessThan(200)
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('flush'), { timeout: 5000 })
  })

  it('reports a command that cannot start without throwing', () => {
    expect(() => spawnDetached('/nonexistent/rushdb-binary', [])).not.toThrow()
  })
})
