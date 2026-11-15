# RushDB for Codex

RushDB gives your agent a database it can search, query and analyze. The plugin connects the RushDB MCP tools and ships skills for building queries, faceted search, data modeling and agent context. Use it for RAG over your records, structured and semantic search, relationship traversal and agentic analytics such as counts, groupings and time series. Optional automatic context, off by default, recalls relevant earlier work at session start and stores finished turns in your RushDB project.

## Install

```bash
codex plugin marketplace add rush-db/agent-plugins
codex plugin add rushdb@rushdb
codex mcp login rushdb
```

Or pick RushDB in `/plugins`. The last command signs the MCP tools in
to RushDB (OAuth) in your browser. Then run the `rushdb-setup` skill, or ask
Codex to set up RushDB, for the optional automatic context.

This is the Codex marketplace build. RushDB is also planned for the
ChatGPT and Codex plugin directory, without hooks; install one of the two, not
both.

## What you get

- **MCP tools** from the hosted RushDB MCP server at `https://mcp.rushdb.com/mcp`, signed
  in with OAuth. No API key is stored in the plugin for this.
- **Skills**: `rushdb-query-builder`, `rushdb-data-modeling`, `rushdb-faceted-search`, `rushdb-agent-memory`, and `rushdb-setup` for setup.
- **Automatic context** (optional, off by default): recall of earlier work at
  session start and capture of finished turns into your RushDB project.

## Automatic context

Codex plugins have no settings form, so automatic context reads, in order:

1. the environment variables `RUSHDB_AUTO_CONTEXT`, `RUSHDB_API_KEY`,
   `RUSHDB_API_URL` and `RUSHDB_CONTEXT_SCOPE`, when Codex passes them to
   hooks;
2. `~/.config/rushdb/config.json` (`$XDG_CONFIG_HOME/rushdb/config.json` when
   that is set), a file you write yourself with mode `0600`:

```json
{ "apiKey": "<your RushDB API key>", "autoContext": "recall+persist" }
```

`autoContext` is `off` (the default), `recall` (recall at session start) or
`recall+persist` (also store finished turns). Codex skips plugin hooks until
you trust them: open `/hooks` and trust the RushDB hooks. They need trusting
again after each plugin update that changes them.

| Hook | When | What it does |
|---|---|---|
| `SessionStart` | startup, resume, after compaction | recalls earlier context (up to about 4,000 tokens) |
| `UserPromptSubmit` | each prompt | keeps the prompt in a local file until the turn ends |
| `Stop` | each finished turn | queues the prompt and answer locally, then sends them in a background process |
| `PreCompact` | before compaction | sends what is queued |
| `SessionEnd` | the session closes | starts a background send of what is queued and returns |

Self-hosted RushDB: set `apiUrl` (or `RUSHDB_API_URL`) to your instance. For
the MCP tools, add the local server next to the plugin:

```bash
codex mcp add rushdb-local --env RUSHDB_API_KEY=<key> --env RUSHDB_API_URL=<url> -- npx -y @rushdb/mcp-server@3.4.1
```

## What leaves your machine

- **MCP tools** send what Codex passes to each tool call to `https://mcp.rushdb.com/mcp`,
  and return the results. Codex connects to it when a session starts.
- **With automatic context `off`** (the default) the hooks exit at once. They
  write no files and make no network calls.
- **With `recall`**, each session start sends two search requests to your
  RushDB API URL, with a hash of the project (from the git remote or the
  folder path) and the session id, and adds the result to the session as
  historical context that may be outdated.
- **With `recall+persist`**, the hooks also send, to the same RushDB project,
  the last prompt and Codex's answer after each finished turn (each bounded in
  length). Turns wait in a local queue in the plugin's data folder until they
  are sent, and are sent again after a failure.
- Nothing goes anywhere other than the RushDB API URL you set. Hook errors go
  to `hooks.log` in the plugin's data folder, with keys removed. Hooks never
  block or fail a session.

## License

Apache-2.0. Source: https://github.com/rush-db/agent-plugins
