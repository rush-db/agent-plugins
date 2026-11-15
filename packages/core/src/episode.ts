import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boundedText, createEpisodeEvent, sha256, type AgentMemoryEpisodeV1 } from '@rushdb/agent-memory-contract'
import { memoryScope, type ContextScope } from './scope.ts'

export interface EpisodeInput {
  scope: ContextScope
  turnIndex: number
  userText: string
  assistantText: string
  /** Host name, such as `claude` or `codex`; recorded in `provenance`. */
  host: string
  /** Hook event that captured the turn, such as `Stop`; recorded in `provenance`. */
  event: string
  observedAt?: string
}

/**
 * One finished turn as a contract episode, or null when either side is empty. The texts are bounded per the
 * contract, and `sourceEventId` is `<session>:<turn>`, so the same turn always gets the same `eventId`.
 */
export function buildEpisode(input: EpisodeInput): AgentMemoryEpisodeV1 | null {
  const userText = boundedText(input.userText)
  const assistantText = boundedText(input.assistantText)
  if (!userText || !assistantText) return null
  const externalSessionId = input.scope.externalSessionId
  return createEpisodeEvent({
    ...memoryScope(input.scope),
    runtime: 'custom',
    externalSessionId,
    sourceEventId: `${externalSessionId}:${input.turnIndex}`,
    turnIndex: input.turnIndex,
    userText,
    assistantText,
    summary: boundedText(`User: ${userText}\nAssistant: ${assistantText}`),
    conversationKind: 'local',
    visibility: 'participant',
    trustClass: 'mixed',
    originClass: 'conversation',
    observedAt: input.observedAt ?? new Date().toISOString(),
    provenance: `${input.host}:${input.event}`
  })
}

interface TurnState {
  next: number
  last?: { fingerprint: string; turnIndex: number }
}

/**
 * The turn index for a session whose host doesn't number turns. Kept in `<stateDir>/sessions/`; a hook that fires
 * twice for the same pair of texts gets the same index back, so the episode keeps its id.
 */
export async function claimTurnIndex(
  stateDir: string,
  sessionId: string,
  userText: string,
  assistantText: string
): Promise<number> {
  const directory = join(stateDir, 'sessions')
  const path = join(directory, `${sha256(sessionId)}.json`)
  const fingerprint = sha256(`${userText}\u001f${assistantText}`)
  let state: TurnState = { next: 0 }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as TurnState
    if (Number.isInteger(parsed.next) && parsed.next >= 0) state = parsed
  } catch {
    // first turn of the session
  }
  if (state.last?.fingerprint === fingerprint) return state.last.turnIndex
  const turnIndex = state.next
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify({ next: turnIndex + 1, last: { fingerprint, turnIndex } }), {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(temporary, path)
  return turnIndex
}
