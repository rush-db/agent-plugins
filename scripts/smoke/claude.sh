#!/usr/bin/env bash
# Smoke test of the Claude Code plugin in a throwaway CLAUDE_CONFIG_DIR: validators, marketplace add, install,
# component inventory and options. Needs no model and no RushDB key.
#   scripts/smoke/claude.sh            install from this checkout
#   scripts/smoke/claude.sh --remote   install from github.com/rush-db/agent-plugins (after go-live)
#   CLAUDE_BIN=/path/to/claude         the CLI to test (default: claude on PATH)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
claude="${CLAUDE_BIN:-claude}"
source="$root"
[[ "${1:-}" == "--remote" ]] && source="rush-db/agent-plugins"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export CLAUDE_CONFIG_DIR="$scratch/.claude"

fail() {
  echo "✗ $*" >&2
  exit 1
}

echo "claude $("$claude" --version)"
if [[ "$source" == "$root" ]]; then
  "$claude" plugin validate "$root/plugins/claude/rushdb" | tail -1
  "$claude" plugin validate "$root" | tail -1
  # Fails only on PRIVACY_URL_MISSING until the owner sets the privacy policy URL (plan decision D6).
  "$claude" plugin validate --strict --profile directory "$root/plugins/claude/rushdb" | tail -1 || true
fi

"$claude" plugin marketplace add "$source" >/dev/null
"$claude" plugin install rushdb@rushdb >/dev/null
details="$("$claude" plugin details rushdb@rushdb)"
echo "$details" | grep -E '^  (Skills|Hooks|MCP servers) '
grep -q 'Skills (4)' <<<"$details" || fail "expected 4 skills"
grep -q 'Hooks (5)  SessionStart, Stop, PreCompact, PostCompact, SessionEnd' <<<"$details" || fail "expected 5 hooks"
grep -q 'MCP servers (1)  rushdb' <<<"$details" || fail "expected the rushdb MCP server"

options="$("$claude" plugin configure rushdb@rushdb)"
for option in api_key api_url auto_context context_scope; do
  grep -q "$option" <<<"$options" || fail "option $option missing"
done
echo '{"auto_context":"recall+persist"}' | "$claude" plugin configure rushdb@rushdb --values-stdin >/dev/null
grep -q '"auto_context": "recall+persist"' "$CLAUDE_CONFIG_DIR/settings.json" || fail "auto_context was not saved"
echo "✓ Claude Code: installed rushdb@rushdb from $source"
