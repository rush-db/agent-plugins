# RushDB agent plugins

RushDB for coding agents and AI assistants. Give your agent a database it can
search, query and analyze: RAG over your records, structured and semantic search,
relationship traversal, and agentic analytics such as counts, groupings and time
series. Every package ships the RushDB MCP tools and skills, built from one
source in this repository.

Where a platform has hooks, the package also offers **automatic context**: it
recalls relevant earlier work at session start and stores finished turns in
your RushDB project. It is **off by default**; you turn it on yourself.

> Work in progress. The install commands below work once this repository and its
> listings are published.

## Install

| Platform                | Install                                                              | Automatic context           | MCP tools and sign-in                                    |
| ----------------------- | -------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------- |
| Claude Code             | `/plugin install rushdb --marketplace rush-db/agent-plugins`         | yes, off by default         | hosted `https://mcp.rushdb.com/mcp`, OAuth               |
| Qwen Code               | `qwen extensions install rush-db/agent-plugins:rushdb`               | yes, off by default         | hosted, OAuth (not yet verified in Qwen)                 |
| Gemini CLI              | `gemini extensions install https://github.com/rush-db/agent-plugins` | yes, off by default         | local `@rushdb/mcp-server`, API key                      |
| Antigravity (`agy`)     | `agy plugin install https://github.com/rush-db/agent-plugins`        | recall only, off by default | local `@rushdb/mcp-server`, API key                      |
| Codex (marketplace)     | `codex plugin marketplace add rush-db/agent-plugins`, then `codex plugin add rushdb@rushdb` | yes, off by default         | hosted, OAuth                                            |
| ChatGPT and Codex (app) | the OpenAI app directory, once listed                                | no                          | hosted, OAuth                                            |
| Pi                      | `pi install npm:@rushdb/pi`                                          | yes, off by default         | local `@rushdb/mcp-server` with an API key, or hosted    |
| DeepSeek Harness        | `dsh plugin --profile <p> add @rushdb/dsh`                           | yes, off by default         | built-in RushDB tools, API key                           |

- **Antigravity** reads its own manifest from this repository, and the RushDB
  guidance loads as an always-on rule. If you already use the Gemini CLI
  extension, `agy plugin import gemini` converts it instead. Antigravity's `Stop`
  hook doesn't receive the answer text, so the plugin only recalls there; it
  stores turns only when you ask through the MCP tools.
- **Qwen Code** installs the Claude Code package and runs its hooks, but it
  doesn't pass plugin settings to them. Export `RUSHDB_API_KEY` (and
  `RUSHDB_AUTO_CONTEXT` to turn context on) in your shell, or use the config file
  below.
- **Codex**: the first command adds the marketplace and the second installs the
  plugin (or pick it in `/plugins`). Codex asks you to trust plugin hooks: trust
  them in `/hooks` if you want automatic context.
- **ChatGPT and Codex app**: the directory build has no hooks, so no automatic
  context. Install either the app or the Codex marketplace plugin, not both.

Get an API key at [app.rushdb.com](https://app.rushdb.com). Automatic context
always needs one (or a [self-hosted engine](#self-hosted-rushdb)), even where the
MCP tools sign in with OAuth, because hooks can't use the agent's OAuth token.

## What you get

- **MCP tools** to read the schema, find, create and update records, aggregate
  and group, run semantic, vector and text search, follow relationships, and
  work with imports and connections.
- **Skills**, synced from [rush-db/skills](https://github.com/rush-db/skills):
  `rushdb-query-builder`, `rushdb-data-modeling`, `rushdb-faceted-search` and
  `rushdb-agent-memory`.
- **Commands** in Gemini CLI: `/rushdb:recall`, `/rushdb:remember` and
  `/rushdb:ask`.
- **Automatic context**, optional, described below.

## Automatic context

One switch, `auto_context`:

| Value            | What it does                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `off` (default)  | Hooks exit at once: no network calls, no local files.                                                 |
| `recall`         | At session start, recall relevant earlier context from your RushDB project and add it to the session. |
| `recall+persist` | Also store each finished turn, and the summary written at compaction, in your RushDB project.         |

The first of these that is set wins:

1. the plugin setting, where the platform has one (`claude plugin configure rushdb`
   in Claude Code, `gemini extensions config rushdb` in Gemini CLI);
2. the `RUSHDB_AUTO_CONTEXT` environment variable;
3. `~/.config/rushdb/config.json` (`$XDG_CONFIG_HOME/rushdb/config.json` when
   `XDG_CONFIG_HOME` is set), a file you write yourself (mode `0600`; the agent
   never writes it):

```json
{ "apiKey": "<your RushDB API key>", "autoContext": "recall+persist" }
```

Recalled context arrives under the heading "Context recalled from RushDB
(historical, may be outdated)" and is marked as data from earlier sessions, not
instructions. RushDB never blocks your work: if the network or the API is down,
hooks log the error and exit cleanly.

## What leaves your machine

- **MCP tools** send what the agent passes in a tool call to the RushDB MCP
  server or RushDB API you use. Where the plugin declares the hosted server
  (Claude Code, Qwen Code, Codex), the agent connects to
  `https://mcp.rushdb.com/mcp` at session start, before any tool is used, and
  asks you to sign in once. This happens whatever `auto_context` is set to.
- **With automatic context `off`** nothing else is sent. Hooks make no network
  calls and write no files.
- **With `recall`**, each session start (in Claude Code also on resume, after
  `/clear` and after compaction) sends two search requests, one for earlier
  turns and one for facts: a fixed question ("decisions, preferences,
  conventions and open work in this project"), a project scope (a hash of the
  git remote, or of the working directory when there is no remote, unless you
  set `RUSHDB_CONTEXT_SCOPE`) and the session id, so the current session is
  left out.
- **With `recall+persist`**, each finished turn sends the latest user message
  and the assistant's reply, each cut to a bounded length, with the same scope
  and session id, plus a summary of the two, the host and hook name (such as
  `claude:Stop`), a timestamp and the turn number. At compaction, the
  compaction summary is sent too. The first delivery checks for and creates two
  vector indexes in your project, `EPISODE.summary` and `MEMORY_FACT.text`, if
  they are missing.
- **Where it goes**: only to the RushDB API URL you configured
  (`https://api.rushdb.com/api/v1` for RushDB Cloud) or to your own engine. It
  is stored as records labelled `EPISODE` in your RushDB project. With a
  self-hosted engine you also configure an embedding provider, and the same
  text is sent there to be embedded.
- **On your machine**, with `recall+persist`: turns wait in a local outbox
  (`outbox/`) until they are delivered, `sessions/` keeps a turn counter per
  session, and in Codex `prompts/` holds the latest prompt until the turn ends.
  Files are named by a hash of the session id. Errors go to `hooks.log`
  (rotated at 1 MB, keys masked). All of these live in the plugin data
  directory, or in `~/.local/state/rushdb` when the platform has none.
- **Deleting it**: stored turns are ordinary `EPISODE` records in your project.
  Delete them, and the two vector indexes if you no longer want them, in the
  RushDB dashboard or with the MCP delete tools. Set `auto_context` back to
  `off` to stop sending.
- **DeepSeek Harness** uploads session logs to DeepSeek by default. `@rushdb/dsh`
  has an option to keep its context messages out of that upload.

## Self-hosted RushDB

Automatic context can reach your own RushDB in one of two ways.

**A self-hosted RushDB API**: set `RUSHDB_API_URL` (or the platform's API URL
setting) to your instance, together with its `RUSHDB_API_KEY`.

**A standalone RushDB engine**: set `RUSHDB_ENGINE_URL` and
`RUSHDB_ENGINE_TOKEN` (and optionally `RUSHDB_ENGINE_SCOPE`). An engine has no
managed embeddings, so also configure an OpenAI-compatible embedding provider
with all three of `RUSHDB_EMBEDDING_API_KEY`, `RUSHDB_EMBEDDING_MODEL` and
`RUSHDB_EMBEDDING_DIMENSIONS`, plus `RUSHDB_EMBEDDING_BASE_URL` for a provider
other than OpenAI (the default is `https://api.openai.com/v1`). Without them,
automatic context stays disabled and the reason goes to `hooks.log`. The same settings in the config file:

```json
{
  "autoContext": "recall+persist",
  "engineUrl": "<your engine URL>",
  "engineToken": "<your engine token>",
  "engineScope": "<optional scope>",
  "embedding": {
    "baseUrl": "<provider base URL>",
    "apiKey": "<provider API key>",
    "model": "<embedding model>",
    "dimensions": 1536
  }
}
```

Environment variables win over the config file. When `RUSHDB_ENGINE_URL` is
set, the engine is used instead of the API URL.

For the MCP tools in Claude Code, add the local MCP server next to the plugin:

```bash
claude mcp add rushdb-local --env RUSHDB_API_KEY=<key> --env RUSHDB_API_URL=<url> -- npx -y @rushdb/mcp-server@3.4.1
```

## Repository layout

- `shared/`: one copy of the listing text, MCP settings and skills pin used by
  every manifest. See [shared/README.md](shared/README.md).
- `skills/`: the synced skills, written by `pnpm sync:skills`.
- `scripts/`: `build.ts` writes every generated file (`--check` fails on
  drift); `sync-skills.ts` copies the pinned RushDB skills.
- `packages/`: the host-neutral runtime and the npm packages.
- `submissions/`: drafts of the listing submissions. See
  [submissions/README.md](submissions/README.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
