import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentMemoryEpisodeV1, RecalledMemory } from '@rushdb/agent-memory-contract'
import { RECALL_HEADING } from '@rushdb/agent-plugins-core'
import { fixture } from '../test/helpers.ts'
import type { Command, Host } from './hosts.ts'
import { COMPACTION_PROMPT, runHook, type RunOptions } from './run.ts'

const recalled: RecalledMemory[] = [{ id: 'e1', label: 'EPISODE', text: 'We chose pnpm workspaces.', score: 0.9 }]

let home: string
type AnyMock = Mock<any[], any>
let memory: { recall: AnyMock; rememberRecent: AnyMock; persistEpisode: AnyMock }
let spawnFlush: AnyMock

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'rushdb-hooks-run-'))
  memory = {
    recall: vi.fn(async () => recalled),
    rememberRecent: vi.fn((episode) => episode),
    persistEpisode: vi.fn(async (episode) => episode)
  }
  spawnFlush = vi.fn(() => true)
})

function options(env: NodeJS.ProcessEnv = {}): RunOptions {
  return {
    env: { RUSHDB_AUTO_CONTEXT: 'recall+persist', RUSHDB_API_KEY: 'test-key', ...env },
    homeDir: home,
    spawnFlush,
    createMemory: () => memory,
    gitRemote: async () => 'git@github.com:rush-db/agent-plugins.git'
  }
}

const stateDir = () => join(home, '.local', 'state', 'rushdb')

async function outbox(): Promise<AgentMemoryEpisodeV1[]> {
  const directory = join(stateDir(), 'outbox')
  const files = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.json'))
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))))
}

async function run(host: Host, event: string, command: Command, env?: NodeJS.ProcessEnv) {
  return runHook(command, host, await fixture(host, event, { cwd: home }), options(env))
}

const plain = `${RECALL_HEADING}\n\n[Memory 1; source=EPISODE; score=0.900]\n"We chose pnpm workspaces."`

describe('golden: stdout per host and event', () => {
  const cases: Array<[Host, string, Command, string]> = [
    ['claude', 'SessionStart', 'recall', plain],
    ['claude', 'Stop', 'capture', ''],
    ['claude', 'PreCompact', 'precompact', ''],
    ['claude', 'PostCompact', 'postcompact', ''],
    ['claude', 'SessionEnd', 'end', ''],
    ['qwen', 'SessionStart', 'recall', plain],
    ['qwen', 'Stop', 'capture', ''],
    ['qwen', 'PostCompact', 'postcompact', ''],
    ['qwen', 'SessionEnd', 'end', ''],
    ['codex', 'SessionStart', 'recall', plain],
    ['codex', 'UserPromptSubmit', 'capture', ''],
    ['codex', 'Stop', 'capture', '{}'],
    ['codex', 'PreCompact', 'precompact', ''],
    ['codex', 'SessionEnd', 'end', ''],
    [
      'gemini',
      'SessionStart',
      'recall',
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: plain } })
    ],
    ['gemini', 'AfterAgent', 'capture', '{}'],
    ['gemini', 'PreCompress', 'precompact', '{}'],
    ['gemini', 'SessionEnd', 'end', '{}']
  ]

  for (const [host, event, command, expected] of cases) {
    it(`${host} ${event} → ${command}`, async () => {
      expect(await run(host, event, command)).toBe(expected)
    })
  }

  it('prints the same empty answers with automatic context off, and touches nothing', async () => {
    for (const [host, event, command, expected] of cases) {
      const output = await run(host, event, command, { RUSHDB_AUTO_CONTEXT: 'off' })
      expect(output).toBe(command === 'recall' ? (host === 'gemini' ? '{}' : '') : expected)
    }
    expect(memory.recall).not.toHaveBeenCalled()
    expect(spawnFlush).not.toHaveBeenCalled()
    expect(await readdir(home)).toEqual([])
  })
})

describe('recall', () => {
  it('leaves the current session out and keeps the project scope', async () => {
    await run('claude', 'SessionStart', 'recall')
    expect(memory.recall.mock.calls[0]![0]).toMatchObject({
      excludeSessionId: 'claude-session',
      agentId: 'agent-plugins'
    })
  })

  it('prints nothing when nothing is recalled', async () => {
    memory.recall.mockResolvedValue([])
    expect(await run('claude', 'SessionStart', 'recall')).toBe('')
    expect(await run('gemini', 'SessionStart', 'recall')).toBe('{}')
  })

  it('works in recall-only mode, which captures nothing', async () => {
    expect(await run('claude', 'SessionStart', 'recall', { RUSHDB_AUTO_CONTEXT: 'recall' })).toBe(plain)
    expect(await run('claude', 'Stop', 'capture', { RUSHDB_AUTO_CONTEXT: 'recall' })).toBe('')
    expect(await outbox()).toEqual([])
  })

  it('logs a recall that times out and prints nothing', async () => {
    memory.recall.mockImplementation(() => new Promise(() => {}))
    expect(await run('claude', 'SessionStart', 'recall')).toBe('')
    expect(await readFile(join(stateDir(), 'hooks.log'), 'utf8')).toMatch(/RushDB recall timed out after 1500 ms/)
  }, 10_000)

  it('starts a background flush when an earlier run left episodes behind', async () => {
    await run('claude', 'Stop', 'capture')
    spawnFlush.mockClear()
    await run('claude', 'SessionStart', 'recall')
    expect(spawnFlush).toHaveBeenCalledTimes(1)
  })
})

describe('capture', () => {
  it('Claude: prompt from the transcript tail, answer from last_assistant_message', async () => {
    await run('claude', 'Stop', 'capture')
    const [episode] = await outbox()
    expect(episode).toMatchObject({
      userText: 'Which package manager do we use?',
      assistantText: 'Decision: use pnpm workspaces, never npm.',
      externalSessionId: 'claude-session',
      sourceEventId: 'claude-session:0',
      provenance: 'claude:Stop'
    })
    expect(spawnFlush).toHaveBeenCalledTimes(1)
  })

  it('Qwen: the same route as Claude', async () => {
    await run('qwen', 'Stop', 'capture')
    expect((await outbox())[0]).toMatchObject({ userText: 'Which package manager do we use?', provenance: 'qwen:Stop' })
  })

  it('Codex: UserPromptSubmit buffers the prompt, Stop pairs it with the answer', async () => {
    expect(await run('codex', 'UserPromptSubmit', 'capture')).toBe('')
    expect(await outbox()).toEqual([])
    await run('codex', 'Stop', 'capture')
    expect((await outbox())[0]).toMatchObject({
      userText: 'Which package manager do we use?',
      assistantText: 'Decision: use pnpm workspaces, never npm.',
      provenance: 'codex:Stop'
    })
  })

  it('Codex: a Stop without its buffered prompt is skipped and logged', async () => {
    expect(await run('codex', 'Stop', 'capture')).toBe('{}')
    expect(await outbox()).toEqual([])
    expect(await readFile(join(stateDir(), 'hooks.log'), 'utf8')).toMatch(/capture skipped a codex Stop/)
  })

  it('Gemini: AfterAgent carries both texts', async () => {
    await run('gemini', 'AfterAgent', 'capture')
    expect((await outbox())[0]).toMatchObject({
      userText: 'Which package manager do we use?',
      provenance: 'gemini:AfterAgent'
    })
  })

  it('a Stop that fires twice for one turn stores one episode', async () => {
    await run('claude', 'Stop', 'capture')
    await run('claude', 'Stop', 'capture')
    expect(await outbox()).toHaveLength(1)
  })

  it('PostCompact stores the compaction summary', async () => {
    await run('claude', 'PostCompact', 'postcompact')
    expect((await outbox())[0]).toMatchObject({
      userText: COMPACTION_PROMPT,
      assistantText: 'The team chose pnpm workspaces.',
      provenance: 'claude:PostCompact'
    })
  })
})

describe('precompact, end and flush', () => {
  it('precompact sends the outbox before compaction', async () => {
    await run('claude', 'Stop', 'capture')
    await run('claude', 'PreCompact', 'precompact')
    expect(memory.persistEpisode).toHaveBeenCalledTimes(1)
    expect(await outbox()).toEqual([])
  })

  it('end spawns a flush only when something is waiting', async () => {
    await run('claude', 'SessionEnd', 'end')
    expect(spawnFlush).not.toHaveBeenCalled()
    await run('claude', 'Stop', 'capture')
    spawnFlush.mockClear()
    await run('claude', 'SessionEnd', 'end')
    expect(spawnFlush).toHaveBeenCalledTimes(1)
  })

  it('flush sends the outbox', async () => {
    await run('claude', 'Stop', 'capture')
    expect(await runHook('flush', 'claude', undefined, options())).toBe('')
    expect(await outbox()).toEqual([])
  })
})

describe('fail open', () => {
  it('without a key: prints the empty answer and logs why', async () => {
    const output = await runHook('recall', 'gemini', await fixture('gemini', 'SessionStart', { cwd: home }), {
      ...options(),
      env: { RUSHDB_AUTO_CONTEXT: 'recall', RUSHDB_API_KEY: '${user_config.api_key}' }
    })
    expect(output).toBe('{}')
    expect(await readFile(join(stateDir(), 'hooks.log'), 'utf8')).toMatch(/disabled until RUSHDB_API_KEY/)
  })

  it('a throwing client gives the empty answer', async () => {
    const output = await runHook('capture', 'codex', await fixture('codex', 'Stop', { cwd: home }), {
      ...options(),
      createMemory: () => {
        throw new Error('boom')
      }
    })
    expect(output).toBe('{}')
  })

  it('garbage on stdin gives the empty answer', async () => {
    for (const raw of [undefined, null, 'text', [1, 2]]) {
      expect(await runHook('capture', 'codex', raw, options())).toBe('')
      expect(await runHook('recall', 'claude', raw, options())).toBe('')
    }
  })
})
