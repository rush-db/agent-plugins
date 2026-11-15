import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256 } from '@rushdb/agent-memory-contract'

/**
 * Codex sends the prompt in `UserPromptSubmit` and the answer in `Stop`, in two hook processes. The prompt waits in
 * `<stateDir>/prompts/<session hash>.json` until `Stop` takes it.
 */
function promptPath(stateDir: string, sessionId: string): string {
  return join(stateDir, 'prompts', `${sha256(sessionId)}.json`)
}

export async function savePrompt(stateDir: string, sessionId: string, prompt: string, turnId?: string): Promise<void> {
  const path = promptPath(stateDir, sessionId)
  await mkdir(join(stateDir, 'prompts'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ prompt, turnId }), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/** The buffered prompt for this session, when its turn id matches (or either side has none). */
export async function readPrompt(stateDir: string, sessionId: string, turnId?: string): Promise<string | undefined> {
  try {
    const saved = JSON.parse(await readFile(promptPath(stateDir, sessionId), 'utf8')) as {
      prompt?: unknown
      turnId?: unknown
    }
    if (turnId && typeof saved.turnId === 'string' && saved.turnId !== turnId) return undefined
    return typeof saved.prompt === 'string' && saved.prompt.trim() ? saved.prompt : undefined
  } catch {
    return undefined
  }
}
