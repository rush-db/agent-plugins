import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeRushDB, type FakeRushDB } from '../test/helpers.ts'
import { createMemory } from './memory.ts'

let server: FakeRushDB | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const scope = {
  agentId: 'agent-plugins',
  profileId: 'default',
  privacyScope: 'private' as const,
  participantScopeHash: 'c'.repeat(64),
  sandboxEligible: false,
  query: 'anything'
}

describe('createMemory', () => {
  it('sends requests to the configured API URL, not to RushDB Cloud', async () => {
    server = await fakeRushDB('ok')
    const memory = createMemory({ apiKey: 'test-key', url: server.url }, { info: vi.fn(), warn: vi.fn() })
    await memory.recall(scope)
    expect(server.requests.map((request) => request.path)).toContain('/api/v1/ai/search')
  })

  it('logs failed recall searches that the contract would drop', async () => {
    server = await fakeRushDB('fail')
    const warn = vi.fn()
    const memory = createMemory({ apiKey: 'test-key', url: server.url }, { info: vi.fn(), warn })
    expect(await memory.recall(scope)).toEqual([])
    expect(warn).toHaveBeenCalledWith('RushDB recall search failed', expect.anything())
  })

  it('refuses a connection with no target', () => {
    expect(() => createMemory({}, { info: vi.fn(), warn: vi.fn() })).toThrow(/neither an engine URL nor a key/)
  })
})
