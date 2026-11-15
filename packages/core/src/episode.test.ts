import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEpisode, claimTurnIndex } from './episode.ts'
import type { ContextScope } from './scope.ts'

const scope: ContextScope = {
  agentId: 'agent-plugins',
  profileId: 'default',
  privacyScope: 'private',
  participantScopeHash: 'a'.repeat(64),
  sandboxEligible: false,
  externalSessionId: 'session-1'
}

const turn = {
  scope,
  turnIndex: 3,
  userText: 'Use pnpm for this repo',
  assistantText: 'Noted: pnpm only.',
  host: 'claude',
  event: 'Stop',
  observedAt: '2026-11-15T10:00:00.000Z'
}

describe('buildEpisode', () => {
  it('builds a contract episode with sourceEventId <session>:<turn>', () => {
    const episode = buildEpisode(turn)
    expect(episode).toMatchObject({
      schemaVersion: 1,
      eventType: 'episode',
      runtime: 'custom',
      externalSessionId: 'session-1',
      sourceEventId: 'session-1:3',
      turnIndex: 3,
      summary: 'User: Use pnpm for this repo\nAssistant: Noted: pnpm only.',
      provenance: 'claude:Stop'
    })
    expect(episode?.eventId).toMatch(/^[a-f0-9]{64}$/)
  })

  it('gives the same turn the same id, and another turn another id', () => {
    const first = buildEpisode(turn)!
    expect(buildEpisode({ ...turn, observedAt: '2026-11-16T00:00:00.000Z' })!.eventId).toBe(first.eventId)
    expect(buildEpisode({ ...turn, turnIndex: 4 })!.eventId).not.toBe(first.eventId)
    expect(buildEpisode({ ...turn, scope: { ...scope, externalSessionId: 'session-2' } })!.eventId).not.toBe(
      first.eventId
    )
  })

  it('bounds the captured text and skips empty turns', () => {
    const episode = buildEpisode({ ...turn, userText: 'x'.repeat(10_000) })!
    expect(episode.userText.length).toBe(6001)
    expect(buildEpisode({ ...turn, assistantText: '  ' })).toBeNull()
  })

  it('keeps extra scope fields out of the event', () => {
    const episode = buildEpisode({ ...turn, scope: { ...scope, cwd: '/home/me/secret' } as ContextScope })!
    expect(JSON.stringify(episode)).not.toContain('/home/me/secret')
  })
})

describe('claimTurnIndex', () => {
  it('numbers turns per session and gives a repeated turn its index back', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'rushdb-core-turns-'))
    expect(await claimTurnIndex(stateDir, 's1', 'q1', 'a1')).toBe(0)
    expect(await claimTurnIndex(stateDir, 's1', 'q1', 'a1')).toBe(0)
    expect(await claimTurnIndex(stateDir, 's1', 'q2', 'a2')).toBe(1)
    expect(await claimTurnIndex(stateDir, 's2', 'q1', 'a1')).toBe(0)
  })
})
