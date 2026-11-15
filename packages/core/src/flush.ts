import { spawn } from 'node:child_process'
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RushDBAgentMemory } from '@rushdb/agent-memory-contract'
import type { Logger } from './logger.ts'
import { DurableEpisodeWriter, pendingEpisodeCount, type OutboxMemory } from './outbox.ts'
import { withTimeout } from './timeout.ts'

export const OUTBOX_DIR = 'outbox'
export const FLUSH_TIMEOUT_MS = 10_000
const LOCK_FILE = '.flush.lock'
/** A lock older than this belongs to a flush that died; the next flush takes it over. */
const STALE_LOCK_MS = 60_000

export function outboxDirectory(stateDir: string): string {
  return join(stateDir, OUTBOX_DIR)
}

async function acquireLock(directory: string): Promise<(() => Promise<void>) | null> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(String(process.pid))
      await handle.close()
      return () => unlink(path).catch(() => {})
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await stat(path).then(
        (info) => Date.now() - info.mtimeMs,
        () => STALE_LOCK_MS
      )
      if (age < STALE_LOCK_MS) return null
      await unlink(path).catch(() => {})
    }
  }
  return null
}

export interface FlushOutboxOptions {
  memory: OutboxMemory & Partial<Pick<RushDBAgentMemory, 'ensureIndexes'>>
  logger: Logger
  timeoutMs?: number
  retryDelayMs?: number
}

/**
 * Replays the outbox into RushDB within `timeoutMs`. Returns true when the outbox is empty afterwards. Only one
 * flush runs per outbox at a time; a second one returns false straight away. Never rejects; events that fail stay
 * on disk for the next flush.
 */
export async function flushOutbox(directory: string, options: FlushOutboxOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? FLUSH_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  try {
    if ((await pendingEpisodeCount(directory)) === 0) return true
    const release = await acquireLock(directory)
    if (!release) return false
    try {
      if (options.memory.ensureIndexes) {
        // At most half the budget, so a slow index check still leaves time to send events.
        await withTimeout(
          () => options.memory.ensureIndexes!(),
          Math.max(0, Math.floor((deadline - Date.now()) / 2)),
          options.logger.warn,
          'RushDB index setup'
        )
      }
      const writer = new DurableEpisodeWriter(directory, options.memory, options.logger.warn, options.retryDelayMs)
      await writer.start()
      const drained = await writer.flush(Math.max(0, deadline - Date.now()))
      await writer.stop(0)
      if (!drained) options.logger.warn(`RushDB flush stopped after ${timeoutMs} ms; events remain in the outbox`)
      return drained
    } finally {
      await release()
    }
  } catch (error) {
    options.logger.warn('RushDB flush failed', error)
    return false
  }
}

/**
 * Starts `command args` detached from this process (own process group, no stdio, unref'd) and returns at once, so
 * a hook with a tight budget can hand work to a process that outlives it. Returns false when it can't spawn.
 */
export function spawnDetached(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: options.env ?? process.env,
      cwd: options.cwd
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Runs `node <script> flush <args>` detached; the hook CLI's `flush` command calls `flushOutbox`. */
export function spawnDetachedFlush(script: string, args: string[] = [], env?: NodeJS.ProcessEnv): boolean {
  return spawnDetached(process.execPath, [script, 'flush', ...args], { env })
}
