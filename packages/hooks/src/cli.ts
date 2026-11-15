import { resolve } from 'node:path'
import { spawnDetachedFlush } from '@rushdb/agent-plugins-core'
import { COMMANDS, HOSTS, formatOutput, type Command, type Host } from './hosts.ts'
import { runHook, type RunOptions } from './run.ts'

export const USAGE = `usage: node rushdb-hooks.mjs <${COMMANDS.join('|')}> --host <${HOSTS.join('|')}>`

/**
 * How long each command may run before the CLI prints the host's empty answer and exits. Each sits under the
 * host's hook timeout: Claude SessionStart 10 s, PreCompact 30 s, Codex SessionEnd 1 s.
 */
export const BUDGET_MS: Record<Command, number> = {
  recall: 8_000,
  capture: 25_000,
  precompact: 28_000,
  postcompact: 10_000,
  end: 500,
  flush: 15_000
}

const STDIN_LIMIT = 4 * 1024 * 1024
const STDIN_TIMEOUT_MS = 2_000

export function parseArgs(argv: string[]): { command: Command; host: Host } | null {
  const [command, ...rest] = argv
  const hostIndex = rest.indexOf('--host')
  const host = hostIndex >= 0 ? rest[hostIndex + 1] : rest.find((arg) => arg.startsWith('--host='))?.slice(7)
  if (!(COMMANDS as ReadonlyArray<string>).includes(command ?? '')) return null
  if (!(HOSTS as ReadonlyArray<string>).includes(host ?? '')) return null
  return { command: command as Command, host: host as Host }
}

/** The JSON object on stdin, or undefined (no stdin, a terminal, too large, not JSON, or slower than 2 s). */
export function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<unknown> {
  if (stream.isTTY) return Promise.resolve(undefined)
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    const done = (value: unknown) => {
      clearTimeout(timer)
      stream.removeAllListeners('data')
      stream.removeAllListeners('end')
      stream.removeAllListeners('error')
      stream.pause()
      resolvePromise(value)
    }
    const timer = setTimeout(() => done(undefined), STDIN_TIMEOUT_MS)
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > STDIN_LIMIT) return done(undefined)
      chunks.push(chunk)
    })
    stream.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        done(text ? JSON.parse(text) : undefined)
      } catch {
        done(undefined)
      }
    })
    stream.on('error', () => done(undefined))
  })
}

function finish(output: string): never {
  // Exit explicitly: a request to an unreachable RushDB keeps the event loop alive after its timeout.
  if (output) process.stdout.write(output, () => process.exit(0))
  else process.exit(0)
  // process.exit after the write callback; keep the type checker satisfied meanwhile.
  return undefined as never
}

export async function main(argv = process.argv.slice(2), options: Partial<RunOptions> = {}): Promise<void> {
  const args = parseArgs(argv)
  if (!args) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(0)
  }
  const { command, host } = args
  let settled = false
  let fallback = formatOutput({ host, command, eventName: '' })
  const watchdog = setTimeout(() => {
    if (settled) return
    settled = true
    finish(fallback)
  }, BUDGET_MS[command])

  const script = resolve(process.argv[1] ?? '')
  let output = fallback
  try {
    const raw = command === 'flush' ? undefined : await readStdin()
    const eventName = (raw as { hook_event_name?: unknown } | undefined)?.hook_event_name
    if (typeof eventName === 'string') fallback = output = formatOutput({ host, command, eventName })
    output = await runHook(command, host, raw, {
      spawnFlush: () => spawnDetachedFlush(script, ['--host', host]),
      ...options
    })
  } catch {
    // runHook never rejects; this is the last line of fail-open
  }
  if (settled) return
  settled = true
  clearTimeout(watchdog)
  finish(output)
}
