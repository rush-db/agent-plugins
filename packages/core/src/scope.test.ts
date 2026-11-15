import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeGitRemote, readGitRemote, resolveContextScope, resolveProjectKey } from './scope.ts'

describe('normalizeGitRemote', () => {
  it('gives the SSH and HTTPS forms of a repository the same key', () => {
    const expected = 'github.com/rush-db/agent-plugins'
    expect(normalizeGitRemote('git@github.com:rush-db/agent-plugins.git')).toBe(expected)
    expect(normalizeGitRemote('https://github.com/rush-db/agent-plugins')).toBe(expected)
    expect(normalizeGitRemote('https://user:secret@GitHub.com/rush-db/agent-plugins.git/')).toBe(expected)
    expect(normalizeGitRemote('ssh://git@github.com:22/rush-db/agent-plugins.git')).toBe(expected)
  })

  it('keeps a local path remote as it is', () => {
    expect(normalizeGitRemote('/srv/git/project.git')).toBe('/srv/git/project')
  })
})

describe('resolveContextScope', () => {
  const noRemote = async () => undefined

  it('needs a session id from the host', async () => {
    expect(await resolveContextScope({ sessionId: ' ', cwd: '/tmp', gitRemote: noRemote })).toBeNull()
  })

  it('hashes the project key and keeps the session id', async () => {
    const scope = await resolveContextScope({
      sessionId: 'session-1',
      cwd: '/work/project',
      gitRemote: async () => 'git@github.com:rush-db/agent-plugins.git'
    })
    expect(scope).toMatchObject({
      agentId: 'agent-plugins',
      profileId: 'default',
      privacyScope: 'private',
      sandboxEligible: false,
      externalSessionId: 'session-1'
    })
    expect(scope?.participantScopeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(scope)).not.toContain('/work/project')
    expect(JSON.stringify(scope)).not.toContain('github.com')
  })

  it('gives every clone of a repository the same scope, and other repositories another', async () => {
    const scope = (cwd: string, remote: string) =>
      resolveContextScope({ sessionId: 's', cwd, gitRemote: async () => remote })
    const a = await scope('/one', 'git@github.com:rush-db/agent-plugins.git')
    const b = await scope('/two', 'https://github.com/rush-db/agent-plugins')
    const c = await scope('/one', 'https://github.com/rush-db/other')
    expect(a?.participantScopeHash).toBe(b?.participantScopeHash)
    expect(a?.participantScopeHash).not.toBe(c?.participantScopeHash)
  })

  it('lets the context scope override the project', async () => {
    const one = await resolveContextScope({ sessionId: 's', cwd: '/one', contextScope: 'shared', gitRemote: noRemote })
    const two = await resolveContextScope({ sessionId: 's', cwd: '/two', contextScope: 'shared', gitRemote: noRemote })
    expect(one?.participantScopeHash).toBe(two?.participantScopeHash)
  })
})

describe('resolveProjectKey with git', () => {
  it('reads origin from a repository and falls back to the directory without one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rushdb-core-scope-'))
    expect(await readGitRemote(directory)).toBeUndefined()
    expect(await resolveProjectKey({ cwd: directory })).toMatch(/^cwd:/)

    execFileSync('git', ['init', '-q', directory])
    execFileSync('git', ['-C', directory, 'remote', 'add', 'upstream', 'https://github.com/a/upstream.git'])
    execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', 'git@github.com:a/origin.git'])
    expect(await resolveProjectKey({ cwd: directory })).toBe('git:github.com/a/origin')
  })
})
