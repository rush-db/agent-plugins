# RushDB agent plugins

RushDB for agent platforms: MCP tools and skills for RAG, querying and agentic
analytics over your data, from one repo. Where a platform has hooks, each
package also offers an optional automatic context capability. It is **off by
default**.

> Work in progress. The install commands below work once this repository and
> its listings are published.

## Install

| Platform | Install | Automatic context | MCP auth |
|---|---|---|---|
| Claude Code | `/plugin install rushdb --marketplace rush-db/agent-plugins` | optional, off by default | OAuth (hosted) |
| Qwen Code | `qwen extensions install rush-db/agent-plugins:rushdb` | optional, off by default | to be confirmed |
| Gemini CLI | `gemini extensions install https://github.com/rush-db/agent-plugins` | optional, off by default | API key |
| Antigravity | `agy plugin install https://github.com/rush-db/agent-plugins` | optional, off by default | API key |
| Codex | `codex plugin marketplace add rush-db/agent-plugins` | optional, off by default | OAuth (hosted) |
| Pi | `pi install npm:@rushdb/pi` | optional, off by default | to be confirmed |
| DeepSeek Harness | `dsh plugin --profile <p> add @rushdb/dsh` | optional, off by default | API key |

## What leaves your machine

With automatic context `off`, the hooks make no network calls. MCP tools send
only what the agent passes to them.

## Repository layout

- `shared/`: one copy of the listing text, MCP settings and skills pin used by
  every manifest.
- `scripts/`: `build.ts` writes every generated file (`--check` fails on
  drift); `sync-skills.ts` copies the pinned RushDB skills into `skills/`.
- `packages/`: the host-neutral runtime and the npm packages.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
