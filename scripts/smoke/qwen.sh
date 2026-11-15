#!/usr/bin/env bash
# Smoke test of the Claude marketplace route in Qwen Code (>= 0.27.4) in a throwaway HOME: install, components, and
# the hooks with automatic context off. Needs no model and no RushDB key.
#   scripts/smoke/qwen.sh            install from this checkout
#   scripts/smoke/qwen.sh --remote   install rush-db/agent-plugins:rushdb from GitHub (after go-live)
#   QWEN_BIN=/path/to/qwen           the CLI to test (default: qwen on PATH)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
qwen="${QWEN_BIN:-qwen}"
source="$root"
[[ "${1:-}" == "--remote" ]] && source="rush-db/agent-plugins"

scratch="$(mktemp -d)"
cleanup() {
  rm -rf "$scratch"
  # Qwen 0.27.4 leaves its converted copy (plugin<sha256>/) in a local marketplace folder.
  [[ "$source" == "$root" ]] && find "$root" -maxdepth 1 -type d -regex '.*/plugin[0-9a-f]\{64\}' -exec rm -rf {} +
  return 0
}
trap cleanup EXIT
export HOME="$scratch" XDG_CONFIG_HOME="$scratch/.config" XDG_STATE_HOME="$scratch/.local/state"
unset RUSHDB_API_KEY RUSHDB_AUTO_CONTEXT RUSHDB_ENGINE_URL RUSHDB_ENGINE_TOKEN

fail() {
  echo "✗ $*" >&2
  exit 1
}

version="$("$qwen" --version)"
echo "qwen $version"
printf '%s\n%s\n' 0.27.4 "$version" | sort -V -C || fail "Qwen Code 0.27.4 or later is required"

"$qwen" extensions install "$source:rushdb" --consent >/dev/null
list="$("$qwen" extensions list 2>&1)"
grep -q '✓ rushdb' <<<"$list" || fail "rushdb is not installed"
grep -q 'Origin: Claude' <<<"$list" || fail "rushdb was not installed from the Claude marketplace"
for skill in rushdb-agent-memory rushdb-data-modeling rushdb-faceted-search rushdb-query-builder; do
  grep -q "$skill" <<<"$list" || fail "skill $skill missing"
done
grep -A1 'MCP servers:' <<<"$list" | grep -q rushdb || fail "MCP server rushdb missing"

extension="$HOME/.qwen/extensions/rushdb"
[[ -f "$extension/hooks/hooks.json" && -f "$extension/hooks/rushdb-hooks.mjs" ]] || fail "hooks were not copied"
# Automatic context is off by default: the hooks print nothing, exit 0 and write nothing.
for command in recall capture end; do
  output="$(echo '{"session_id":"smoke","hook_event_name":"SessionStart","cwd":"/"}' |
    node "$extension/hooks/rushdb-hooks.mjs" "$command" --host claude)"
  [[ -z "$output" ]] || fail "$command printed output with automatic context off"
done
[[ ! -e "$XDG_STATE_HOME/rushdb" ]] || fail "hooks wrote state with automatic context off"
echo "✓ Qwen Code: installed rushdb from $source"
