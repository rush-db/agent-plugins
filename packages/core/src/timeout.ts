/**
 * Resolves with the task's value, or with `null` when it rejects or takes longer than `timeoutMs`. Never rejects.
 * The task itself keeps running; a short-lived process should exit rather than wait for it.
 */
export function withTimeout<T>(
  task: Promise<T> | (() => Promise<T>),
  timeoutMs: number,
  onError?: (message: string, error?: unknown) => void,
  label = 'RushDB call'
): Promise<T | null> {
  return new Promise((resolve) => {
    let pending: Promise<T>
    try {
      pending = typeof task === 'function' ? task() : task
    } catch (error) {
      onError?.(`${label} failed`, error)
      resolve(null)
      return
    }
    const timeout = setTimeout(() => {
      onError?.(`${label} timed out after ${timeoutMs} ms`)
      resolve(null)
    }, timeoutMs)
    timeout.unref?.()
    pending.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        onError?.(`${label} failed`, error)
        resolve(null)
      }
    )
  })
}

/** Runs `task` and returns `fallback` instead of throwing. */
export async function failOpen<T>(
  task: () => Promise<T> | T,
  fallback: T,
  onError?: (message: string, error?: unknown) => void,
  label = 'RushDB hook'
): Promise<T> {
  try {
    return await task()
  } catch (error) {
    try {
      onError?.(`${label} failed`, error)
    } catch {
      // the logger must not turn a handled failure into a thrown one
    }
    return fallback
  }
}
