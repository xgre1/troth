#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Qwen A/B — same model, same provider, same routing; only troth
# scaffolding toggles on/off between runs. This is the honest
# measurement of what the substrate/proxy modules add to a commodity
# model — not conflated with model choice the way 09-tiers was.
#
# Method:
#   1. Back up ~/.troth/config.json
#   2. Run A: all 16 modules OFF (proxy just routes to Qwen3-Max)
#   3. Run B: all 16 modules ON (full scaffolding stack)
#   4. Restore original config
#   5. Write result JSON + summary to benchmarks/results/11-qwen-scaffolding-ab.{json,md}
#
# Usage: bash benchmarks/tiers/qwen-ab.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_DIR="$ROOT/benchmarks/tasks/01-fix-null-guard"
SCRATCH_OFF="/tmp/gc-qwen-off"
SCRATCH_ON="/tmp/gc-qwen-on"
PORT="${GF_PORT:-8093}"
CONFIG="$HOME/.troth/config.json"
BACKUP="$HOME/.troth/config.json.bench.bak"

PROMPT="$(cat "$TASK_DIR/prompt.md")"

# --- Prep scratches ------------------------------------------------------
rm -rf "$SCRATCH_OFF" "$SCRATCH_ON"
cp -R "$TASK_DIR/sample" "$SCRATCH_OFF"
cp -R "$TASK_DIR/sample" "$SCRATCH_ON"

# --- Back up config ------------------------------------------------------
cp "$CONFIG" "$BACKUP"
trap 'cp "$BACKUP" "$CONFIG"; rm -f "$BACKUP"; pkill -f "node.*proxy/server.js" 2>/dev/null || true' EXIT

toggle_modules() {
  local state="$1"  # "false" or "true"
  python3 - "$CONFIG" "$state" <<'PY'
import json, sys
path, state = sys.argv[1], sys.argv[2] == "true"
with open(path) as f: d = json.load(f)
for k in list(d.get("modules", {}).keys()):
    d["modules"][k] = state
# Also flip mindset (the always-injected system prompt) and hotcache which
# lives at the top level in some variants. Keep provider config intact.
if "mindset" in d: d["mindset"] = state
with open(path, "w") as f: json.dump(d, f, indent=2)
print(f"modules: all {'ON' if state else 'OFF'}")
PY
}

start_proxy() {
  pkill -f "node.*proxy/server.js" 2>/dev/null || true
  sleep 0.5
  GF_PORT="$PORT" node "$ROOT/proxy/server.js" > /tmp/gc-qwen-ab-proxy.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "proxy failed to start"; tail -20 /tmp/gc-qwen-ab-proxy.log; exit 2
}

run_task() {
  local scratch="$1" label="$2"
  echo
  echo "═══ $label ═══"
  cd "$scratch"
  local t0
  t0=$(date +%s)
  set +e
  local resp
  resp=$(ANTHROPIC_BASE_URL="http://localhost:$PORT" \
    claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" 2>&1 | tail -1)
  local rc=$?
  set -e
  local wall=$(( $(date +%s) - t0 ))
  local passed="no"
  if bash "$TASK_DIR/verify.sh" "$scratch" > /tmp/gc-qwen-ab-verify-$label.log 2>&1; then passed="yes"; fi
  echo "  wall=${wall}s  tests=$passed  rc=$rc"
  printf '%s' "$resp"
}

# --- Run A: OFF ---------------------------------------------------------
toggle_modules false
start_proxy
RESP_A=$(run_task "$SCRATCH_OFF" "A_OFF")
START_A=$(date +%s)

# --- Run B: ON ----------------------------------------------------------
toggle_modules true
start_proxy
RESP_B=$(run_task "$SCRATCH_ON" "B_ON")
START_B=$(date +%s)

# --- Emit results JSON --------------------------------------------------
mkdir -p "$ROOT/benchmarks/results"
python3 - <<PY > "$ROOT/benchmarks/results/11-qwen-scaffolding-ab.json"
import json
def ex(s):
    s = s.strip()
    if not s: return {}
    try: return json.loads(s)
    except Exception: return {"raw": s[:600]}
a = ex("""$RESP_A""")
b = ex("""$RESP_B""")
out = {
  "run_a_modules_off": {"provider": "alibaba/qwen3-max via troth proxy (ALL MODULES OFF)", "raw": a},
  "run_b_modules_on":  {"provider": "alibaba/qwen3-max via troth proxy (ALL MODULES ON)",  "raw": b},
}
print(json.dumps(out, indent=2))
PY

echo
echo "═══ Summary ═══"
python3 - <<'PY'
import json
d = json.load(open("benchmarks/results/11-qwen-scaffolding-ab.json"))
for k, run in d.items():
    raw = run.get("raw", {})
    print(f"--- {k} ---")
    for field in ["duration_ms","num_turns","total_cost_usd"]:
        if field in raw: print(f"  {field}: {raw[field]}")
    u = raw.get("usage",{})
    for field in ["input_tokens","output_tokens","cache_creation_input_tokens","cache_read_input_tokens"]:
        if field in u: print(f"  {field}: {u[field]}")
PY
echo
echo "saved → benchmarks/results/11-qwen-scaffolding-ab.json"
