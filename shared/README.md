# Shared sources

Every platform manifest and listing is generated from the files here by
`pnpm build`. Edit these, never the generated files.

| File          | What it holds                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `listing.json` | Names, the fallback name, descriptions (with each directory's length limit), keywords, author and URLs        |
| `mcp.json`     | The hosted MCP URL and the exact `@rushdb/mcp-server` version for stdio launches, with its environment variables |
| `skills.json`  | The `rush-db/skills` tag and the skills every package ships; `pnpm sync:skills` copies them into `skills/`     |
| `openai-review.json` | OpenAI category and capabilities, the hooks-free directory description, the 5 positive and 3 negative review cases, and release notes. The cases assume a demo project with `ARTICLE`, `ORDER`, `CUSTOMER` and `NOTE` records; seed the reviewer account to match. `demo_recording_url` stays `null` until the owner records the demo. |
| `codex/`       | The Codex plugin README and the `rushdb-setup` onboarding skill, as templates |

`pnpm build --check` validates these files: description lengths, no "memory" in
names, https URLs, an exact MCP server version and a skills tag of `v3.0.4` or
later.
