# Vendored schemas

`agent-plugins-1.0.0/` holds the Agent Plugins 1.0.0 schemas, copied unchanged
from <https://agent-plugins.org/schemas/1.0.0/plugin.schema.json> and
<https://agent-plugins.org/schemas/1.0.0/mcp.schema.json> on 2026-11-15.
`scripts/check-codex.ts` and `scripts/check-openai.ts` validate the Codex and
OpenAI manifests against them offline. Codex has no validator command, and
agent-plugins.org publishes no marketplace or hooks schema, so those two files
are checked by hand in `scripts/lib/openai.ts`.
