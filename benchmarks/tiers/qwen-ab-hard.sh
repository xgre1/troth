#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Qwen A/B on a REAL project — 4-bug Express/SQLite task manager.
# Same method as qwen-ab.sh but runs against benchmarks/seeds/01-bugfix
# which has 4 intentional bugs across filter, priority validation,
# status transitions, and delete auth. The agent must use multiple
# tools (Read, Edit, Bash for npm test) and the tests verify via HTTP.
#
# This replaces the trivial null-guard A/B as the headline scaffolding
# measurement — much closer to real dev work.
#
# Usage: bash benchmarks/tiers/qwen-ab-hard.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEED="$ROOT/benchmarks/seeds/01-bugfix"
SCRATCH_OFF="/tmp/gc-qwen-hard-off"
SCRATCH_ON="/tmp/gc-qwen-hard-on"
PORT="${GF_PORT:-8094}"
CONFIG="$HOME/.troth/config.json"
BACKUP="$HOME/.troth/config.json.bench-hard.bak"

PROMPT='Four tests in test.js fail against server.js. Each failure corresponds to a real bug in server.js marked with a `// BUG N:` comment. Read server.js and test.js, fix all four bugs in server.js, and run `npm test` to verify 9/9 tests pass. Do not modify test.js.'

setup_scratch() {
  local dst="$1"
  rm -rf "$dst"
  mkdir -p "$dst"
  cp "$SEED/server.js" "$SEED/test.js" "$dst/"
  cat > "$dst/package.json" <<'PKG'
{
  "name": "gc-bugfix-bench",
  "private": true,
  "version": "0.0.0",
  "scripts": { "test": "node test.js" },
  "dependencies": { "express": "^4.21.0", "better-sqlite3": "^12.0.0" }
}
PKG
  (cd "$dst" && npm install --silent --no-audit --no-fund > /dev/null 2>&1)
}

verify_scratch() {
  local dst="$1"
  (cd "$dst" && npm test --silent > /tmp/gc-qwen-hard-verify.log 2>&1) && echo "yes" || echo "no"
}

cp "$CONFIG" "$BACKUP"
trap 'cp "$BACKUP" "$CONFIG"; rm -f "$BACKUP"; lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true' EXIT

toggle_modules() {
  local state="$1"
  python3 - "$CONFIG" "$state" <<'PY'
import json, sys
path, state = sys.argv[1], sys.argv[2] == "true"
with open(path) as f: d = json.load(f)
for k in list(d.get("modules", {}).keys()):
    d["modules"][k] = state
if "mindset" in d: d["mindset"] = state
with open(path, "w") as f: json.dump(d, f, indent=2)
print(f"modules: all {'ON' if state else 'OFF'}")
PY
}

start_proxy() {
  # Kill by port — the proxy renames itself to "troth-proxy-<PORT>" via
  # process.title, so a regex pkill on "node.*proxy/server.js" silently
  # misses an already-running instance. If something stale holds :$PORT,
  # we got a false-positive /health from it and all bench traffic went
  # to the stale config. Port-based kill is name-agnostic.
  # `lsof -t` exits 1 when nothing matches — with `set -e` the bare
  # `holders=$(lsof ...)` assignment would kill the script. `|| true`
  # keeps the empty-port happy path alive.
  local holders
  holders=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$holders" ]; then
    echo "$holders" | xargs kill 2>/dev/null || true
    sleep 0.5
    holders=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$holders" ] && echo "$holders" | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi
  GF_PORT="$PORT" node "$ROOT/proxy/server.js" > /tmp/gc-qwen-hard-proxy.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "proxy failed to start"; tail -20 /tmp/gc-qwen-hard-proxy.log; exit 2
}

run_task() {
  local scratch="$1" label="$2" out_file="$3"
  echo
  echo "═══ $label ═══"
  cd "$scratch"
  local t0=$(date +%s)
  ANTHROPIC_BASE_URL="http://localhost:$PORT" \
    claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" > "$out_file" 2>&1 \
    || true
  local wall=$(( $(date +%s) - t0 ))
  local passed=$(verify_scratch "$scratch")
  echo "  wall=${wall}s  tests=$passed"
  echo "$wall" > "${out_file}.wall"
  echo "$passed" > "${out_file}.pass"
}

echo '[seed] setting up OFF scratch'
setup_scratch "$SCRATCH_OFF"
echo '[seed] setting up ON scratch'
setup_scratch "$SCRATCH_ON"

# --- A: modules OFF ---
toggle_modules false
start_proxy
run_task "$SCRATCH_OFF" "A_OFF" /tmp/gc-qwen-hard-A.json

# --- B: modules ON ---
toggle_modules true
start_proxy
run_task "$SCRATCH_ON" "B_ON" /tmp/gc-qwen-hard-B.json

# --- Emit results ------------------------------------------------------
mkdir -p "$ROOT/benchmarks/results"
python3 - <<'PY' > "$ROOT/benchmarks/results/12-qwen-ab-hard.json"
import json, os, re

def parse(path):
    with open(path) as f: text = f.read()
    m = re.search(r'\{"type":"result".*\}\s*$', text, re.S)
    if not m: return {"raw": text[:500]}
    try: return json.loads(m.group(0))
    except Exception: return {"raw": text[:500]}

wall_a = int(open("/tmp/gc-qwen-hard-A.json.wall").read().strip())
wall_b = int(open("/tmp/gc-qwen-hard-B.json.wall").read().strip())
pass_a = open("/tmp/gc-qwen-hard-A.json.pass").read().strip()
pass_b = open("/tmp/gc-qwen-hard-B.json.pass").read().strip()
out = {
  "run_a_modules_off": {
    "provider": "alibaba/qwen3-max via troth proxy (ALL MODULES OFF)",
    "wall_seconds": wall_a, "tests_passed": pass_a,
    "raw": parse("/tmp/gc-qwen-hard-A.json")
  },
  "run_b_modules_on": {
    "provider": "alibaba/qwen3-max via troth proxy (ALL MODULES ON)",
    "wall_seconds": wall_b, "tests_passed": pass_b,
    "raw": parse("/tmp/gc-qwen-hard-B.json")
  }
}
print(json.dumps(out, indent=2))
PY

echo
echo "═══ Summary ═══"
python3 - <<'PY'
import json
d = json.load(open("benchmarks/results/12-qwen-ab-hard.json"))
for k, run in d.items():
    raw = run.get("raw", {})
    u = raw.get("usage", {}) or {}
    print(f"--- {k} ---")
    print(f"  wall        : {run.get('wall_seconds')}s")
    print(f"  tests pass  : {run.get('tests_passed')}")
    print(f"  duration_ms : {raw.get('duration_ms')}")
    print(f"  num_turns   : {raw.get('num_turns')}")
    print(f"  cost_usd    : {raw.get('total_cost_usd')}")
    print(f"  input toks  : {u.get('input_tokens')}")
    print(f"  output toks : {u.get('output_tokens')}")
    print(f"  cache create: {u.get('cache_creation_input_tokens')}")
    print(f"  cache read  : {u.get('cache_read_input_tokens')}")
PY
echo
echo "saved → benchmarks/results/12-qwen-ab-hard.json"
