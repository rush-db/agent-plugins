#!/usr/bin/env bash
# Installs the packed @rushdb/dsh into a scratch DSH_HOME with a pinned dsh and checks what dsh makes of it:
#   1. `dsh plugin --profile rtest add <tarball>`, then `--dump-config` shows the `rushdb` row;
#   2. `--dump-config-schema` carries the plugin's Config;
#   3. a headless turn with automatic context off sends nothing to RushDB and writes no RushDB files;
#   4. a headless turn with recall on sends recall searches before the model call;
#   5. excludeFromLogUpload: a resumed session that received RushDB context in an earlier run uploads none of it
#      (and, as a control, does upload it with the option off);
#   6. a RushDB that accepts the connection and never answers, and one at an address that drops packets: dsh exits
#      within ANSWER_EXIT_BOUND_S of the answer, a tool call ends with an error result, and the captured turns wait in
#      the outbox until the next run sends them;
#   8. behind dsh's HTTP proxy (HTTP_PROXY/HTTPS_PROXY), RushDB is reached through the proxy.
# Real `dsh headless` turns run to the end against local stand-ins for RushDB and the DeepSeek API
# (scripts/stand-ins.mjs) on 127.0.0.1; no RushDB service and no DeepSeek key are used.
#   DSH_VERSION  dsh to install (default 0.2.2-rc.3)
#   DSH_BIN      use this dsh binary instead of installing one
#   SMOKE_PNPM_VERSION  pnpm that dsh installs plugins with (default 10.28.1)
#   SMOKE_BLACKHOLE_URL  a RushDB URL whose address drops packets (default http://10.255.255.1/api/v1)
#   SMOKE_KEEP=1 keep the scratch directory (dsh's logs are under home/profiles/*/.plugin-manager/logs)
set -euo pipefail

# Run through `pnpm smoke`, this script inherits pnpm's own settings, which would leak into the pnpm that dsh runs.
while IFS= read -r name; do unset "$name"; done < <(env | grep -oiE '^(npm_|pnpm_)[^=]*' || true)

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dsh_version="${DSH_VERSION:-0.2.2-rc.3}"
pnpm_version="${SMOKE_PNPM_VERSION:-10.28.1}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/rushdb-dsh-smoke.XXXXXX")"
trap 'kill "${server_pid:-}" 2>/dev/null || true; [[ "${SMOKE_KEEP:-}" == 1 ]] || rm -rf "$scratch"' EXIT

fail() {
  echo "smoke: FAIL: $*" >&2
  exit 1
}

# dsh installs plugins with the pnpm on PATH, and pnpm 10.1.0 (this repo's own) refuses to add to a profile, so the
# smoke brings a newer one. npm runs from the scratch directory: started inside this pnpm workspace, it aborts.
tools=("pnpm@$pnpm_version")
[[ -n "${DSH_BIN:-}" ]] || tools+=("@deepseek-ai/dsh@$dsh_version")
(cd "$scratch" && npm install --prefix "$scratch/cli" --no-audit --no-fund --silent "${tools[@]}")
export PATH="$scratch/cli/node_modules/.bin:$PATH"
dsh="${DSH_BIN:-$scratch/cli/node_modules/.bin/dsh}"
echo "smoke: dsh $("$dsh" --version), pnpm $(cd "$scratch" && pnpm --version)"

(cd "$package_dir" && pnpm pack --pack-destination "$scratch" >/dev/null)
tarball="$(ls "$scratch"/rushdb-dsh-*.tgz)"

export DSH_HOME="$scratch/home"
export HOME="$DSH_HOME"
mkdir -p "$DSH_HOME" "$scratch/work"

# 1. Install and compose.
"$dsh" plugin --profile rtest add "$tarball" >/dev/null
"$dsh" --profile rtest --dump-config >"$scratch/config.yml"
grep -q "^- id: rushdb$" "$scratch/config.yml" || fail "--dump-config has no rushdb row"
echo "smoke: --dump-config shows the rushdb row"

# 2. The composed schema carries our Config.
"$dsh" --profile rtest --dump-config-schema >"$scratch/schema.json"
node -e '
  const schema = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  const wanted = ["apiKeyRef", "autoContext", "recallTimeoutMs", "excludeFromLogUpload"]
  const found = (node) => node && typeof node === "object" &&
    ((node.properties && wanted.every((key) => key in node.properties)) || Object.values(node).some(found))
  if (!found(schema)) { console.error("no rushdb Config in the schema"); process.exit(1) }
' "$scratch/schema.json" || fail "--dump-config-schema lacks the rushdb Config"
echo "smoke: --dump-config-schema carries the rushdb Config"

# Stand-ins for RushDB and the DeepSeek API.
node "$package_dir/scripts/stand-ins.mjs" "$scratch" &
server_pid=$!
for _ in $(seq 50); do [[ -s "$scratch/rushdb.port" && -s "$scratch/model.port" && -s "$scratch/proxy.port" ]] && break; sleep 0.1; done
rushdb_url="http://127.0.0.1:$(cat "$scratch/rushdb.port")/api/v1"
model_url="http://127.0.0.1:$(cat "$scratch/model.port")"
proxy_url="http://127.0.0.1:$(cat "$scratch/proxy.port")"

# The bound documented in the README: after the answer, at most about 5 s (a 2 s flush of captured turns, the outbox's
# retry back-off, teardown). The check allows some slack for a slow CI runner.
ANSWER_EXIT_BOUND_S=8

"$dsh" plugin --profile headless add "$tarball" >/dev/null

# boot <rushdb mode> <rushdb row config lines> <prompt> [dsh args...]: one headless turn. Writes the answer to
# answer.txt, and to timing.json the exit code and the milliseconds from the answer to the exit.
boot() {
  local mode="$1" config="$2" prompt="$3"
  shift 3
  echo "$mode" >"$scratch/rushdb.mode"
  printf -- '- id: rushdb\n  config:\n    url: %s\n    contextScope: smoke\n%s\n' "${url:-$rushdb_url}" "$config" \
    >"$scratch/patch.yml"
  : >"$scratch/rushdb.log"
  : >"$scratch/model.log"
  : >"$scratch/proxy.log"
  local proxy_env=()
  [[ -z "${proxy:-}" ]] || proxy_env=("HTTP_PROXY=$proxy" "HTTPS_PROXY=$proxy")
  (cd "$scratch/work" && env "${proxy_env[@]}" RUSHDB_API_KEY=smoke-key-not-real DEEPSEEK_API_KEY=smoke-model-key \
    DEEPSEEK_BASE_URL="$model_url" node -e '
      const { spawn } = require("node:child_process")
      const fs = require("node:fs")
      const [answerFile, timingFile, dsh, ...args] = process.argv.slice(1)
      const child = spawn(dsh, args, { stdio: ["ignore", "pipe", "inherit"] })
      let answer = "", answeredAt
      child.stdout.on("data", (chunk) => { answer += chunk; answeredAt ??= Date.now() })
      const kill = setTimeout(() => child.kill("SIGKILL"), 180_000)
      child.on("exit", (code, signal) => {
        clearTimeout(kill)
        fs.writeFileSync(answerFile, answer)
        fs.writeFileSync(timingFile, JSON.stringify({ code, signal, afterAnswerMs: answeredAt ? Date.now() - answeredAt : null }))
      })
    ' "$scratch/answer.txt" "$scratch/timing.json" "$dsh" headless --patch "$scratch/patch.yml" "$@" "$prompt" \
    2>"$scratch/boot.err")
  grep -q "did not activate" "$scratch/boot.err" && fail "the rushdb row did not activate: $(cat "$scratch/boot.err")"
  grep -q "^ANSWER:" "$scratch/answer.txt" || fail "no answer: $(cat "$scratch/answer.txt" "$scratch/boot.err")"
  return 0
}
timing() { node -p "JSON.parse(require('node:fs').readFileSync('$scratch/timing.json', 'utf8')).$1"; }
outbox_count() { find "$DSH_HOME/rushdb/outbox" -name '*.json' 2>/dev/null | wc -l; }

# 3. Off (the default): no requests, no files.
boot ok '    autoContext: { recall: false }' "Which package manager does this project use?"
[[ ! -s "$scratch/rushdb.log" ]] || fail "automatic context off still sent: $(cat "$scratch/rushdb.log")"
[[ ! -e "$DSH_HOME/rushdb" ]] || fail "automatic context off still wrote $DSH_HOME/rushdb"
echo "smoke: automatic context off: a full turn, 0 requests, no RushDB files"

# 4. Recall on: the pre-step asks RushDB before the model call.
boot ok '    autoContext: { recall: true }' "Which package manager does this project use?"
grep -q "POST /api/v1/ai/search" "$scratch/rushdb.log" || fail "recall on sent no search: $(cat "$scratch/boot.err")"
echo "smoke: recall on: $(grep -c "ai/search" "$scratch/rushdb.log") recall searches before the model call"

# 5. excludeFromLogUpload survives a resume. The first run gets recalled context; the resumed one finds nothing new.
excluded='    autoContext: { recall: true }
    excludeFromLogUpload: true'
boot hit "$excluded" "Which package manager does this project use?"
! grep -q '"upload":true' "$scratch/model.log" || fail "a session with RushDB context was uploaded: $(cat "$scratch/model.log")"
session_id="$(basename "$(ls -td "$DSH_HOME"/sessions/*/session-* | head -1)")"
boot ok "$excluded" "And which test runner does it use?" --session-id "$session_id"
! grep -q '"upload":true' "$scratch/model.log" || fail "the resumed session was uploaded: $(cat "$scratch/model.log")"
boot ok '    autoContext: { recall: true }' "And the linter?" --session-id "$session_id"
grep -q '"uploadHasContext":true' "$scratch/model.log" ||
  fail "control: with the option off, the resumed upload should carry the earlier context: $(cat "$scratch/model.log")"
echo "smoke: excludeFromLogUpload: the resumed session uploads nothing (with the option off it uploads the earlier context)"

# 6. RushDB accepts the connection and never answers.
boot hang '    autoContext: { recall: true, capture: true }' "Which package manager does this project use?"
after="$(timing afterAnswerMs)"
[[ "$(timing code)" == 0 ]] || fail "dsh exited with $(cat "$scratch/timing.json")"
((after <= ANSWER_EXIT_BOUND_S * 1000)) || fail "dsh exited ${after} ms after the answer, over ${ANSWER_EXIT_BOUND_S} s"
[[ "$(outbox_count)" == 1 ]] || fail "the captured turn is not in the outbox ($(outbox_count) files)"
echo "smoke: RushDB never answers, recall and capture: exit ${after} ms after the answer, the turn waits in the outbox"

boot hang '    autoContext: { recall: false }' "CALL_RUSHDB_QUERY: how many orders are there?"
after="$(timing afterAnswerMs)"
grep -q '"toolError":true' "$scratch/model.log" || fail "the rushdb_query call did not end with an error result"
((after <= ANSWER_EXIT_BOUND_S * 1000)) || fail "dsh exited ${after} ms after the answer, over ${ANSWER_EXIT_BOUND_S} s"
echo "smoke: RushDB never answers, tool call: an error result at its deadline, exit ${after} ms after the answer"

# 7. An address that drops packets: every connect hangs, not just the answer.
url="${SMOKE_BLACKHOLE_URL:-http://10.255.255.1/api/v1}" \
  boot ok '    autoContext: { recall: true, capture: true }' "Which package manager does this project use?"
after="$(timing afterAnswerMs)"
[[ "$(timing code)" == 0 ]] || fail "dsh exited with $(cat "$scratch/timing.json")"
((after <= ANSWER_EXIT_BOUND_S * 1000)) || fail "dsh exited ${after} ms after the answer, over ${ANSWER_EXIT_BOUND_S} s"
[[ "$(outbox_count)" == 2 ]] || fail "the captured turns are not in the outbox ($(outbox_count) files)"
echo "smoke: RushDB address drops packets, recall and capture: exit ${after} ms after the answer, the turn waits in the outbox"

# The next run, with RushDB answering, sends the waiting turns along with its own.
boot ok '    autoContext: { capture: true }' "And which test runner does it use?"
[[ "$(outbox_count)" == 0 ]] || fail "the outbox still holds $(outbox_count) turns"
(($(grep -c "POST /api/v1/records$" "$scratch/rushdb.log") >= 3)) ||
  fail "the waiting turns were not sent: $(cat "$scratch/rushdb.log")"
echo "smoke: the next run sent the waiting turns; the outbox is empty"

# 8. Behind dsh's HTTP proxy: RushDB at a host only the proxy reaches (the model stays direct: dsh never proxies
# loopback).
proxy="$proxy_url" url="http://rushdb.smoke-proxy.invalid/api/v1" \
  boot hit '    autoContext: { recall: true, capture: true }' "Which package manager does this project use?"
grep -q "POST http://rushdb.smoke-proxy.invalid/api/v1/ai/search" "$scratch/proxy.log" ||
  fail "recall did not go through the proxy: $(cat "$scratch/proxy.log" "$scratch/boot.err")"
grep -q "POST http://rushdb.smoke-proxy.invalid/api/v1/records$" "$scratch/proxy.log" ||
  fail "capture did not go through the proxy: $(cat "$scratch/proxy.log")"
grep -q "POST /api/v1/ai/search" "$scratch/rushdb.log" || fail "the proxy did not reach RushDB"
[[ "$(outbox_count)" == 0 ]] || fail "turns were left in the outbox behind the proxy"
echo "smoke: behind HTTP_PROXY: recall and capture went through the proxy ($(wc -l <"$scratch/proxy.log") requests)"

echo "smoke: OK"
