# RushDB for Claude Code

RushDB gives your agent a database it can search, query and analyze. The plugin connects the RushDB MCP tools and ships skills for building queries, faceted search, data modeling and agent context. Use it for RAG over your records, structured and semantic search, relationship traversal and agentic analytics such as counts, groupings and time series. Optional automatic context, off by default, recalls relevant earlier work at session start and stores finished turns in your RushDB project.

## Install

```
/plugin install rushdb --marketplace rush-db/agent-plugins
```

Or from a terminal:

```bash
claude plugin marketplace add rush-db/agent-plugins
claude plugin install rushdb@rushdb
```

The same folder installs in Qwen Code:
`qwen extensions install rush-db/agent-plugins:rushdb`.

## What you get

- **MCP tools** from the hosted RushDB MCP server at `https://mcp.rushdb.com/mcp`. Claude
  asks you to sign in to RushDB (OAuth) the first time a tool runs. No API key
  is stored in the plugin for this.
- **Skills**: `rushdb-query-builder`, `rushdb-data-modeling`, `rushdb-faceted-search`, `rushdb-agent-memory`.
- **Automatic context** (optional, off by default): recall of earlier work at
  session start and capture of finished turns into your RushDB project.

## Settings

Set them when you enable the plugin, in `/config`, or with
`claude plugin configure rushdb`.

| Setting | Default | What it does |
|---|---|---|
| `api_key` | none | RushDB project API key. Used only by the automatic-context hooks. Stored in your system keychain. |
| `api_url` | `https://api.rushdb.com/api/v1` | RushDB API URL. Change it for a self-hosted RushDB. |
| `auto_context` | `off` | `off`, `recall` (recall at session start), or `recall+persist` (also store finished turns). |
| `context_scope` | the project | A name that replaces the project key, to share context across folders or keep it apart. |

Turn automatic context on with `auto_context` set to `recall+persist` and an
`api_key`. Outside Claude Code the hooks also read `RUSHDB_API_KEY`,
`RUSHDB_API_URL`, `RUSHDB_AUTO_CONTEXT` and `RUSHDB_CONTEXT_SCOPE` from the
environment, then `~/.config/rushdb/config.json`.

Self-hosted RushDB: add the local MCP server with your key instead of the
hosted one:

```bash
claude mcp add rushdb -e RUSHDB_API_KEY=<key> -e RUSHDB_API_URL=<url> -- npx -y @rushdb/mcp-server@3.4.1
```

## What leaves your machine

- **MCP tools** send what Claude passes to each tool call to `https://mcp.rushdb.com/mcp`,
  and return the results.
- **With `auto_context` set to `off`** (the default) the hooks exit at once.
  They read no files and make no network calls.
- **With `recall`**, each session start sends one search request to your
  RushDB API URL. It carries a hash of the project (from the git remote or the
  folder path) and returns earlier context, which Claude sees as historical
  text that may be outdated.
- **With `recall+persist`**, the hooks also send, to the same RushDB project:
  the last user prompt and Claude's answer after each finished turn (each
  bounded in length), and the compaction summary after compaction. Turns wait
  in a local queue in the plugin's data folder until they are sent, and are
  sent again after a failure.
- Nothing goes anywhere other than the RushDB API URL you set. Data you store
  stays in your RushDB project until you delete it there; uninstalling the
  plugin deletes the local queue.
- Hook errors are written to `hooks.log` in the plugin's data folder, with
  keys removed. Hooks never block or fail a session.

## License

Apache-2.0. Source: https://github.com/rush-db/agent-plugins
