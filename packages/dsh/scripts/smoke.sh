#!/usr/bin/env bash
# Installs the packed @rushdb/dsh into a scratch DSH_HOME with a pinned dsh and checks what dsh makes of it:
#   1. `dsh plugin --profile rtest add <tarball>`, then `--dump-config` shows the `rushdb` row;
#   2. `--dump-config-schema` carries the plugin's Config;
#   3. a headless boot with automatic context off sends nothing to RushDB and writes no RushDB files;
#   4. a headless boot with recall on sends a recall request before the first step.
# The boots have no DeepSeek key, so each turn ends at the model call; everything before it runs for real.
# No RushDB service is used: a local stand-in answers on 127.0.0.1.
#   DSH_VERSION  dsh to install (default 0.2.2-rc.3)
#   DSH_BIN      use this dsh binary instead of installing one
#   SMOKE_PNPM_VERSION  pnpm that dsh installs plugins with (default 10.28.1)
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

# A RushDB stand-in that logs every request.
port="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
node -e '
  const [log, port] = process.argv.slice(1)
  require("node:http").createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      require("node:fs").appendFileSync(log, `${request.method} ${request.url}\n`)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ success: true, data: [], total: 0 }))
    })
  }).listen(Number(port), "127.0.0.1")
' "$scratch/requests.log" "$port" &
server_pid=$!
touch "$scratch/requests.log"
sleep 0.5

"$dsh" plugin --profile headless add "$tarball" >/dev/null
boot() {
  printf -- '- id: rushdb\n  config:\n    url: http://127.0.0.1:%s/api/v1\n%s\n' "$port" "$1" >"$scratch/patch.yml"
  : >"$scratch/requests.log"
  (cd "$scratch/work" && RUSHDB_API_KEY=smoke-key-not-real DEEPSEEK_API_KEY= \
    "$dsh" headless --patch "$scratch/patch.yml" "Which package manager does this project use?" \
    >/dev/null 2>"$scratch/boot.err") || true
  grep -q "did not activate" "$scratch/boot.err" && fail "the rushdb row did not activate: $(cat "$scratch/boot.err")"
  return 0
}

# 3. Off (the default): no requests, no files.
boot '    contextScope: smoke'
[[ ! -s "$scratch/requests.log" ]] || fail "automatic context off still sent: $(cat "$scratch/requests.log")"
[[ ! -e "$DSH_HOME/rushdb" ]] || fail "automatic context off still wrote $DSH_HOME/rushdb"
echo "smoke: automatic context off: 0 requests, no RushDB files"

# 4. Recall on: the pre-step asks RushDB before the model call.
boot '    contextScope: smoke
    autoContext: { recall: true }'
grep -q "POST /api/v1/ai/search" "$scratch/requests.log" || fail "recall on sent no search: $(cat "$scratch/boot.err")"
echo "smoke: recall on: $(grep -c "ai/search" "$scratch/requests.log") recall searches before the model call"

echo "smoke: OK"
