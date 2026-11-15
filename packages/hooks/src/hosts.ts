export const HOSTS = ['claude', 'qwen', 'codex', 'gemini', 'agy'] as const
export type Host = (typeof HOSTS)[number]

export const COMMANDS = ['recall', 'capture', 'precompact', 'postcompact', 'end', 'flush'] as const
export type Command = (typeof COMMANDS)[number]

/** One hook call in a host-neutral form. */
export interface HookEvent {
  host: Host
  command: Command
  /** `hook_event_name` (`hookEventName` for agy) as the host sent it, such as `SessionStart`, `Stop` or `AfterAgent`. */
  eventName: string
  sessionId?: string
  cwd: string
  transcriptPath?: string
  /** The user's prompt, where the host sends it: Codex and Claude `UserPromptSubmit`, Gemini `AfterAgent`, agy `lastUserInput`. */
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
 * Gemini CLI `-p` puts hook context in front of the user's prompt as `<hook_context>…</hook_context>`, and
 * `AfterAgent.prompt` carries it back. Storing it would save recalled text again inside every new episode. Gemini
 * escapes `<` and `>` inside the block, so the first closing tag ends it.
 */
export function stripHookContext(prompt: string | undefined): string | undefined {
  return text(prompt?.replace(/<hook_context>[\s\S]*?<\/hook_context>\s*/g, ''))
}

/**
 * Maps a host's stdin to a `HookEvent`. Session id and working directory come from host metadata only: the stdin
 * fields, then the variables each host exports to hook processes.
 */
export function normalizeInput(host: Host, command: Command, raw: unknown, env: NodeJS.ProcessEnv): HookEvent {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  if (host === 'agy') return normalizeAgyInput(command, input)
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
    prompt: host === 'gemini' ? stripHookContext(text(input.prompt)) : text(input.prompt),
    assistantText: text(input.last_assistant_message) ?? text(input.prompt_response),
    compactSummary: text(input.compact_summary),
    turnId: text(input.turn_id)
  }
}

/**
 * agy sends camelCase fields (`conversationId`, `workspacePaths`, `cwd`, `transcriptPath`, `lastUserInput`,
 * `hookEventName`), as documented in agy 1.5.9. It runs hooks in the plugin folder, so `process.cwd()` is never the
 * project: the working directory comes from `cwd`, then the first workspace path. `Stop` carries no answer text.
 */
function normalizeAgyInput(command: Command, input: Record<string, unknown>): HookEvent {
  const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths : []
  return {
    host: 'agy',
    command,
    eventName: text(input.hookEventName) ?? '',
    sessionId: text(input.conversationId)?.trim(),
    cwd: text(input.cwd) ?? text(workspaces[0]) ?? process.cwd(),
    transcriptPath: text(input.transcriptPath),
    prompt: text(input.lastUserInput)
  }
}

/**
 * What the hook prints, in the host's format. `context` is recalled text, only for `recall`.
 * - Claude, Qwen and Codex add plain `SessionStart` stdout to the context.
 * - Gemini parses stdout as JSON after exit 0, so every Gemini hook prints JSON. Gemini CLI 0.68.0 reads only
 *   `hookSpecificOutput.additionalContext`; `hookEventName` follows Claude's shape and Gemini ignores it.
 * - agy expects a JSON object; recalled text goes in as an `injectSteps` system message, so it never reads as the
 *   user's own words.
 * - Codex `Stop` requires JSON; `{}` lets the turn end. Other Codex events print nothing, because plain
 *   `UserPromptSubmit` stdout would be added to the context.
 */
export function formatOutput(event: Pick<HookEvent, 'host' | 'command' | 'eventName'>, context = ''): string {
  if (event.host === 'agy') {
    if (event.command === 'recall' && context) {
      return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: context } }] })
    }
    return '{}'
  }
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
