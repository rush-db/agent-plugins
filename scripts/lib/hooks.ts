import { bundleHooks, HOOK_BUNDLE_NAME } from '../../packages/hooks/src/bundle.ts'
import type { GeneratedFile } from './files.ts'

/** Every hook-carrying platform folder gets its own copy of the bundle (no symlinks, F9). agy runs the root copy. */
export const HOOK_BUNDLE_TARGETS = [
  `hooks/${HOOK_BUNDLE_NAME}`,
  `plugins/claude/rushdb/hooks/${HOOK_BUNDLE_NAME}`,
  `plugins/codex/rushdb/hooks/${HOOK_BUNDLE_NAME}`
]

export async function hookBundles(root: string): Promise<GeneratedFile[]> {
  const content = await bundleHooks(root)
  return HOOK_BUNDLE_TARGETS.map((path) => ({ path, content }))
}
