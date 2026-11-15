// Local stand-ins for scripts/smoke.sh: a RushDB API and a DeepSeek Messages API, so real `dsh headless` turns run
// to the end without RushDB Cloud or a DeepSeek key. Both listen on 127.0.0.1 only.
//   node stand-ins.mjs <dir>
// Writes <dir>/rushdb.port, <dir>/model.port and <dir>/proxy.port, then serves until killed.
//
// RushDB: reads <dir>/rushdb.mode on every request:
//   ok    answers every request (recall searches with nothing)
//   hit   answers recall searches with one saved fact
//   hang  accepts the connection, reads the request and never answers
// Each request is appended to <dir>/rushdb.log as `METHOD PATH`.
//
// DeepSeek: answers each turn with a short text. A prompt containing CALL_RUSHDB_QUERY first gets a rushdb_query tool
// call. Each request is appended to <dir>/model.log as JSON: whether it carries the dsh_session_log upload, whether
// that upload contains recalled RushDB context, and whether it carries a failed tool result.
//
// Proxy: a forward HTTP proxy that appends `METHOD absolute-url` to <dir>/proxy.log and sends every request to the
// RushDB stand-in, whatever host it names, so a hostname nothing else resolves is reachable only through it.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'

const dir = process.argv[2]
const HEADING = 'Context recalled from RushDB'
const fact = {
  __id: 'f1',
  __label: 'MEMORY_FACT',
  factId: 'f1',
  text: 'Decision: this project uses pnpm workspaces.',
  __score: 0.9
}

function listen(server, name) {
  server.listen(0, '127.0.0.1', () => writeFileSync(join(dir, `${name}.port`), String(server.address().port)))
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => resolve(body))
  })
}

listen(
  createServer(async (request, response) => {
    await readBody(request)
    appendFileSync(join(dir, 'rushdb.log'), `${request.method} ${request.url}\n`)
    let mode = 'ok'
    try {
      mode = readFileSync(join(dir, 'rushdb.mode'), 'utf8').trim()
    } catch {}
    if (mode === 'hang') return
    const hits = mode === 'hit' && request.url.endsWith('/ai/search') ? [fact] : []
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: hits, total: hits.length }))
  }),
  'rushdb'
)

/** The value of the first `key` anywhere in `value`. */
function find(value, key) {
  if (!value || typeof value !== 'object') return undefined
  if (Object.hasOwn(value, key)) return value[key]
  for (const member of Object.values(value)) {
    const found = find(member, key)
    if (found !== undefined) return found
  }
  return undefined
}

function sse(response, blocks, stopReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  send('message_start', { message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 10, output_tokens: 0 } } })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    } else {
      send('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
      })
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } })
  send('message_stop', {})
  response.end()
}

listen(
  createServer(async (request, response) => {
    const text = await readBody(request)
    if (!request.url.endsWith('/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    const body = JSON.parse(text)
    const upload = find(body, 'dsh_session_log')
    const last = body.messages?.at(-1)
    const results = Array.isArray(last?.content) ? last.content.filter((part) => part.type === 'tool_result') : []
    appendFileSync(
      join(dir, 'model.log'),
      JSON.stringify({
        upload: upload !== undefined,
        uploadHasContext: upload !== undefined && JSON.stringify(upload).includes(HEADING),
        toolError: results.some((part) => part.is_error === true)
      }) + '\n'
    )
    const prompt = JSON.stringify(body.messages ?? [])
    const wantsTool = prompt.includes('CALL_RUSHDB_QUERY') && results.length === 0
    const offersTool = (body.tools ?? []).some((tool) => tool.name === 'rushdb_query')
    if (wantsTool && offersTool) {
      sse(
        response,
        [{ type: 'tool_use', id: 'toolu_1', name: 'rushdb_query', input: { labels: ['Order'] } }],
        'tool_use'
      )
    } else {
      sse(response, [{ type: 'text', text: 'ANSWER: this project uses pnpm workspaces.' }], 'end_turn')
    }
  }),
  'model'
)

listen(
  createServer((request, response) => {
    appendFileSync(join(dir, 'proxy.log'), `${request.method} ${request.url}\n`)
    const url = new URL(request.url)
    const forwarded = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(readFileSync(join(dir, 'rushdb.port'), 'utf8')),
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      }
    )
    forwarded.on('error', () => response.destroy())
    response.on('close', () => forwarded.destroy())
    request.pipe(forwarded)
  }),
  'proxy'
)
