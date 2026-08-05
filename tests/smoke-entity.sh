#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Smoke test for bin/troth-entity.js — pipes a few JSON events at the
# daemon and checks it emits the expected response shapes. No LLM
# provider needed: TROTH_ENTITY_LLM=echo wires a fake transport that
# echoes user prompts back as streaming deltas.
#
# Usage:
#   bash tests/smoke-entity.sh
#
# Exits non-zero if expected lines are missing.

set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Hermetic HOME. The daemon reads the operator's real ~/.troth otherwise,
# and a stored per-pane /model override then steers this test's turn to
# whatever engine the operator last pinned (observed: a pinned
# local model, offline, turned this smoke red with no code change). It
# also stops each smoke run writing its two turns into the operator's
# real substrate.
SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/troth-smoke-entity.XXXXXX")"
trap 'rm -rf "$SMOKE_HOME"' EXIT

# The operator's shell exports TROTH_* flags globally (an agent id, capture
# toggles, some day an engine pin). HOME isolation does not stop any of
# them, and an exported dispatch pin would steer this turn exactly the way
# the stored /model override did, one layer up. Scrub every ambient
# TROTH_* var; the one value the test means to run with is set explicitly
# after the scrub.
TROTH_UNSET=()
while IFS= read -r _v; do TROTH_UNSET+=("-u" "$_v"); done \
  < <(env | LC_ALL=C sed -n 's/^\(TROTH_[A-Za-z0-9_]*\)=.*/\1/p')
OUT=$(env ${TROTH_UNSET[@]+"${TROTH_UNSET[@]}"} HOME="$SMOKE_HOME" TROTH_ENTITY_LLM=echo node "$ROOT/bin/troth-entity.js" <<'INPUT'
{"type":"user_input","input":{"text":"ok"}}
{"type":"user_input","input":{"text":"Tell me about substrate-as-entity in two sentences please."}}
INPUT
)

echo "$OUT"

echo "$OUT" | grep -q '"kind":"ready"' || { echo "FAIL: no ready emit"; exit 1; }
echo "$OUT" | grep -q '"text":"Acknowledged."' || { echo "FAIL: ack not produced for short input"; exit 1; }
echo "$OUT" | grep -q '"kind":"response"' || { echo "FAIL: no response emit for long input"; exit 1; }
# The echo transport must echo the PROMPT back — an empty-text response
# passed the line above for weeks while agentic mode streamed nothing.
# NOT anchored to the start of "text": since  the composer rides
# the situational grounding block on the user message, so the echoed
# prompt legitimately arrives after <turn_context>. The anchored form was
# written  and has failed on every machine since that change.
echo "$OUT" | grep -q 'Tell me about substrate-as-entity' || { echo "FAIL: response text empty or wrong (echo transport broken?)"; exit 1; }
echo "$OUT" | grep -q '"faculty":"echo"' || { echo "FAIL: response not served by the echo transport"; exit 1; }
echo "$OUT" | grep -q '"kind":"stopped"' || { echo "FAIL: did not announce shutdown"; exit 1; }

echo "OK"
