import { open } from 'node:fs/promises'

/** Only the end of the transcript is read; the last prompt is near it. */
const TAIL_BYTES = 512 * 1024

/** Slash-command echoes and command output that Claude records as user messages. */
const NOT_A_PROMPT = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/

function partsText(parts: unknown): string {
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const value = part as { type?: unknown; text?: unknown }
      // Claude content blocks have `type: 'text'`; Gemini-style parts (Qwen) carry `text` alone.
      if (typeof value.text !== 'string') return ''
      return value.type === undefined || value.type === 'text' ? value.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** The text a user typed, or '' for tool results, meta entries, sidechains and command output. */
export function promptText(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return ''
  const line = entry as Record<string, unknown>
  if (line.isMeta === true || line.isSidechain === true || 'toolUseResult' in line) return ''
  // Qwen records injected context (such as `memory_catalog_snapshot`) as `type: 'system'` with a user-role message.
  if (typeof line.type === 'string' && line.type !== 'user') return ''
  const message = (line.message && typeof line.message === 'object' ? line.message : line) as Record<string, unknown>
  const role = message.role ?? line.type
  if (role !== 'user') return ''
  const text = partsText(message.content ?? message.parts).trim()
  return NOT_A_PROMPT.test(text) ? '' : text
}

/**
 * The last user prompt in a JSONL transcript (Claude Code, Qwen Code), or undefined. Reads the last 512 KiB only.
 * The transcript format is not a stable interface, so anything unexpected just gives undefined.
 */
export async function lastUserPrompt(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    // The first line may be cut by the tail read.
    if (size > length) lines.shift()
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim()
      if (!line) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const text = promptText(entry)
      if (text) return text
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}
