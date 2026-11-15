# Shared sources

Every platform manifest and listing is generated from the files here by
`pnpm build`. Edit these, never the generated files.

| File          | What it holds                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `listing.json` | Names, the fallback name, descriptions (with each directory's length limit), keywords, author and URLs        |
| `mcp.json`     | The hosted MCP URL and the exact `@rushdb/mcp-server` version for stdio launches, with its environment variables |
| `skills.json`  | The `rush-db/skills` tag and the skills every package ships; `pnpm sync:skills` copies them into `skills/`     |

`pnpm build --check` validates these files: description lengths, no "memory" in
names, https URLs, an exact MCP server version and a skills tag of `v3.0.4` or
later.
