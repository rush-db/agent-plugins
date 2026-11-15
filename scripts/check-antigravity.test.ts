import { describe, expect, it } from 'vitest'
import { ALLOWED_WARNINGS, checkAgyReport, type AgyFinding } from './check-antigravity.ts'

// The three warnings as agy 1.5.9 prints them for this repo.
const known: AgyFinding[] = [
  {
    severity: 'warning',
    file: 'GEMINI.md',
    message: 'never loaded: plugins load rules only from rules/. Move it to rules/GEMINI.md'
  },
  { severity: 'warning', file: 'commands', message: 'never loaded: plugins have no commands. Make each one a skill' },
  {
    severity: 'warning',
    file: 'hooks/hooks.json',
    message: 'never loaded: plugin hooks are read only from hooks.json at the plugin root'
  }
]
const note: AgyFinding = { severity: 'note', file: '.antigravity-plugin/plugin.json', message: 'no logo' }

describe('check-antigravity', () => {
  it('passes with exactly the known warnings, plus notes', () => {
    expect(checkAgyReport({ findings: [...known, note] })).toEqual([])
    expect(ALLOWED_WARNINGS).toHaveLength(3)
  })

  it('fails on any error', () => {
    const error = { severity: 'error', file: 'rules/rushdb.md', message: 'no valid trigger' }
    expect(checkAgyReport({ findings: [...known, error] })).toEqual(['error rules/rushdb.md: no valid trigger'])
  })

  it('fails on a new warning, or a known message on another file', () => {
    const moved = { ...known[0]!, file: 'docs/GEMINI.md' }
    expect(checkAgyReport({ findings: [...known, moved] })).toEqual([
      'unexpected warning docs/GEMINI.md: never loaded: plugins load rules only from rules/. Move it to rules/GEMINI.md'
    ])
  })

  it('fails when a known warning is gone, so the allowlist stays exact', () => {
    expect(checkAgyReport({ findings: known.slice(1) })).toEqual([
      expect.stringMatching(/expected warning on GEMINI\.md is gone/)
    ])
  })
})
