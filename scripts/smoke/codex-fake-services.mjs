// Local stand-ins for scripts/smoke/codex.sh, on one free port, so Codex runs a real session with no login and no
// network:
//   POST /v1/responses   a model provider (Responses API, streamed) that answers with the text in <answer file>
//   POST /v1/embeddings  an OpenAI-compatible embedder (hashed bag of words), for a local engine in direct mode
//   /api/v1/*            a RushDB API that answers every request with an empty success
// Every request is appended to <requests.jsonl>; the answer file is read again for each model request. Prints the port, then serves until killed.
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [log, answerFile] = process.argv.slice(2)
if (!log || !answerFile) throw new Error('usage: node codex-fake-services.mjs <requests.jsonl> <answer file>')
const DIMENSIONS = 64

function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    vector[parseInt(createHash('sha256').update(word).digest('hex').slice(0, 8), 16) % DIMENSIONS] += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((value) => value / norm)
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

let turn = 0
function respond(response) {
  const id = `resp_${++turn}`
  let text = 'OK from the fake model.'
  try {
    text = readFileSync(answerFile, 'utf8').trim() || text
  } catch {
    // no answer file: the default
  }
  const events = [
    { type: 'response.created', response: { id } },
    {
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', id: `msg_${turn}`, content: [{ type: 'output_text', text }] }
    },
    {
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
          total_tokens: 2
        }
      }
    }
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
}

const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const path = request.url ?? ''
    appendFileSync(log, `${JSON.stringify({ at: Date.now(), method: request.method, path, body })}\n`)
    if (request.method === 'POST' && path.endsWith('/v1/responses')) return respond(response)
    if (request.method === 'POST' && path.endsWith('/v1/embeddings')) {
      const { input } = JSON.parse(body)
      const texts = Array.isArray(input) ? input : [input]
      return json(response, 200, { data: texts.map((text, index) => ({ index, embedding: embed(text) })) })
    }
    if (path.startsWith('/api/v1/')) return json(response, 200, { success: true, data: [], total: 0 })
    json(response, 404, { error: 'not found' })
  })
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
