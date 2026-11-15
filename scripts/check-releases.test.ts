import { describe, expect, it } from 'vitest'
import { checkReleases, fetchReleases, githubRepo, isGeminiAsset } from './check-releases.ts'

const release = (tag: string, ...names: string[]) => ({ tag_name: tag, assets: names.map((name) => ({ name })) })

describe('check-releases', () => {
  it('accepts releases with no assets or with Gemini-named archives', () => {
    expect(
      checkReleases(
        [release('v0.1.0'), release('v0.2.0', 'linux.x64.rushdb.tar.gz'), release('v0.3.0', 'a.zip', 'b.zip')],
        'rushdb'
      )
    ).toEqual([])
  })

  it('fails a release with exactly one asset not named for Gemini', () => {
    expect(checkReleases([release('pi@0.1.0', 'rushdb-pi-0.1.0.tgz')], 'rushdb')).toEqual([
      expect.stringMatching(/release pi@0\.1\.0 has one asset, rushdb-pi-0\.1\.0\.tgz/)
    ])
  })

  it('fails a platform-named asset that is not the extension, even among several', () => {
    expect(checkReleases([release('v1.0.0', 'linux.x64.other.tar.gz', 'notes.txt')], 'rushdb')).toEqual([
      expect.stringMatching(/asset linux\.x64\.other\.tar\.gz looks like a Gemini platform archive/)
    ])
  })

  it('recognizes Gemini asset names', () => {
    expect(isGeminiAsset('darwin.arm64.rushdb.tar.gz', 'rushdb')).toBe(true)
    expect(isGeminiAsset('win32.rushdb.zip', 'rushdb')).toBe(true)
    expect(isGeminiAsset('rushdb.zip', 'rushdb')).toBe(false)
  })

  it('reads owner/repo from the repository URL', () => {
    expect(githubRepo('https://github.com/rush-db/agent-plugins')).toBe('rush-db/agent-plugins')
    expect(githubRepo('https://github.com/rush-db/agent-plugins.git')).toBe('rush-db/agent-plugins')
  })

  it('treats a missing repository as nothing to check and pages through releases', async () => {
    expect(await fetchReleases('rush-db/x', undefined, async () => new Response('', { status: 404 }))).toBeUndefined()
    const pages = [Array.from({ length: 100 }, (_, i) => release(`v${i}`)), [release('v100')]]
    const urls: string[] = []
    const releases = await fetchReleases('rush-db/x', 'token', async (url) => {
      urls.push(String(url))
      return Response.json(pages[urls.length - 1])
    })
    expect(releases).toHaveLength(101)
    expect(urls[1]).toMatch(/page=2$/)
  })
})
