// Test helpers: a throwaway rush-db/skills repository with a tag, built with plain git.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function skillMarkdown(name: string, description = `Use ${name} for tests.`): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`
}

/** Creates a git repo at `dir` holding `files`, committed and tagged `tag`. */
export async function createSkillsRepo(dir: string, tag: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' })
  return commitAndTag(dir, tag)
}

/** Commits everything in the fixture repo at `dir` and tags it. Returns the commit. */
export function commitAndTag(dir: string, tag: string): string {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe'
    })
  git('add', '-A')
  git('commit', '--quiet', '-m', tag)
  git('tag', tag)
  return git('rev-parse', 'HEAD').trim()
}
