import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_FILE = 'hooks.log'
export const LOG_MAX_BYTES = 1024 * 1024

export interface Logger {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

export interface FileLoggerOptions {
  /** Rotate to `hooks.log.1` once the log reaches this size. */
  maxBytes?: number
  /** Values replaced by `***` wherever they appear (API keys, tokens). */
  secrets?: ReadonlyArray<string | undefined>
  now?: () => Date
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Appends lines to `<stateDir>/hooks.log`, rotating at 1 MB. Writes are synchronous so a hook that exits right
 * after logging loses nothing. The logger never throws: a log that can't be written is dropped.
 */
export function createFileLogger(stateDir: string, options: FileLoggerOptions = {}): Logger {
  const path = join(stateDir, LOG_FILE)
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const secrets = (options.secrets ?? []).filter((value): value is string => Boolean(value && value.length >= 4))
  const now = options.now ?? (() => new Date())

  const write = (level: 'info' | 'warn', message: string) => {
    try {
      let line = `${now().toISOString()} ${level} ${message.replace(/\s*\n\s*/g, ' ')}\n`
      for (const secret of secrets) line = line.split(secret).join('***')
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      try {
        if (statSync(path).size + line.length > maxBytes) renameSync(path, `${path}.1`)
      } catch {
        // no log yet
      }
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // fail open: logging is best effort
    }
  }

  return {
    info: (message) => write('info', message),
    warn: (message, error) => write('warn', error === undefined ? message : `${message}: ${describe(error)}`)
  }
}

/** A logger that drops everything, for hosts that log elsewhere and for tests. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {}
}
