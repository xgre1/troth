#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Tier benchmark — Commodity + troth vs Frontier + Stock.
#
# This is the headline claim from the substrate design notes:
#   "Commodity models + troth ≥ frontier models + stock tools"
#
# Two runs on the same task:
#   A) Qwen3-Max (Alibaba) routed through the troth proxy at :8000
#      ANTHROPIC_BASE_URL=http://localhost:8000 claude -p "..."
#      Proxy's critic/reflexion/codelens/etc. modules apply.
#   B) Claude Opus 4.7 direct, no proxy — stock Claude Code.
#
# Both solve the null-guard fix. We compare:
#   - Did tests pass?
#   - How many requests/turns?
#   - Cost (Opus per-token vs Alibaba $50/mo flat-rate ≈ $0.03/req)
#   - Wall time
#
# Usage: bash benchmarks/tiers/run.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_DIR="$ROOT/benchmarks/tasks/01-fix-null-guard"
SCRATCH_A="/tmp/gc-tier-commodity"
SCRATCH_B="/tmp/gc-tier-frontier"
PROXY_PORT="${GF_PORT:-8091}"
RESULTS="$ROOT/benchmarks/results/09-tiers-commodity-vs-frontier.json"

PROMPT="$(cat "$TASK_DIR/prompt.md")"

# ── Prep scratches ────────────────────────────────────────────────────────
rm -rf "$SCRATCH_A" "$SCRATCH_B"
cp -R "$TASK_DIR/sample" "$SCRATCH_A"
cp -R "$TASK_DIR/sample" "$SCRATCH_B"

# ── Start proxy ───────────────────────────────────────────────────────────
pkill -f "node proxy/server.js" 2>/dev/null || true
sleep 0.5
GF_PORT="$PROXY_PORT" node "$ROOT/proxy/server.js" > /tmp/gc-tier-proxy.log 2>&1 &
PROXY_PID=$!
cleanup() { kill "$PROXY_PID" 2>/dev/null || true; }
trap cleanup EXIT
# Wait for proxy health.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS "http://127.0.0.1:$PROXY_PORT/health" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sS "http://127.0.0.1:$PROXY_PORT/health" > /dev/null 2>&1; then
  echo "proxy failed to start — see /tmp/gc-tier-proxy.log"; tail -20 /tmp/gc-tier-proxy.log
  exit 2
fi
echo "[proxy] ready on :$PROXY_PORT → routes to $(curl -sS http://127.0.0.1:$PROXY_PORT/api/config | python3 -c 'import json,sys; c=json.load(sys.stdin); ps=c.get("providers",{}); print(",".join([p for p,v in ps.items() if v.get("enabled")]))')"

# ── Run A: commodity model via proxy ─────────────────────────────────────
echo
echo "═══ A) Qwen3-Max + troth proxy ═══"
cd "$SCRATCH_A"
START_A=$(date +%s)
set +e
RESP_A=$(ANTHROPIC_BASE_URL="http://localhost:$PROXY_PORT" \
  claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" 2>&1 | tail -1)
RC_A=$?
set -e
END_A=$(date +%s)
WALL_A=$((END_A - START_A))
PASS_A="no"
if bash "$TASK_DIR/verify.sh" "$SCRATCH_A" > /tmp/gc-tier-verify-a.log 2>&1; then PASS_A="yes"; fi
echo "  wall=${WALL_A}s  tests=$PASS_A"

# ── Run B: frontier model direct ─────────────────────────────────────────
echo
echo "═══ B) Claude Opus 4.7 stock ═══"
cd "$SCRATCH_B"
START_B=$(date +%s)
set +e
RESP_B=$(claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" 2>&1 | tail -1)
RC_B=$?
set -e
END_B=$(date +%s)
WALL_B=$((END_B - START_B))
PASS_B="no"
if bash "$TASK_DIR/verify.sh" "$SCRATCH_B" > /tmp/gc-tier-verify-b.log 2>&1; then PASS_B="yes"; fi
echo "  wall=${WALL_B}s  tests=$PASS_B"

# ── Persist result JSON ──────────────────────────────────────────────────
python3 - <<PY > "$RESULTS"
import json
def extract(resp):
    try: return json.loads(resp)
    except Exception: return {"raw": resp[:500]}
print(json.dumps({
  "run_a_commodity": {
    "provider": "alibaba/qwen3-max via troth proxy",
    "wall_seconds": $WALL_A,
    "tests_passed": "$PASS_A",
    "raw": extract('''$RESP_A''')
  },
  "run_b_frontier": {
    "provider": "claude-opus-4-7 direct",
    "wall_seconds": $WALL_B,
    "tests_passed": "$PASS_B",
    "raw": extract('''$RESP_B''')
  }
}, indent=2))
PY

echo
echo "═══ Result ═══"
echo "  A (commodity)  : wall=${WALL_A}s  tests=$PASS_A"
echo "  B (frontier)   : wall=${WALL_B}s  tests=$PASS_B"
echo "  saved to       : $RESULTS"
