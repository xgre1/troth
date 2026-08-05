#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Cross-tool state sharing benchmark.
#
# Proves the scope claim: "any MCP-compatible agent can share state
# through the substrate." A Python GMP client writes a verified
# edit ActionRecord. A Claude Code session in the SAME cwd then runs
# and its injector surfaces the Python-written record as precedent.
#
# If this works, two different runtimes share semantic state with no
# shared code — only the GMP protocol.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCH="/tmp/gc-crosstool-bench"
DATA_DIR="$HOME/.claude/plugins/data/troth-troth-local"
DB="$DATA_DIR/state.db"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/src" "$SCRATCH/test"
cat > "$SCRATCH/package.json" <<'JSON'
{ "name": "gc-crosstool", "private": true, "scripts": { "test": "node --test test/*.test.js" } }
JSON
cat > "$SCRATCH/src/util.js" <<'JS'
function parseConfig(s) {
  // Bug: assumes non-null input.
  return JSON.parse(s.trim());
}
module.exports = { parseConfig };
JS
cat > "$SCRATCH/test/parse.test.js" <<'JS'
const {test}=require('node:test');const a=require('node:assert');const {parseConfig}=require('../src/util');
test('parseConfig handles null input', () => { a.deepStrictEqual(parseConfig(null), {}); });
JS

# Purge prior rows for this cwd so the test is clean.
MAIN_CWD="/private${SCRATCH}"
sqlite3 "$DB" "DELETE FROM action_records WHERE cwd='$MAIN_CWD'"

echo "[step 1] Python AMP client writes a verified edit ActionRecord for $MAIN_CWD"
CLAUDE_PLUGIN_DATA="$DATA_DIR" python3 "$ROOT/clients/python-amp/amp_client.py" \
  demo --cwd "$MAIN_CWD" --data "$DATA_DIR" > /tmp/gc-crosstool-py.log 2>&1
tail -5 /tmp/gc-crosstool-py.log
PY_EDIT_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM action_records WHERE cwd='$MAIN_CWD' AND type='edit' AND agent_id='python-amp-demo'")
echo "[step 1] rows written by python-amp-demo for $MAIN_CWD: $PY_EDIT_COUNT"

echo
echo "[step 2] Claude Code plugin runs in $SCRATCH"
cd "$SCRATCH"
RESP=$(claude -p --dangerously-skip-permissions --output-format=json \
  "npm test fails. Fix src/util.js so tests pass. Don't modify anything under test/." 2>&1 | tail -1)
CC_SESSION=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
echo "[step 2] claude session: $CC_SESSION"

echo
echo "[step 3] did Claude Code's injector surface python's edit as precedent?"
PREC_COUNT=$(sqlite3 "$DB" "SELECT CAST(json_extract(input,'\$.precedent_count') AS INTEGER) FROM action_records WHERE session_id='$CC_SESSION' AND json_extract(input,'\$.kind')='context_injection' ORDER BY timestamp ASC LIMIT 1")
echo "[step 3] precedent_count in Claude Code's injector decision: $PREC_COUNT"

echo
echo "═══ Result ═══"
if [ "$PY_EDIT_COUNT" -ge 1 ] && [ "${PREC_COUNT:-0}" -ge 1 ]; then
  echo "  ✓ Python wrote to substrate"
  echo "  ✓ Claude Code read Python's write as precedent"
  echo "  ✓ Cross-tool state sharing: PROVEN"
  exit 0
else
  echo "  python_edits=$PY_EDIT_COUNT  precedent_count=$PREC_COUNT — FAILED"
  exit 1
fi
