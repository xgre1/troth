#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# 4-arm A/B/C/D matrix harness — generalizes qwen-ab-hard.sh.
#
# Arms:
#   A = vanilla Claude Code CLI (direct anthropic, no proxy)
#   B = Claude Code + troth proxy (modules ON, anthropic upstream)
#   C = OSS LLM + troth proxy (modules ON, OpenRouter or local upstream)
#   D = OSS LLM vanilla (modules OFF, OpenRouter or local upstream)
#
# Each arm runs the same task against a fresh scratch dir, verified by the
# task's verify.sh (or npm test). The aggregator (aggregate.mjs) joins
# results into a per-task matrix-<task>-<date>.{json,md}.
#
# Loopguard: TROTH_BENCH_MODE=1 raises thresholds so multi-Read tasks
# don't false-trip. Without this, qwen-ab-hard run 12 self-killed at 5/9.
#
# Usage:
#   bash benchmarks/tiers/arms.sh --task=seeds/01-bugfix --arm=A
#   bash benchmarks/tiers/arms.sh --task=seeds/01-bugfix --all-arms
#
# Mac Studio NOT required for arms A+B (Anthropic-only). Required (or
# OPENROUTER_API_KEY) for arms C+D.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${GF_PORT:-8095}"
CONFIG="$HOME/.troth/config.json"
BACKUP="$HOME/.troth/config.json.arms.bak"
RESULT_DIR="$ROOT/benchmarks/results"

TASK=""
ARM=""
ALL_ARMS=false
PROMPT='Four tests in test.js fail against server.js. Each failure corresponds to a real bug in server.js marked with a `// BUG N:` comment. Read server.js and test.js, fix all four bugs in server.js, and run `npm test` to verify 9/9 tests pass. Do not modify test.js.'

for arg in "$@"; do
  case "$arg" in
    --task=*)    TASK="${arg#*=}" ;;
    --arm=*)     ARM="${arg#*=}" ;;
    --all-arms)  ALL_ARMS=true ;;
    --prompt=*)  PROMPT="${arg#*=}" ;;
  esac
done

if [[ -z "$TASK" ]]; then
  echo "ERROR: --task=<seeds/01-bugfix|tasks/02-add-csv-export|...> required"
  exit 2
fi
SEED="$ROOT/benchmarks/$TASK"
[[ -d "$SEED" ]] || { echo "ERROR: $SEED not a directory"; exit 2; }

[[ -f "$CONFIG" ]] && cp "$CONFIG" "$BACKUP"
trap '[[ -f "$BACKUP" ]] && cp "$BACKUP" "$CONFIG" && rm -f "$BACKUP"; lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true' EXIT

setup_scratch() {
  local dst="$1"
  rm -rf "$dst"; mkdir -p "$dst"
  cp -r "$SEED"/* "$dst/" 2>/dev/null || true
  if [[ ! -f "$dst/package.json" ]]; then
    cat > "$dst/package.json" <<'PKG'
{"name":"gc-arms-bench","private":true,"version":"0.0.0",
 "scripts":{"test":"node test.js"},
 "dependencies":{"express":"^4.21.0","better-sqlite3":"^12.0.0"}}
PKG
  fi
  (cd "$dst" && npm install --silent --no-audit --no-fund > /dev/null 2>&1 || true)
}

verify_scratch() {
  local dst="$1"
  if [[ -x "$dst/verify.sh" ]]; then
    (cd "$dst" && bash verify.sh > /tmp/gc-arms-verify.log 2>&1) && echo "yes" || echo "no"
  else
    (cd "$dst" && npm test --silent > /tmp/gc-arms-verify.log 2>&1) && echo "yes" || echo "no"
  fi
}

toggle_modules() {
  local state="$1"
  python3 - "$CONFIG" "$state" <<'PY' 2>/dev/null || true
import json, sys
path, state = sys.argv[1], sys.argv[2] == "true"
try:
  with open(path) as f: d = json.load(f)
except FileNotFoundError:
  d = {"modules": {}}
for k in list(d.get("modules", {}).keys()):
    d["modules"][k] = state
if "mindset" in d: d["mindset"] = state
with open(path, "w") as f: json.dump(d, f, indent=2)
PY
}

set_upstream() {
  local kind="$1"  # anthropic | openrouter
  python3 - "$CONFIG" "$kind" <<'PY' 2>/dev/null || true
import json, sys, os
path, kind = sys.argv[1], sys.argv[2]
try:
  with open(path) as f: d = json.load(f)
except FileNotFoundError:
  d = {"modules": {}}
if kind == "anthropic":
  d["upstream"] = {"kind": "anthropic", "api_key_env": "ANTHROPIC_API_KEY"}
elif kind == "openrouter":
  d["upstream"] = {"kind": "openrouter", "model": "qwen/qwen3-max",
                   "api_key_env": "OPENROUTER_API_KEY"}
with open(path, "w") as f: json.dump(d, f, indent=2)
PY
}

start_proxy() {
  local holders
  holders=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  [[ -n "$holders" ]] && echo "$holders" | xargs kill 2>/dev/null || true
  sleep 0.5
  GF_PORT="$PORT" TROTH_BENCH_MODE=1 \
    node "$ROOT/proxy/server.js" > /tmp/gc-arms-proxy.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "proxy failed to start"; tail -20 /tmp/gc-arms-proxy.log; exit 2
}

run_arm() {
  local arm="$1"
  local scratch="/tmp/gc-arms-${arm}-$$"
  local out_file="/tmp/gc-arms-${arm}.json"
  echo
  echo "═══ ARM $arm ═══"
  setup_scratch "$scratch"

  case "$arm" in
    A)  # vanilla Claude Code, direct
        unset ANTHROPIC_BASE_URL
        cd "$scratch"
        local t0=$(date +%s)
        claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" \
          > "$out_file" 2>&1 || true
        local wall=$(( $(date +%s) - t0 ))
        ;;
    B)  # Claude Code + troth proxy, anthropic upstream
        toggle_modules true
        set_upstream anthropic
        start_proxy
        cd "$scratch"
        local t0=$(date +%s)
        ANTHROPIC_BASE_URL="http://localhost:$PORT" \
          claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" \
          > "$out_file" 2>&1 || true
        local wall=$(( $(date +%s) - t0 ))
        ;;
    C)  # OSS LLM + troth, OpenRouter upstream
        toggle_modules true
        set_upstream openrouter
        start_proxy
        cd "$scratch"
        local t0=$(date +%s)
        ANTHROPIC_BASE_URL="http://localhost:$PORT" \
          claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" \
          > "$out_file" 2>&1 || true
        local wall=$(( $(date +%s) - t0 ))
        ;;
    D)  # OSS LLM vanilla (no troth)
        toggle_modules false
        set_upstream openrouter
        start_proxy
        cd "$scratch"
        local t0=$(date +%s)
        ANTHROPIC_BASE_URL="http://localhost:$PORT" \
          claude -p --dangerously-skip-permissions --output-format=json "$PROMPT" \
          > "$out_file" 2>&1 || true
        local wall=$(( $(date +%s) - t0 ))
        ;;
    *)  echo "Unknown arm: $arm"; exit 2 ;;
  esac

  local pass=$(verify_scratch "$scratch")
  echo "  arm=$arm wall=${wall}s pass=$pass"
  echo "$wall" > "${out_file}.wall"
  echo "$pass" > "${out_file}.pass"
  rm -rf "$scratch"
}

if [[ "$ALL_ARMS" == "true" ]]; then
  for arm in A B C D; do run_arm "$arm"; done
elif [[ -n "$ARM" ]]; then
  run_arm "$ARM"
else
  echo "ERROR: --arm=<A|B|C|D> or --all-arms required"
  exit 2
fi

echo
echo "Per-arm raw results: /tmp/gc-arms-{A,B,C,D}.json"
echo "Aggregate with: node benchmarks/tiers/aggregate.mjs --task=$TASK"
