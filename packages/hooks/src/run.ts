import { homedir } from 'node:os'
import {
  buildEpisode,
  claimTurnIndex,
  createFileLogger,
  failOpen,
  flushOutbox,
  outboxDirectory,
  pendingEpisodeCount,
  recallContext,
  resolveConfig,
  resolveContextScope,
  writeOutboxEvent,
  FLUSH_TIMEOUT_MS,
  type Logger,
  type OutboxMemory,
  type ResolvedConfig
} from '@rushdb/agent-plugins-core'
import type { RushDBAgentMemory, RushDBMemoryClientOptions } from '@rushdb/agent-memory-contract'
import { formatOutput, normalizeInput, type Command, type HookEvent, type Host } from './hosts.ts'
import { createMemory } from './memory.ts'
import { readPrompt, savePrompt } from './prompts.ts'
import { lastUserPrompt } from './transcript.ts'

/** `PreCompact` runs synchronously before compaction; it gets most of its 30 s hook timeout. */
export const PRECOMPACT_FLUSH_MS = 20_000
/** Stands in for the user's side of an episode that stores a compaction summary. */
export const COMPACTION_PROMPT = 'Summary of the conversation so far, written when the context was compacted.'

type Memory = Pick<RushDBAgentMemory, 'recall'> & OutboxMemory & Partial<Pick<RushDBAgentMemory, 'ensureIndexes'>>
type EnabledConfig = Extract<ResolvedConfig, { status: 'enabled' }>

export interface RunOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  /** Starts `rushdb-hooks.mjs flush` detached; returns false when it can't. */
  spawnFlush: (event: HookEvent) => boolean
  createMemory?: (connection: RushDBMemoryClientOptions, logger: Logger) => Memory
  gitRemote?: (cwd: string) => Promise<string | undefined>
}

/**
 * Runs one hook and returns what to print. Never rejects: every failure is logged to `hooks.log` and the host gets
 * its empty answer. With automatic context `off` nothing is read beyond the switch, and nothing is written or sent.
 */
export async function runHook(command: Command, host: Host, raw: unknown, options: RunOptions): Promise<string> {
  const env = options.env ?? process.env
  const event = normalizeInput(host, command, raw, env)
  const empty = formatOutput(event)
  let config: ResolvedConfig
  try {
    config = resolveConfig({ env, homeDir: options.homeDir ?? homedir() })
  } catch {
    return empty
  }
  if (config.status === 'off') return empty

  const logger = createFileLogger(config.stateDir, {
    secrets: config.status === 'enabled' ? config.secrets : []
  })
  for (const warning of config.warnings) logger.warn(warning)
  if (config.status === 'disabled') {
    logger.warn(config.reason)
    return empty
  }
  return failOpen(() => runEnabled(event, config, logger, options), empty, logger.warn, `RushDB ${command} hook`)
}

async function runEnabled(event: HookEvent, config: EnabledConfig, logger: Logger, options: RunOptions) {
  const empty = formatOutput(event)
  const persist = config.autoContext === 'recall+persist'
  const outbox = outboxDirectory(config.stateDir)
  const memory = () => (options.createMemory ?? createMemory)(config.connection, logger) as Memory
  const scope = () =>
    resolveContextScope({
      sessionId: event.sessionId,
      cwd: event.cwd,
      contextScope: config.contextScope,
      gitRemote: options.gitRemote
    })
  const spawnFlush = () => {
    if (!options.spawnFlush(event)) logger.warn('RushDB flush could not be started')
  }

  switch (event.command) {
    case 'flush': {
      await flushOutbox(outbox, { memory: memory(), logger, timeoutMs: FLUSH_TIMEOUT_MS })
      return empty
    }

    case 'recall': {
      // Any hook run first replays what earlier runs left behind, in the background.
      if (persist && (await pendingEpisodeCount(outbox)) > 0) spawnFlush()
      const contextScope = await scope()
      if (!contextScope) return empty
      const context = await recallContext(memory(), contextScope, { onError: logger.warn })
      return formatOutput(event, context)
    }

    case 'capture': {
      if (!persist || !event.sessionId) return empty
      if (event.eventName === 'UserPromptSubmit') {
        if (event.prompt) await savePrompt(config.stateDir, event.sessionId, event.prompt, event.turnId)
        return empty
      }
      const userText =
        event.prompt ??
        (await readPrompt(config.stateDir, event.sessionId, event.turnId)) ??
        (await lastUserPrompt(event.transcriptPath))
      if (!userText || !event.assistantText) {
        logger.info(`RushDB capture skipped a ${event.host} ${event.eventName || 'turn'}: no prompt or no answer`)
        return empty
      }
      await enqueue(event, config, userText, event.assistantText, scope)
      spawnFlush()
      return empty
    }

    case 'postcompact': {
      if (!persist || !event.compactSummary) return empty
      await enqueue(event, config, COMPACTION_PROMPT, event.compactSummary, scope)
      spawnFlush()
      return empty
    }

    case 'precompact': {
      if (!persist) return empty
      await flushOutbox(outbox, { memory: memory(), logger, timeoutMs: PRECOMPACT_FLUSH_MS })
      return empty
    }

    case 'end': {
      // The host gives SessionEnd a second or less: hand the flush to a detached process and return.
      if (persist && (await pendingEpisodeCount(outbox)) > 0) spawnFlush()
      return empty
    }
  }
}

async function enqueue(
  event: HookEvent,
  config: EnabledConfig,
  userText: string,
  assistantText: string,
  scope: () => ReturnType<typeof resolveContextScope>
): Promise<void> {
  const contextScope = await scope()
  if (!contextScope) return
  const turnIndex = await claimTurnIndex(config.stateDir, contextScope.externalSessionId, userText, assistantText)
  const episode = buildEpisode({
    scope: contextScope,
    turnIndex,
    userText,
    assistantText,
    host: event.host,
    event: event.eventName || event.command
  })
  if (episode) await writeOutboxEvent(outboxDirectory(config.stateDir), episode)
}
