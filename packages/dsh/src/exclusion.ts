/**
 * `excludeFromLogUpload`: no session-log upload to DeepSeek carries RushDB context.
 *
 * dsh uploads a session's log incrementally and lets a plugin skip a whole upload request, not single messages, so a
 * request that isn't skipped carries every event since the last accepted upload. From a session's first RushDB context
 * on, every upload request of that session is skipped; uploads accepted before it have already gone out, and sessions
 * without RushDB context are unaffected. The decision therefore comes from the
 * session's own log, not from this process's memory: a session projection folds the log, its fork-inherited prefix
 * included, and dsh rebuilds it on resume. A resumed session, one that continues under a new agent, and a subagent
 * seeded from a session with RushDB context are all skipped.
 */
import { CONTEXT_SOURCE_KIND, type Context, type ProjectionDefinition, type Session } from './host.ts'

export const CONTEXT_PROJECTION_KEY = 'rushdbContext'

export interface ContextProjectionState {
  /** The log has a `rushdb-context` message. */
  readonly received: boolean
}

const NOT_RECEIVED: ContextProjectionState = Object.freeze({ received: false })
const RECEIVED: ContextProjectionState = Object.freeze({ received: true })

export const contextProjection: ProjectionDefinition<typeof CONTEXT_PROJECTION_KEY, ContextProjectionState> = {
  key: CONTEXT_PROJECTION_KEY,
  stateVersion: 1,
  // dsh only calls `parse` (on a persisted checkpoint); a zod dependency for one boolean isn't worth it.
  stateSchema: {
    parse(value: unknown): ContextProjectionState {
      if (value && typeof value === 'object' && typeof (value as { received?: unknown }).received === 'boolean') {
        return (value as ContextProjectionState).received ? RECEIVED : NOT_RECEIVED
      }
      throw new Error('rushdbContext projection: expected { received: boolean }')
    }
  } as unknown as ProjectionDefinition<typeof CONTEXT_PROJECTION_KEY, ContextProjectionState>['stateSchema'],
  init: () => NOT_RECEIVED,
  apply: (state, event) =>
    state.received || event.type !== 'user/message' || event.data.source.kind !== CONTEXT_SOURCE_KIND ? state : RECEIVED
}

/**
 * Registers the exclusion when the profile loads the session-log upload. `injected` lists sessions this process
 * injected into, which answers before the projection has seen the message.
 */
export function excludeContextSessions(ctx: Context, injected: ReadonlySet<string>): void {
  ctx.inject(['sessionLogDeepSeek', 'sessionProjections', 'sessions'], async (child) => {
    const projection = await child.sessionProjections.register(contextProjection)
    void child.sessionLogDeepSeek.registerExclusion((request) => {
      if (injected.has(request.sessionId)) return true
      const session: Session | undefined = child.sessions.get(request.sessionId)
      return session !== undefined && projection.stateOf(session).received
    })
  })
}
