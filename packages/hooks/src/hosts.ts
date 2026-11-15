export const HOSTS = ['claude', 'qwen', 'codex', 'gemini'] as const
export type Host = (typeof HOSTS)[number]

export const COMMANDS = ['recall', 'capture', 'precompact', 'postcompact', 'end', 'flush'] as const
export type Command = (typeof COMMANDS)[number]

/** One hook call in a host-neutral form. */
export interface HookEvent {
  host: Host
  command: Command
  /** `hook_event_name` as the host sent it, such as `SessionStart`, `Stop` or `AfterAgent`. */
  eventName: string
  sessionId?: string
  cwd: string
  transcriptPath?: string
  /** The user's prompt, where the host sends it: Codex and Claude `UserPromptSubmit`, Gemini `AfterAgent`. */
  prompt?: string
  /** The finished answer: `Stop.last_assistant_message` (Claude, Qwen, Codex) or `AfterAgent.prompt_response`. */
  assistantText?: string
  /** `PostCompact.compact_summary` (Claude, Qwen). */
  compactSummary?: string
  turnId?: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Maps a host's stdin to a `HookEvent`. Session id and working directory come from host metadata only: the stdin
 * fields, then the variables each host exports to hook processes.
 */
export function normalizeInput(host: Host, command: Command, raw: unknown, env: NodeJS.ProcessEnv): HookEvent {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const sessionEnv = host === 'gemini' ? env.GEMINI_SESSION_ID : host === 'qwen' ? env.QWEN_CODE_SESSION_ID : undefined
  const cwdEnv =
    host === 'gemini'
      ? (env.GEMINI_CWD ?? env.GEMINI_PROJECT_DIR)
      : host === 'qwen'
        ? (env.QWEN_PROJECT_DIR ?? env.CLAUDE_PROJECT_DIR)
        : env.CLAUDE_PROJECT_DIR
  return {
    host,
    command,
    eventName: text(input.hook_event_name) ?? '',
    sessionId: text(input.session_id)?.trim() ?? text(sessionEnv)?.trim(),
    cwd: text(input.cwd) ?? text(cwdEnv) ?? process.cwd(),
    transcriptPath: text(input.transcript_path),
    prompt: text(input.prompt),
    assistantText: text(input.last_assistant_message) ?? text(input.prompt_response),
    compactSummary: text(input.compact_summary),
    turnId: text(input.turn_id)
  }
}

/**
 * What the hook prints, in the host's format. `context` is recalled text, only for `recall`.
 * - Claude, Qwen and Codex add plain `SessionStart` stdout to the context.
 * - Gemini parses stdout as JSON after exit 0, so every Gemini hook prints JSON.
 * - Codex `Stop` requires JSON; `{}` lets the turn end. Other Codex events print nothing, because plain
 *   `UserPromptSubmit` stdout would be added to the context.
 */
export function formatOutput(event: Pick<HookEvent, 'host' | 'command' | 'eventName'>, context = ''): string {
  if (event.host === 'gemini') {
    if (event.command === 'recall' && context) {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: event.eventName || 'SessionStart', additionalContext: context }
      })
    }
    return '{}'
  }
  if (event.command === 'recall') return context
  if (event.host === 'codex' && event.eventName === 'Stop') return '{}'
  return ''
}
