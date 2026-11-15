import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtures } from '../test/helpers.ts'
import { lastUserPrompt, promptText } from './transcript.ts'

describe('lastUserPrompt', () => {
  it('skips tool results, meta entries and command output in a Claude transcript', async () => {
    expect(await lastUserPrompt(join(fixtures, 'claude-transcript.jsonl'))).toBe('Which package manager do we use?')
  })

  it('reads Gemini-style parts and skips system snapshots in a Qwen Code 0.27.4 chat', async () => {
    expect(await lastUserPrompt(join(fixtures, 'qwen-transcript.jsonl'))).toBe('Which package manager do we use?')
  })

  it('gives undefined for a missing or unreadable transcript', async () => {
    expect(await lastUserPrompt(undefined)).toBeUndefined()
    expect(await lastUserPrompt('/nonexistent/transcript.jsonl')).toBeUndefined()
    const directory = await mkdtemp(join(tmpdir(), 'rushdb-hooks-transcript-'))
    await writeFile(join(directory, 'bad.jsonl'), 'not json\n{"type":"assistant"}\n')
    expect(await lastUserPrompt(join(directory, 'bad.jsonl'))).toBeUndefined()
  })

  it('reads only the tail of a long transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rushdb-hooks-transcript-'))
    const filler = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(1000) } })
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'too old to see' } }),
      ...Array.from({ length: 600 }, () => filler)
    ]
    await writeFile(join(directory, 'long.jsonl'), `${lines.join('\n')}\n`)
    expect(await lastUserPrompt(join(directory, 'long.jsonl'))).toBeUndefined()
  })
})

describe('promptText', () => {
  it('joins text blocks and ignores other blocks', () => {
    expect(
      promptText({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'one' },
            { type: 'image', source: {} },
            { type: 'text', text: 'two' }
          ]
        }
      })
    ).toBe('one\ntwo')
  })

  it('ignores user-role messages in records of another type', () => {
    const message = { role: 'user', parts: [{ text: 'Current memory catalog' }] }
    expect(promptText({ type: 'system', subtype: 'memory_catalog_snapshot', message })).toBe('')
    expect(promptText({ message })).toBe('Current memory catalog')
  })
})
