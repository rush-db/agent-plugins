/**
 * Everything this bundle takes from DeepSeek Harness, in one module: dsh is pre-1.0 and its APIs change between
 * release candidates, so an upgrade touches this file first. The rest of the bundle imports from here.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-log-deepseek'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export { default as z } from '@deepseek-ai/schemastery'
export { createUserMessage } from '@deepseek-ai/dsh-llm'
export { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
export type { Agent, Context, PreStepDecision, ProjectionDefinition, Session, SessionEvent, UserMessage }

/** Source kind of the message that carries recalled context, so it never reads as something the user typed. */
export const CONTEXT_SOURCE_KIND = 'rushdb-context'

export interface RushDBContextSource {
  readonly kind: typeof CONTEXT_SOURCE_KIND
  /** Material lifted out of earlier sessions. */
  readonly form: 'recall'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'rushdb-context': RushDBContextSource & ContextFormed
  }
}

/** Reads a secret by credential name; undefined when it isn't set. */
export interface SecretSource {
  resolve(name: string): Promise<string | undefined>
}

/**
 * Secrets through `ctx.credentials` (the environment, `$DSH_HOME/.credentials.yaml`, then `.env` files) when the
 * profile loads a credential store, else the launch environment, as dsh's own adapters do: the headless profile
 * disables the store and uses launch-time credentials.
 */
export function secretSource(ctx: Context): SecretSource {
  return {
    async resolve(name) {
      const ref = credentialRef(name)
      const credentials = ctx.get('credentials')
      const value = credentials ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value
      return value?.trim() || undefined
    }
  }
}

/** Plain text of a message's text blocks. */
export function messageText(message: { readonly content: ReadonlyArray<unknown> } | undefined): string {
  if (!message) return ''
  return message.content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''
    )
    .filter(Boolean)
    .join('\n')
}

/** True for a session a subagent runs in. */
export function isSubagentSession(session: Pick<Session, 'header'>): boolean {
  return session.header.origin === 'subagent'
}
