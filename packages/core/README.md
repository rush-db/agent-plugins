# @rushdb/agent-plugins-core

Private, host-neutral runtime shared by the hook CLI (`packages/hooks`), `@rushdb/pi` and `@rushdb/dsh`. It is bundled
into each of them and never published on its own.

| Module                     | What it does                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                | `resolveConfig()`: the `auto_context` switch (`off` by default; `CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT`, `RUSHDB_AUTO_CONTEXT`, then the config file), the key (`CLAUDE_PLUGIN_OPTION_API_KEY`, `RUSHDB_API_KEY`, then `${XDG_CONFIG_HOME:-~/.config}/rushdb/config.json`), Cloud or a standalone engine, the state directory |
| `scope.ts`                 | `resolveContextScope()`: contract scope from the host's session id and the project (hash of the git remote, or of `cwd`; `RUSHDB_CONTEXT_SCOPE` overrides)                                                                                                                                                                |
| `recall.ts`                | `recallContext()`: recall with a 1.5 s timeout, formatted under a "Context recalled from RushDB" heading, about 8 KB at most, current session left out                                                                                                                                                                    |
| `episode.ts`               | `buildEpisode()`: a bounded user/assistant pair as a contract episode with `sourceEventId = <session>:<turn>`; `claimTurnIndex()` for hosts that don't number turns                                                                                                                                                       |
| `messages.ts`, `outbox.ts` | Ported from `rushdb-openclaw-memory`: latest conversation pair, durable outbox                                                                                                                                                                                                                                            |
| `flush.ts`                 | `flushOutbox()` (one flush per outbox, bounded by a deadline) and `spawnDetachedFlush()` for `SessionEnd`                                                                                                                                                                                                                 |
| `logger.ts`, `timeout.ts`  | `hooks.log` in the state directory, rotated at 1 MB, secrets masked; `withTimeout()` and `failOpen()` never reject                                                                                                                                                                                                        |

## Tests

```sh
pnpm test               # unit tests
pnpm test:integration   # starts rushdb/rushdb:3.0.10 on a free local port (direct mode), runs src/*.integration.test.ts, removes it
```
