# RushDB for DeepSeek Harness

`@rushdb/dsh` gives your DeepSeek Harness agent a database it can search, query
and analyze: RAG over your records, structured queries, aggregations for
agentic analytics, and facts it can save and find again. Optional automatic
context, off by default, recalls relevant earlier work before each turn and
stores finished turns in your RushDB project.

```bash
dsh plugin --profile <profile> add @rushdb/dsh
```

Then give it a RushDB API key from [app.rushdb.com](https://app.rushdb.com):
`export RUSHDB_API_KEY=<key>`, or add `RUSHDB_API_KEY=<key>` to
`$DSH_HOME/.env`. dsh's credential store works too. The key never goes into
the plugin's config, which only names it (`apiKeyRef`).

## Tools

The four tools are always on. They reach the network only when the model calls
them.

| Tool               | What it does                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rushdb_search`    | Semantic search. With `propertyName`, ranks records by meaning against an embedding index on that property. Without it, searches context stored by earlier sessions. |
| `rushdb_query`     | Finds records with a RushDB SearchQuery: labels, where filters (related records too), sorting and paging.                                                          |
| `rushdb_aggregate` | Counts, sums, averages, min and max, collected values and time buckets, optionally grouped.                                                                        |
| `rushdb_remember`  | Saves a fact, decision or preference so later sessions can find it.                                                                                                |

## Automatic context

Off by default. To turn it on, override the `rushdb` row in your profile's
`cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: rushdb
  config:
    autoContext: { recall: true, capture: true }
```

A later layer replaces the row's whole `config`, so put every setting you
change in that one row.

- **recall**: before the first step of each turn, the plugin searches your
  project for earlier turns and saved facts related to your prompt and adds
  what it finds as one message in front of the prompt. The message is typed
  `rushdb-context` (shown as recalled material, never as something you typed)
  and headed "Context recalled from RushDB (historical, may be outdated)". If
  RushDB is slow or down, the step goes on without it after `recallTimeoutMs`
  (1.5 s).
- **capture**: when a turn completes, its prompt and final answer are written
  to a local outbox and sent in the background. Turns that fail or are
  cancelled are skipped. With the network down, turns wait in the outbox and
  go out later; compaction and the end of a session flush it, and unloading the
  plugin waits at most 2 s.
- Subagent sessions are left out unless `includeSubagents` is on.

Context is shared per project (a hash of the git remote, or of the working
directory; `contextScope` replaces it), so Claude Code, Codex, Gemini CLI and
the other RushDB plugins recall the same project context when they use the
same RushDB project.

## Settings

| Setting                | Default            | What it does                                                                            |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `apiKeyRef`            | `RUSHDB_API_KEY`   | Credential that holds the RushDB API key.                                               |
| `url`                  | RushDB Cloud       | RushDB API URL, for a self-hosted RushDB.                                               |
| `engineUrl`            |                    | A standalone RushDB engine (direct mode) instead of the API.                            |
| `engineTokenRef`       | `RUSHDB_ENGINE_TOKEN` | Credential that holds the engine token.                                              |
| `engineScope`          |                    | Tenant on a multitenant engine.                                                         |
| `embedding`            |                    | `baseUrl`, `apiKeyRef` (`RUSHDB_EMBEDDING_API_KEY`), `model`, `dimensions`: an OpenAI-compatible embedding provider. Required with an engine, which has no managed embeddings. |
| `autoContext`          | both `false`       | `recall` and `capture`, described above.                                                |
| `recallLimit`          | `6`                | Most items one recall adds.                                                             |
| `recallTimeoutMs`      | `1500`             | Recall gives up after this long.                                                        |
| `recallMinChars`       | `3`                | Shorter prompts don't trigger recall.                                                   |
| `includeSubagents`     | `false`            | Also recall into and capture from subagent sessions.                                    |
| `profileId`            | `default`          | Profile id stored with the context.                                                     |
| `contextScope`         |                    | Replaces the project key.                                                               |
| `outboxPath`           | `rushdb/outbox`    | Outbox for captured turns; relative to `$DSH_HOME`.                                     |
| `excludeFromLogUpload` | `false`            | Keep sessions that received RushDB context out of the session-log upload to DeepSeek.  |

## What leaves your machine

- **Tools** send what the model passes in a tool call to the RushDB API you
  use (`https://api.rushdb.com/api/v1` for RushDB Cloud) or your own engine.
- **With automatic context off** nothing else is sent, and the plugin writes no
  files.
- **With recall**, each turn's first step sends two search requests (earlier
  turns, saved facts) with your prompt as the query and a project scope (a
  hash, so neither the git remote nor the path is sent).
- **With capture**, each completed turn's prompt and final answer, bounded in
  length, are stored as an `EPISODE` record in your RushDB project. Until they
  are sent they sit in the outbox (`$DSH_HOME/rushdb/outbox`, files named by a
  hash, mode `0600`).
- With an engine and an embedding provider, the same text also goes to that
  provider to be embedded.
- **DeepSeek session logs**: DeepSeek Harness uploads session logs to DeepSeek
  by default, and recalled context becomes part of the session. Set
  `excludeFromLogUpload: true` to keep every session that received RushDB
  context out of that upload (dsh can only skip a whole session), or turn the
  upload off in dsh's settings.
- **Deleting it**: stored turns and facts are ordinary `EPISODE` and
  `MEMORY_FACT` records in your project; delete them in the RushDB dashboard.
  Turn automatic context off to stop sending.

## MCP instead

You can also connect the RushDB MCP server through dsh's MCP client. Its stdio
bridge strips credential-like variables from the child, so pass the key in the
row's `env`:

```yaml
- insert:
    - id: rushdb-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rushdb
        transport: stdio
        command: npx
        args: ['-y', '@rushdb/mcp-server@3.4.1']
        env:
          RUSHDB_API_KEY: !!js process.env.RUSHDB_API_KEY
```

## License

[Apache-2.0](https://github.com/rush-db/agent-plugins/blob/main/LICENSE)
