import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Runs `agy plugin validate --strict . --json` and accepts its report only with zero errors and exactly the known
 * warnings below. `--strict` exits non-zero on any warning, and these three can't go away: the Gemini extension
 * (plan finding F2) and the Antigravity plugin (F6) share the repo root, agy has no ignore file, and native agy
 * plugins must keep `hooks.json` at the root. agy findings carry no code, so each entry matches the severity, the
 * file and the start of the message. Notes (no logo yet, variables that keep the plugin off until filled in) pass.
 */
export const ALLOWED_WARNINGS: ReadonlyArray<{ file: string; message: string; reason: string }> = [
  {
    file: 'GEMINI.md',
    message: 'never loaded: plugins load rules only from rules/',
    reason: 'Gemini CLI context file; agy reads the same text from rules/rushdb.md'
  },
  {
    file: 'commands',
    message: 'never loaded: plugins have no commands',
    reason: 'Gemini CLI custom commands (/rushdb:recall, /rushdb:remember, /rushdb:ask)'
  },
  {
    file: 'hooks/hooks.json',
    message: 'never loaded: plugin hook',
    reason: 'Gemini CLI hooks; agy reads its own root hooks.json'
  }
]

export interface AgyFinding {
  severity: string
  file?: string
  message: string
}

export interface AgyReport {
  findings?: AgyFinding[]
}

export function checkAgyReport(report: AgyReport): string[] {
  const errors: string[] = []
  const seen = new Set<number>()
  for (const finding of report.findings ?? []) {
    const where = `${finding.file ?? '(plugin)'}: ${finding.message}`
    if (finding.severity === 'note') continue
    if (finding.severity !== 'warning') {
      errors.push(`${finding.severity} ${where}`)
      continue
    }
    const index = ALLOWED_WARNINGS.findIndex(
      (allowed) => allowed.file === finding.file && finding.message.startsWith(allowed.message)
    )
    if (index < 0) errors.push(`unexpected warning ${where}`)
    else seen.add(index)
  }
  ALLOWED_WARNINGS.forEach((allowed, index) => {
    if (!seen.has(index)) {
      errors.push(
        `expected warning on ${allowed.file} is gone or reworded; update ALLOWED_WARNINGS in scripts/check-antigravity.ts`
      )
    }
  })
  return errors
}

/** The JSON report of `agy plugin validate --strict <dir> --json`, which exits 1 when it finds warnings. */
export async function runAgyValidate(dir: string, agy = process.env.AGY_BIN ?? 'agy'): Promise<AgyReport> {
  const run = promisify(execFile)
  let stdout: string
  try {
    stdout = (await run(agy, ['plugin', 'validate', '--strict', dir, '--json'], { maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) {
    const failed = error as { stdout?: string; code?: unknown; message: string }
    if (!failed.stdout) throw new Error(`agy plugin validate failed: ${failed.message}`)
    stdout = failed.stdout
  }
  return JSON.parse(stdout) as AgyReport
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const reportIndex = args.indexOf('--report')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const report =
    reportIndex >= 0
      ? (JSON.parse(await readFile(args[reportIndex + 1] ?? '', 'utf8')) as AgyReport)
      : await runAgyValidate(root)
  const errors = checkAgyReport(report)
  if (errors.length > 0) {
    console.error(errors.map((error) => `✗ ${error}`).join('\n'))
    process.exitCode = 1
    return
  }
  console.log('agy plugin validate: no errors; only the known Gemini-root warnings:')
  for (const allowed of ALLOWED_WARNINGS) console.log(`  ${allowed.file}: ${allowed.reason}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
