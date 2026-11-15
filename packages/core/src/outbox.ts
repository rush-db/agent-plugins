/**
 * Durable episode outbox.
 *
 * Ported from rush-db/rushdb-openclaw-memory `src/outbox.ts` (Apache-2.0).
 * Changes from the original:
 * - `writeOutboxEvent` is split out of `enqueue`, so a short-lived hook process can append an event and leave the
 *   write to a detached flush;
 * - several processes may replay one outbox, so a file another process already sent (ENOENT) counts as done;
 * - `stop` takes the flush timeout, so a caller with a deadline can stop without waiting again;
 * - fields are declared outright instead of as constructor parameter properties.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMemoryEpisodeV1, RushDBAgentMemory } from '@rushdb/agent-memory-contract'

const EVENT_FILE = /^[a-f0-9]{64}\.json$/

export type OutboxMemory = Pick<RushDBAgentMemory, 'rememberRecent' | 'persistEpisode'>

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Writes one episode into the outbox atomically (temporary file, then rename) and returns its path. */
export async function writeOutboxEvent(directory: string, episode: AgentMemoryEpisodeV1): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = join(directory, `${episode.eventId}.json`)
  const temporary = join(directory, `.${episode.eventId}.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(episode), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
  return destination
}

/** Number of episodes waiting in the outbox; 0 when the directory doesn't exist. */
export async function pendingEpisodeCount(directory: string): Promise<number> {
  try {
    return (await readdir(directory)).filter((filename) => EVENT_FILE.test(filename)).length
  } catch {
    return 0
  }
}

export class DurableEpisodeWriter {
  private readonly directory: string
  private readonly memory: OutboxMemory
  private readonly onError: (message: string, error?: unknown) => void
  private readonly retryDelayMs: number
  private readonly pending: string[] = []
  private readonly queued = new Set<string>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private active = false
  private stopping = false

  public constructor(
    directory: string,
    memory: OutboxMemory,
    onError: (message: string, error?: unknown) => void,
    retryDelayMs = 5000
  ) {
    this.directory = directory
    this.memory = memory
    this.onError = onError
    this.retryDelayMs = retryDelayMs
  }

  public async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const filename of await readdir(this.directory)) {
      if (EVENT_FILE.test(filename)) {
        this.queuePath(join(this.directory, filename))
      }
    }
    void this.pump()
  }

  public async enqueue(episode: AgentMemoryEpisodeV1): Promise<void> {
    this.memory.rememberRecent(episode)
    const destination = await writeOutboxEvent(this.directory, episode)
    const retryTimer = this.retryTimers.get(destination)
    if (retryTimer) {
      clearTimeout(retryTimer)
      this.retryTimers.delete(destination)
    }
    this.queuePath(destination)
    void this.pump()
  }

  public async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while ((this.active || this.pending.length > 0 || this.retryTimers.size > 0) && Date.now() < deadline) {
      await delay(20)
    }
    return !this.active && this.pending.length === 0 && this.retryTimers.size === 0
  }

  public async stop(timeoutMs = 2000): Promise<void> {
    await this.flush(timeoutMs)
    this.stopping = true
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }

  private queuePath(path: string): void {
    if (this.queued.has(path)) return
    this.queued.add(path)
    this.pending.push(path)
  }

  private async pump(): Promise<void> {
    if (this.active || this.stopping) return
    this.active = true
    try {
      while (!this.stopping) {
        const path = this.pending.shift()
        if (!path) break
        try {
          let text: string
          try {
            text = await readFile(path, 'utf8')
          } catch (error) {
            if (isMissing(error)) continue
            throw error
          }
          const episode = JSON.parse(text) as AgentMemoryEpisodeV1
          await this.persistWithRetry(episode)
          await unlink(path).catch((error: unknown) => {
            if (!isMissing(error)) throw error
          })
        } catch (error) {
          this.onError(`RushDB write failed; ${path} remains in the outbox`, error)
          this.scheduleRetry(path)
        } finally {
          this.queued.delete(path)
        }
      }
    } finally {
      this.active = false
    }
  }

  private scheduleRetry(path: string): void {
    if (this.stopping || this.retryTimers.has(path)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(path)
      if (this.stopping) return
      this.queuePath(path)
      void this.pump()
    }, this.retryDelayMs)
    this.retryTimers.set(path, timer)
  }

  private async persistWithRetry(episode: AgentMemoryEpisodeV1): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.memory.persistEpisode(episode)
        return
      } catch (error) {
        lastError = error
        if (attempt < 3) await delay(250 * 2 ** attempt)
      }
    }
    throw lastError
  }
}
