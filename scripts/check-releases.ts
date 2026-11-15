import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Listing } from './lib/shared.ts'

/**
 * Guards the Gemini install path (plan finding F2). `gemini extensions install <repo>` takes the latest GitHub
 * Release and picks an asset named `<platform>.<arch>.*` or `<platform>.*`, or the only asset when there is exactly
 * one. Otherwise it unpacks the release's source tarball, which works because the extension sits at the repo root.
 * So a release must never carry a lone asset, or a platform-named asset, that is not the Gemini extension.
 */
export const GEMINI_PLATFORMS = ['darwin', 'linux', 'win32']

export interface Release {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets: Array<{ name: string }>
}

/** A Gemini extension archive: `<platform>.<arch>.<extension>…` or `<platform>.<extension>…`. */
export function isGeminiAsset(name: string, extension: string): boolean {
  const lower = name.toLowerCase()
  const platform = GEMINI_PLATFORMS.find((value) => lower.startsWith(`${value}.`))
  return platform !== undefined && lower.slice(platform.length + 1).includes(extension)
}

export function checkReleases(releases: Release[], extension: string): string[] {
  const errors: string[] = []
  for (const release of releases) {
    const names = release.assets.map((asset) => asset.name)
    if (names.length === 1 && !isGeminiAsset(names[0]!, extension)) {
      errors.push(
        `release ${release.tag_name} has one asset, ${names[0]}, which Gemini CLI would install as the extension; remove it or add a second asset`
      )
    }
    for (const name of names) {
      const lower = name.toLowerCase()
      if (GEMINI_PLATFORMS.some((value) => lower.startsWith(`${value}.`)) && !isGeminiAsset(name, extension)) {
        errors.push(`release ${release.tag_name} asset ${name} looks like a Gemini platform archive; rename it`)
      }
    }
  }
  return errors
}

/** `owner/repo` from an https GitHub URL. */
export function githubRepo(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url)
  if (!match) throw new Error(`Not a GitHub repository URL: ${url}`)
  return `${match[1]}/${match[2]}`
}

/** Every release, newest first. Undefined when the repository does not exist yet (before go-live). */
export async function fetchReleases(repo: string, token?: string, fetchImpl = fetch): Promise<Release[] | undefined> {
  const releases: Release[] = []
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status} ${response.statusText}`)
    const batch = (await response.json()) as Release[]
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const listing = JSON.parse(await readFile(join(root, 'shared', 'listing.json'), 'utf8')) as Listing
  const repo = githubRepo(listing.urls.repository)
  const releases = await fetchReleases(repo, process.env.GITHUB_TOKEN)
  if (releases === undefined) {
    console.log(`${repo} does not exist on GitHub yet; no releases to check.`)
    return
  }
  const errors = checkReleases(releases, listing.name)
  if (errors.length > 0) {
    console.error(errors.map((error) => `✗ ${error}`).join('\n'))
    process.exitCode = 1
    return
  }
  console.log(`${releases.length} release(s) of ${repo} are safe for Gemini CLI installs.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
