import type { AgentMemoryEpisodeV1, RushDBAgentMemory } from '@rushdb/agent-memory-contract'
import {
  buildEpisode,
  recallContext,
  resolveContextScope,
  withTimeout,
  DurableEpisodeWriter,
  type ContextScope,
  type Logger,
  type OutboxMemory
} from '@rushdb/agent-plugins-core'
import type { ClientCache } from './client.ts'
import type { Settings } from './config.ts'
import {
  createUserMessage,
  isSubagentSession,
  messageText,
  CONTEXT_SOURCE_KIND,
  type Agent,
  type PreStepDecision,
  type Session,
  type SessionEvent,
  type UserMessage
} from './host.ts'

/** Host name recorded in `provenance`, as `dsh:<event>`. */
export const HOST = 'dsh'
/** Bound on the flush when a session ends or the plugin unloads. */
export const DISPOSE_FLUSH_MS = 2000
/** Bound on the background flush that compaction starts. */
export const COMPACTION_FLUSH_MS = 10_000
/** Turn ends whose text is worth keeping; aborted, failed and blocked turns are skipped. */
const CAPTURED_REASONS = new Set(['completed', 'max-tokens'])

export interface PreStepPayload {
  agent: Pick<Agent, 'session'>
  messages: UserMessage[]
  signal: AbortSignal
}

interface TurnBuffer {
  turn: number
  userTexts: string[]
  assistantText: string
}

export interface AutoContextOptions {
  settings: Settings
  clients: ClientCache
  logger: Logger
  /** Overrides the git lookup behind the project key, for tests. */
  gitRemote?: (cwd: string) => Promise<string | undefined>
  /** Working directory for sessions whose header has none. */
  cwd?: () => string
}

function untilAborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const abort = () => resolve(null)
    signal.addEventListener('abort', abort, { once: true })
    task.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', abort)
        resolve(null)
      }
    )
  })
}

/**
 * Automatic context for dsh: recall before the first step of a turn, capture at `turn/end` through the durable
 * outbox, flushes at compaction and session end. Nothing here throws into dsh; failures are logged and the agent
 * carries on without RushDB.
 */
export class AutoContext {
  private readonly settings: Settings
  private readonly clients: ClientCache
  private readonly logger: Logger
  private readonly gitRemote?: (cwd: string) => Promise<string | undefined>
  private readonly cwd: () => string
  private readonly scopes = new Map<string, Promise<ContextScope | null>>()
  private readonly turns = new Map<string, TurnBuffer>()
  private readonly indexed = new WeakMap<RushDBAgentMemory, Promise<void>>()
  /** Sessions that received recalled context; read by the session-log upload exclusion. */
  public readonly injectedSessions = new Set<string>()
  private writer?: Promise<DurableEpisodeWriter | null>

  public constructor(options: AutoContextOptions) {
    this.settings = options.settings
    this.clients = options.clients
    this.logger = options.logger
    this.gitRemote = options.gitRemote
    this.cwd = options.cwd ?? (() => process.cwd())
  }

  public get enabled(): boolean {
    return this.settings.recall || this.settings.capture
  }

  /** Replays turns a previous run left in the outbox. Only with capture on. */
  public start(): void {
    if (this.settings.capture) void this.startWriter()
  }

  /** `agent/created`: starts the project-scope lookup for the session, so the first recall doesn't wait for git. */
  public prepare(session: Pick<Session, 'id' | 'header'>): void {
    if (!this.skips(session)) void this.scopeFor(session)
  }

  private skips(session: Pick<Session, 'header'>): boolean {
    return !this.settings.includeSubagents && isSubagentSession(session)
  }

  private scopeFor(session: Pick<Session, 'id' | 'header'>): Promise<ContextScope | null> {
    let scope = this.scopes.get(session.id)
    if (!scope) {
      scope = resolveContextScope({
        sessionId: session.id,
        cwd: session.header.cwd ?? this.cwd(),
        contextScope: this.settings.contextScope,
        profileId: this.settings.profileId,
        gitRemote: this.gitRemote
      }).catch((error: unknown) => {
        this.logger.warn('RushDB scope failed', error)
        return null
      })
      this.scopes.set(session.id, scope)
    }
    return scope
  }

  /** Creates the RushDB indexes once per client; a failure is logged and retried on the next write. */
  private ensureIndexes(memory: RushDBAgentMemory): Promise<void> {
    let pending = this.indexed.get(memory)
    if (!pending) {
      pending = memory.ensureIndexes().catch((error: unknown) => {
        this.indexed.delete(memory)
        this.logger.warn('RushDB index setup failed', error)
      })
      this.indexed.set(memory, pending)
    }
    return pending
  }

  /**
   * `agent/pre-step`: lets the rest of the chain decide, then puts one `rushdb-context` message with recalled
   * context in front of the user's prompt. Returns the chain's decision unchanged when recall is off, the step has
   * no prompt (a continuation step), nothing is found, or anything fails or runs past `recallTimeoutMs`.
   */
  public async preStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const decision = await next()
    if (!this.settings.recall) return decision
    try {
      if (decision.kind !== 'enter' || payload.signal.aborted) return decision
      const session = payload.agent.session
      if (this.skips(session)) return decision
      const position = decision.messages.findIndex((message) => message.source.kind === 'user')
      if (position < 0) return decision
      const query = decision.messages
        .filter((message) => message.source.kind === 'user')
        .map(messageText)
        .join('\n')
        .trim()
      if (query.length < this.settings.recallMinChars) return decision

      const recall = async () => {
        const [client, scope] = await Promise.all([this.clients.get(), this.scopeFor(session)])
        if (!scope) return ''
        return recallContext(client.memory, scope, {
          query,
          limit: this.settings.recallLimit,
          timeoutMs: this.settings.recallTimeoutMs,
          onError: this.logger.warn
        })
      }
      const text = await untilAborted(
        withTimeout(recall, this.settings.recallTimeoutMs, this.logger.warn, 'RushDB recall'),
        payload.signal
      )
      if (!text || payload.signal.aborted) return decision
      const context = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: CONTEXT_SOURCE_KIND, form: 'recall' }
      })
      this.injectedSessions.add(session.id)
      return {
        ...decision,
        messages: [...decision.messages.slice(0, position), context, ...decision.messages.slice(position)]
      }
    } catch (error) {
      this.logger.warn('RushDB recall failed', error)
      return decision
    }
  }

  /** `session/event`: buffers the turn's prompt and answer, stores the pair at `turn/end`, flushes at compaction. */
  public onSessionEvent(session: Pick<Session, 'id' | 'header'>, event: SessionEvent): void {
    try {
      if (!this.settings.capture || this.skips(session)) return
      switch (event.type) {
        case 'turn/start':
          this.turns.set(session.id, { turn: event.data.turn, userTexts: [], assistantText: '' })
          return
        case 'user/message': {
          if (event.data.source.kind !== 'user') return
          const text = messageText(event.data).trim()
          if (text) this.bufferFor(session.id).userTexts.push(text)
          return
        }
        case 'assistant/message': {
          const text = messageText(event.data.message).trim()
          if (text) this.bufferFor(session.id).assistantText = text
          return
        }
        case 'turn/end': {
          const buffer = this.turns.get(session.id)
          this.turns.delete(session.id)
          if (!buffer || !CAPTURED_REASONS.has(event.data.reason.kind)) return
          void this.capture(session, event.data.turn, buffer)
          return
        }
        case 'compaction/start':
          void this.flush(COMPACTION_FLUSH_MS)
          return
        default:
          return
      }
    } catch (error) {
      this.logger.warn('RushDB capture failed', error)
    }
  }

  private bufferFor(sessionId: string): TurnBuffer {
    let buffer = this.turns.get(sessionId)
    if (!buffer) {
      buffer = { turn: -1, userTexts: [], assistantText: '' }
      this.turns.set(sessionId, buffer)
    }
    return buffer
  }

  /** The episode for one finished turn, or null when either side is empty. */
  public async episodeFor(
    session: Pick<Session, 'id' | 'header'>,
    turn: number,
    buffer: Pick<TurnBuffer, 'userTexts' | 'assistantText'>
  ): Promise<AgentMemoryEpisodeV1 | null> {
    const scope = await this.scopeFor(session)
    if (!scope) return null
    return buildEpisode({
      scope,
      turnIndex: turn,
      userText: buffer.userTexts.join('\n'),
      assistantText: buffer.assistantText,
      host: HOST,
      event: 'turn_end'
    })
  }

  private async capture(session: Pick<Session, 'id' | 'header'>, turn: number, buffer: TurnBuffer): Promise<void> {
    try {
      const episode = await this.episodeFor(session, turn, buffer)
      if (!episode) return
      const writer = await this.startWriter()
      await writer?.enqueue(episode)
    } catch (error) {
      this.logger.warn('RushDB capture failed', error)
    }
  }

  private startWriter(): Promise<DurableEpisodeWriter | null> {
    if (!this.writer) {
      const memory: OutboxMemory = {
        rememberRecent: (episode) =>
          this.clients.peekMemory()?.rememberRecent(episode) ?? (episode as AgentMemoryEpisodeV1),
        persistEpisode: async (episode) => {
          const { memory } = await this.clients.get()
          await this.ensureIndexes(memory)
          return memory.persistEpisode(episode)
        }
      }
      const writer = new DurableEpisodeWriter(this.settings.outboxDirectory, memory, this.logger.warn)
      this.writer = writer.start().then(
        () => writer,
        (error: unknown) => {
          this.logger.warn('RushDB outbox unavailable; turns are not captured', error)
          return null
        }
      )
    }
    return this.writer
  }

  /** Waits up to `timeoutMs` for the outbox to drain. Never rejects. */
  public async flush(timeoutMs: number): Promise<boolean> {
    if (!this.writer) return true
    const writer = await this.writer
    if (!writer) return false
    const drained = await writer.flush(timeoutMs).catch(() => false)
    if (!drained) this.logger.warn(`RushDB flush stopped after ${timeoutMs} ms; turns remain in the outbox`)
    return drained
  }

  /** `agent/disposed` and `session/disposed`: forgets the session and flushes in the background. */
  public onSessionGone(sessionId: string): void {
    this.turns.delete(sessionId)
    this.scopes.delete(sessionId)
    this.injectedSessions.delete(sessionId)
    void this.flush(DISPOSE_FLUSH_MS)
  }

  /** Plugin unload: a flush bounded by `DISPOSE_FLUSH_MS`, then the writer stops. Never rejects. */
  public async dispose(): Promise<void> {
    if (!this.writer) return
    const writer = await withTimeout(this.writer, DISPOSE_FLUSH_MS)
    await writer?.stop(DISPOSE_FLUSH_MS).catch(() => {})
  }
}
