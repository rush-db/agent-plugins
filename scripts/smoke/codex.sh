#!/usr/bin/env bash
# Smoke test of the Codex marketplace plugin in a throwaway CODEX_HOME and HOME. Needs no login, no model and no
# RushDB key: `codex exec` talks to local fake services (scripts/smoke/codex-fake-services.mjs) for the model, the
# embeddings and the RushDB API.
#   1. marketplace add, plugin add, MCP server and skills;
#   2. automatic context off (the default): a full session makes no RushDB request and writes no plugin data;
#   3. automatic context on, from the shell env: the plugin hooks fire (SessionStart recall before the first model
#      request, UserPromptSubmit and Stop capture), which catches a Codex update that stops running plugin hooks;
#   4. with --engine: two sessions against a local rushdb/rushdb engine container; the second session's model
#      request carries what the first one stored.
# Nothing reaches a production service. The plugin's hosted MCP server is disabled in the scratch config.toml (the
# plugin's own .mcp.json is unchanged), and Codex runs behind the fake services' proxy, which logs and refuses every
# outside connection. The run fails if Codex tried to reach mcp.rushdb.com. With --remote, only
# `codex plugin marketplace add` goes around the proxy, to fetch the marketplace from GitHub.
# Hooks run with --dangerously-bypass-hook-trust, in place of trusting them in /hooks.
#   scripts/smoke/codex.sh [--remote] [--engine]
#   CODEX_BIN=/path/to/codex   the CLI to test (default: codex on PATH)
#   RUSHDB_TEST_IMAGE          engine image for --engine (default rushdb/rushdb:3.0.10)
#   SMOKE_KEEP=1               keep the scratch folder (requests.jsonl, outside.jsonl, CODEX_HOME) for a look
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
codex="${CODEX_BIN:-codex}"
source="$root"
engine=0
for arg in "$@"; do
  case "$arg" in
    --remote) source="rush-db/agent-plugins" ;;
    --engine) engine=1 ;;
    *) echo "unknown option $arg" >&2 && exit 2 ;;
  esac
done

scratch="$(mktemp -d)"
container=""
services=""
cleanup() {
  [[ -n "$services" ]] && kill "$services" 2>/dev/null || true
  [[ -n "$container" ]] && docker rm -f "$container" >/dev/null 2>&1 || true
  if [[ "${SMOKE_KEEP:-}" == 1 ]]; then echo "scratch kept: $scratch"; else rm -rf "$scratch"; fi
}
trap cleanup EXIT
export CODEX_HOME="$scratch/codex" HOME="$scratch/home"
mkdir -p "$CODEX_HOME" "$HOME" "$scratch/project"
# Only the variables a test sets reach the hooks.
unset RUSHDB_API_KEY RUSHDB_API_URL RUSHDB_AUTO_CONTEXT RUSHDB_CONTEXT_SCOPE RUSHDB_ENGINE_URL RUSHDB_ENGINE_TOKEN
unset CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT CLAUDE_PLUGIN_OPTION_API_KEY XDG_CONFIG_HOME XDG_STATE_HOME

fail() {
  echo "✗ $*" >&2
  exit 1
}
quiet() { "$@" 2>&1 | grep -v 'could not create PATH aliases' || true; }

echo "$("$codex" --version 2>/dev/null)"

# Local model provider, embeddings, RushDB API, and the proxy that keeps Codex off the network.
requests="$scratch/requests.jsonl"
outside="$scratch/outside.jsonl"
: >"$requests"
: >"$outside"
node "$root/scripts/smoke/codex-fake-services.mjs" "$requests" "$scratch/answer" >"$scratch/port" &
services=$!
for _ in $(seq 50); do [[ -s "$scratch/port" ]] && break || sleep 0.1; done
port="$(cat "$scratch/port")"
[[ -n "$port" ]] || fail "the fake services did not start"
proxy="http://127.0.0.1:$port"
export HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" https_proxy="$proxy" http_proxy="$proxy"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
unset ALL_PROXY all_proxy
# Starts a new stage: keeps the outside connections seen so far, then empties the request log.
reset_requests() {
  grep -E '"method":"(CONNECT|PROXY)"' "$requests" >>"$outside" || true
  : >"$requests"
}

# 1. Install.
if [[ "$source" == "$root" ]]; then
  quiet "$codex" plugin marketplace add "$source" >/dev/null
else
  quiet env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy "$codex" plugin marketplace add "$source" >/dev/null
fi
marketplace="$(quiet "$codex" plugin list)"
grep -q '\.agents/plugins/marketplace\.json' <<<"$marketplace" || fail "Codex did not read .agents/plugins/marketplace.json"
grep -q 'plugins/codex/rushdb' <<<"$marketplace" || fail "the marketplace entry does not point at plugins/codex/rushdb"
quiet "$codex" plugin add rushdb@rushdb >/dev/null
quiet "$codex" plugin list | grep -q 'rushdb@rushdb  *installed, enabled' || fail "rushdb@rushdb is not installed"
# Even `codex mcp list` connects to an enabled server, so the hosted server is turned off for this run first, with
# the plugin-scoped switch. The same file points Codex at the fake model provider.
config="$(cat "$CODEX_HOME/config.toml")"
cat >"$CODEX_HOME/config.toml" <<TOML
model = "fake-model"
model_provider = "fake"

$config

[plugins."rushdb@rushdb".mcp_servers.rushdb]
enabled = false

[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:$port/v1"
wire_api = "responses"
TOML
quiet "$codex" mcp list | grep -Eq 'rushdb +https://mcp\.rushdb\.com/mcp .*disabled' ||
  fail "the plugin's rushdb MCP server is missing, or not disabled for this run"
skills="$(cd "$scratch/project" && quiet "$codex" debug prompt-input hi)"
for skill in rushdb-query-builder rushdb-data-modeling rushdb-faceted-search rushdb-agent-memory rushdb-setup; do
  grep -q "$skill" <<<"$skills" || fail "skill $skill is not loaded"
done
echo "✓ installed rushdb@rushdb from $source: the MCP server (turned off for this run) and 5 skills"
echo "fake-key-for-the-local-provider" | quiet "$codex" login --with-api-key >/dev/null

plugin_data="$CODEX_HOME/plugins/data/rushdb-rushdb"
# session <prompt> [answer]: one `codex exec` turn; the fake model replies with [answer].
session() {
  printf '%s' "${2:-}" >"$scratch/answer"
  (cd "$scratch/project" && quiet "$codex" exec --skip-git-repo-check --dangerously-bypass-hook-trust "$1" </dev/null) \
    >>"$scratch/sessions.log"
}
count() { grep -c "\"path\":\"$1" "$requests" || true; }
wait_for_outbox() {
  for _ in $(seq 100); do
    [[ -z "$(ls -A "$plugin_data/outbox" 2>/dev/null | grep -v '^\.' || true)" ]] && return 0
    sleep 0.1
  done
  fail "the outbox was not flushed: $(ls "$plugin_data/outbox")"
}

# 2. Off by default: no RushDB request and no plugin data, even with a key in the env.
RUSHDB_API_KEY=fake-key RUSHDB_API_URL="http://127.0.0.1:$port/api/v1" session "Which package manager do we use?"
[[ "$(count /v1/responses)" -ge 1 ]] || fail "the session made no model request"
[[ "$(count /api/v1/)" -eq 0 ]] || fail "automatic context off, yet hooks sent $(count /api/v1/) RushDB requests"
[[ -z "$(find "$plugin_data" -type f 2>/dev/null)" ]] || fail "automatic context off, yet hooks wrote $(find "$plugin_data" -type f)"
echo "✓ automatic context off: a full session sent no RushDB request and wrote no file"

# 3. On, from the shell env: every hook fires.
reset_requests
RUSHDB_AUTO_CONTEXT=recall+persist RUSHDB_API_KEY=fake-key RUSHDB_API_URL="http://127.0.0.1:$port/api/v1" \
  session "Which package manager do we use?" "Decision: we use pnpm workspaces, never npm."
first_model="$(grep -n '"path":"/v1/responses' "$requests" | head -1 | cut -d: -f1 || true)"
first_recall="$(grep -n '"path":"/api/v1/' "$requests" | head -1 | cut -d: -f1 || true)"
[[ -n "$first_recall" ]] || fail "plugin hooks did not fire: no RushDB request (Codex may skip plugin hooks again)"
[[ "$first_recall" -lt "$first_model" ]] || fail "SessionStart recall did not run before the first model request"
[[ -n "$(ls -A "$plugin_data/sessions" 2>/dev/null)" ]] || fail "Stop did not capture the turn (no sessions/ entry)"
wait_for_outbox
echo "✓ automatic context on: SessionStart recalled before the model request, UserPromptSubmit and Stop captured the turn, the flush emptied the outbox"

# 4. Two sessions through a local engine.
if [[ "$engine" == 1 ]]; then
  token="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
  engine_port="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  container="agent-plugins-codex-smoke-$$"
  docker run -d --rm --name "$container" -p "127.0.0.1:$engine_port:3000" -e RUSHDB_TOKEN="$token" \
    "${RUSHDB_TEST_IMAGE:-rushdb/rushdb:3.0.10}" >/dev/null
  for _ in $(seq 120); do curl -s -o /dev/null "http://127.0.0.1:$engine_port" && break || sleep 0.5; done
  export RUSHDB_AUTO_CONTEXT=recall+persist RUSHDB_ENGINE_URL="http://127.0.0.1:$engine_port" RUSHDB_ENGINE_TOKEN="$token"
  export RUSHDB_EMBEDDING_BASE_URL="http://127.0.0.1:$port/v1" RUSHDB_EMBEDDING_API_KEY=fake RUSHDB_EMBEDDING_MODEL=fake
  export RUSHDB_EMBEDDING_DIMENSIONS=64 RUSHDB_CONTEXT_SCOPE="codex-smoke-$$"
  session "Which package manager do we use?" "Decision: we use pnpm workspaces, never npm."
  wait_for_outbox
  reset_requests
  session "Set up a new package in this repo."
  model_request="$(grep '"path":"/v1/responses' "$requests" | head -1 || true)"
  grep -q 'Context recalled from RushDB' <<<"$model_request" || fail "session B got no recalled context"
  grep -q 'pnpm workspaces' <<<"$model_request" || fail "session B's recalled context misses session A's decision"
  echo "✓ engine: session B's first model request carries session A's decision"
fi

# 5. Nothing reached production. Codex did go through the proxy (it tries its own services, which the proxy refused),
# and it never tried the hosted RushDB MCP server.
reset_requests
[[ -s "$outside" ]] || fail "Codex made no request through the proxy; HTTPS_PROXY may be ignored, so the check below proves nothing"
if grep -q 'rushdb\.com' "$outside"; then
  fail "Codex tried to reach RushDB production: $(grep -o '"path":"[^"]*rushdb\.com[^"]*"' "$outside" | sort -u | tr '\n' ' ')"
fi
hosts="$(grep -o '"path":"[^"]*"' "$outside" | cut -d'"' -f4 | sort -u | tr '\n' ' ')"
echo "✓ no connection to mcp.rushdb.com or any rushdb.com host; the proxy refused all outside requests: $hosts"
