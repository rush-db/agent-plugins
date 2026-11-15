import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileLogger } from './logger.ts'
import { failOpen } from './timeout.ts'

describe('createFileLogger', () => {
  it('appends to hooks.log and masks secrets', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'rushdb-core-log-'))
    const logger = createFileLogger(stateDir, { secrets: ['sk-secret-key'], now: () => new Date(0) })
    logger.warn('request failed', new Error('401 for sk-secret-key\nretry later'))
    logger.info('started')
    expect(await readFile(join(stateDir, 'hooks.log'), 'utf8')).toBe(
      '1970-01-01T00:00:00.000Z warn request failed: 401 for *** retry later\n1970-01-01T00:00:00.000Z info started\n'
    )
  })

  it('rotates once the log reaches the limit', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'rushdb-core-log-'))
    await writeFile(join(stateDir, 'hooks.log'), 'x'.repeat(90))
    createFileLogger(stateDir, { maxBytes: 100 }).warn('this line does not fit')
    expect(await readFile(join(stateDir, 'hooks.log.1'), 'utf8')).toBe('x'.repeat(90))
    expect(await readFile(join(stateDir, 'hooks.log'), 'utf8')).toMatch(/this line does not fit\n$/)
  })

  it('never throws when the log cannot be written', async () => {
    // A regular file as the parent makes mkdir fail at once (ENOTDIR). Avoid /proc paths: recursive
    // mkdirSync never returns for them on Linux.
    const file = join(await mkdtemp(join(tmpdir(), 'rushdb-core-log-')), 'not-a-directory')
    await writeFile(file, '')
    const logger = createFileLogger(join(file, 'state'))
    expect(() => logger.warn('dropped')).not.toThrow()
  })
})

describe('failOpen', () => {
  it('returns the fallback and reports the error', async () => {
    const errors: unknown[] = []
    const value = await failOpen(
      () => {
        throw new Error('boom')
      },
      'fallback',
      (_message, error) => errors.push(error)
    )
    expect(value).toBe('fallback')
    expect(errors).toHaveLength(1)
  })

  it('survives a logger that throws', async () => {
    const value = await failOpen(
      async () => Promise.reject(new Error('boom')),
      0,
      () => {
        throw new Error('logger broke')
      }
    )
    expect(value).toBe(0)
  })
})
