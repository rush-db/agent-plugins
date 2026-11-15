// Starts a throwaway RushDB engine container on a free local port, runs the integration tests against it in direct
// mode, and removes the container. Never points at RushDB Cloud.
//   RUSHDB_TEST_IMAGE   image to run (default rushdb/rushdb:3.0.10)
//   RUSHDB_TEST_KEEP=1  leave the container running afterwards
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

const image = process.env.RUSHDB_TEST_IMAGE || 'rushdb/rushdb:3.0.10'
const token = randomBytes(24).toString('hex')
const name = `agent-plugins-core-test-${process.pid}`

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForEngine(url) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`engine at ${url} did not start within 60 s`)
}

const port = await freePort()
const engineUrl = `http://127.0.0.1:${port}`
execFileSync(
  'docker',
  ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:3000`, '-e', 'RUSHDB_TOKEN', image],
  {
    env: { ...process.env, RUSHDB_TOKEN: token },
    stdio: ['ignore', 'ignore', 'inherit']
  }
)
let status = 1
try {
  await waitForEngine(engineUrl)
  const result = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.integration.config.ts'], {
    stdio: 'inherit',
    env: { ...process.env, RUSHDB_TEST_ENGINE_URL: engineUrl, RUSHDB_TEST_ENGINE_TOKEN: token }
  })
  status = result.status ?? 1
} finally {
  if (process.env.RUSHDB_TEST_KEEP !== '1') spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
process.exit(status)
