import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { marketIndex } from '../scripts/market-index.ts'

describe('market index entry', () => {
  it('passes dsh’s own format-1 validator', async () => {
    const index = parseMarketIndex(await marketIndex(1_763_200_000), 'https://example.com/index.json')
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    const [plugin] = index.plugins
    expect(plugin?.name).toBe('@rushdb/dsh')
    expect(plugin?.title).toEqual({ en: 'RushDB', zh: 'RushDB' })
    expect(plugin?.versions[0]).toMatchObject({
      version,
      source: { type: 'npm' },
      engines: { dsh: '>=0.2.2-0 <0.3.0' }
    })
  })
})
