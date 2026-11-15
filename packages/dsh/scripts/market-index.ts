// Prints a format-1 dsh market index with one entry for this package, built from package.json and locale/*.json.
// Community indexes (dshopen.org and others) take entries in this format; dsh's Discover tab reads it.
//   node scripts/market-index.ts [publishTimestamp]
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ICON_URL = 'https://raw.githubusercontent.com/rush-db/agent-plugins/main/shared/assets/icon.png'

interface LocaleMeta {
  meta: { title: string; description: string }
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(packageRoot, path), 'utf8')) as T
}

/** The index, with `publishTimestamp` in Unix seconds (the npm publish time of this version). */
export async function marketIndex(publishTimestamp: number) {
  const manifest = await json<{
    name: string
    version: string
    homepage: string
    engines: { dsh: string }
    repository: { url: string; directory: string }
  }>('package.json')
  const locales = { en: await json<LocaleMeta>('locale/en.json'), zh: await json<LocaleMeta>('locale/zh.json') }
  return {
    format: 1,
    title: { en: 'RushDB', zh: 'RushDB' },
    plugins: [
      {
        name: manifest.name,
        title: { en: locales.en.meta.title, zh: locales.zh.meta.title },
        description: { en: locales.en.meta.description, zh: locales.zh.meta.description },
        icon: ICON_URL,
        author: 'RushDB',
        homepage: manifest.homepage,
        repository: {
          url: manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
          directory: manifest.repository.directory
        },
        versions: [
          {
            version: manifest.version,
            publishTimestamp,
            source: { type: 'npm' },
            engines: { dsh: manifest.engines.dsh }
          }
        ]
      }
    ]
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timestamp = Number(process.argv[2] ?? Math.floor(Date.now() / 1000))
  console.log(JSON.stringify(await marketIndex(timestamp), null, 2))
}
