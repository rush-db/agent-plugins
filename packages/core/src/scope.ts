import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { hashScope, type MemoryScope } from '@rushdb/agent-memory-contract'

/** Every host shares one agent id, so a project's context is recalled across Claude, Codex, Gemini and the rest. */
export const DEFAULT_AGENT_ID = 'agent-plugins'
export const DEFAULT_PROFILE_ID = 'default'

export interface ContextScope extends MemoryScope {
  /** The host's session id; recall leaves this session out. */
  externalSessionId: string
}

export interface ResolveScopeOptions {
  /** Session id from host metadata, never from model output. */
  sessionId: string | undefined
  /** Working directory from host metadata. */
  cwd: string
  /** `RUSHDB_CONTEXT_SCOPE` or the `context_scope` setting: replaces the project key. */
  contextScope?: string
  agentId?: string
  profileId?: string
  /** Overrides the git lookup, for tests. */
  gitRemote?: (cwd: string) => Promise<string | undefined>
}

/**
 * A git remote reduced to `host/path`: no scheme, credentials, port, or `.git` suffix, so the SSH and HTTPS forms of
 * one repository give the same key.
 */
export function normalizeGitRemote(remote: string): string {
  const value = remote.trim()
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value)
  let host: string
  let path: string
  if (scpLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    host = scpLike[1]!
    path = scpLike[2]!
  } else {
    try {
      const url = new URL(value)
      host = url.hostname
      path = url.pathname
    } catch {
      return value.replace(/\.git$/, '').replace(/\/+$/, '')
    }
  }
  return `${host.toLowerCase()}/${path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')}`
}

/** The `origin` remote URL, else the first remote's, else undefined (not a repository, or no git). */
export function readGitRemote(cwd: string, timeoutMs = 1000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', cwd, 'config', '--get-regexp', '^remote\\..*\\.url$'],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(undefined)
          const remotes = stdout
            .split('\n')
            .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim()))
            .filter((match): match is RegExpExecArray => match !== null)
          const origin = remotes.find((match) => match[1] === 'origin') ?? remotes[0]
          resolve(origin?.[2]?.trim() || undefined)
        }
      )
    } catch {
      resolve(undefined)
    }
  })
}

/** What identifies the project before hashing: the override, the git remote, or the real path of `cwd`. */
export async function resolveProjectKey(options: Pick<ResolveScopeOptions, 'cwd' | 'contextScope' | 'gitRemote'>) {
  const override = options.contextScope?.trim()
  if (override) return `scope:${override}`
  const remote = await (options.gitRemote ?? readGitRemote)(options.cwd)
  if (remote) return `git:${normalizeGitRemote(remote)}`
  const directory = await realpath(options.cwd).catch(() => options.cwd)
  return `cwd:${directory}`
}

/**
 * The contract scope for a coding-agent session. The project key is hashed, so neither the remote nor the local
 * path is stored. Returns null without a session id.
 */
export async function resolveContextScope(options: ResolveScopeOptions): Promise<ContextScope | null> {
  const externalSessionId = options.sessionId?.trim()
  if (!externalSessionId) return null
  return {
    agentId: options.agentId ?? DEFAULT_AGENT_ID,
    profileId: options.profileId ?? DEFAULT_PROFILE_ID,
    privacyScope: 'private',
    participantScopeHash: hashScope(['project', await resolveProjectKey(options)]),
    sandboxEligible: false,
    externalSessionId
  }
}

export function memoryScope(scope: MemoryScope): MemoryScope {
  return {
    agentId: scope.agentId,
    profileId: scope.profileId,
    privacyScope: scope.privacyScope,
    participantScopeHash: scope.participantScopeHash,
    sandboxEligible: scope.sandboxEligible
  }
}
