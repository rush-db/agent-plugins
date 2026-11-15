/**
 * RushDB for DeepSeek Harness, a native Cordis plugin.
 *
 * - Always: the model tools `rushdb_search`, `rushdb_query`, `rushdb_aggregate` and `rushdb_remember`. They reach
 *   the network only when the model calls them.
 * - Optional, off by default: automatic context. `autoContext.recall` adds context from earlier sessions before the
 *   first step of each turn; `autoContext.capture` stores each finished turn through a durable outbox. With both off,
 *   the plugin registers no listeners, makes no network calls and writes no files.
 *
 * Keys are read by credential name (`RUSHDB_API_KEY` by default), never from the config itself.
 */
import { ClientCache } from './client.ts'
import { Config, resolveSettings } from './config.ts'
import { AutoContext } from './context.ts'
import { secretSource, type Context } from './host.ts'
import { createTools } from './tools.ts'
import type { Logger } from '@rushdb/agent-plugins-core'

export { Config }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rushdb'

/** `credentials` is optional: without a credential store (the headless profile), keys come from the launch environment. */
export const inject = ['tools', 'agents', 'sessions']

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** dsh's logger, with every known credential masked. */
function createLogger(ctx: Context, secrets: () => string[]): Logger {
  const mask = (line: string) => {
    for (const secret of secrets()) if (secret.length >= 4) line = line.split(secret).join('***')
    return line
  }
  return {
    info: (message) => ctx.logger.info(mask(`rushdb: ${message}`)),
    warn: (message, error) =>
      ctx.logger.warn(mask(`rushdb: ${error === undefined ? message : `${message}: ${describe(error)}`}`))
  }
}

export function apply(ctx: Context, config: Config): void {
  const settings = resolveSettings(config)
  const clients = new ClientCache(settings, secretSource(ctx))
  const logger = createLogger(ctx, () => clients.secrets())

  for (const tool of createTools({ settings, clients })) ctx.tools.register(tool)

  const auto = new AutoContext({ settings, clients, logger })
  if (!auto.enabled) return

  ctx.on('agent/created', ({ agent }) => {
    auto.prepare(agent.session)
    return undefined
  })
  ctx.on('agent/pre-step', (payload, next) => auto.preStep(payload, next))
  ctx.on('session/event', (session, event) => auto.onSessionEvent(session, event))
  ctx.on('agent/disposed', ({ agent }) => auto.onSessionGone(agent.id))
  ctx.on('session/disposed', (session) => auto.onSessionGone(session.id))

  if (settings.excludeFromLogUpload) {
    // Only when the base bundle's session-log upload is loaded; a whole session is the smallest unit it can skip.
    ctx.inject(['sessionLogDeepSeek'], (child) => {
      void child.sessionLogDeepSeek.registerExclusion((request) => auto.injectedSessions.has(request.sessionId))
    })
  }

  ctx.effect(() => {
    auto.start()
    return () => auto.dispose()
  }, 'rushdb.autoContext')
}
