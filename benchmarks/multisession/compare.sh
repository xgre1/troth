#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Reads both session reports + queries the plugin-scoped substrate and
# prints a grid: session 1 vs session 2. The cross-session win shows up
# as (a) a "precedent rows injected" count >0 in s2, and (b) a lower
# cache-creation / cost on s2.
set -euo pipefail
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO="$(cd "$SELF_DIR/../.." && pwd)"
DB="$HOME/.claude/plugins/data/troth-troth-local/state.db"

cd "$REPO"
echo "=== session 1 ==="
node benchmarks/plugin-bench.mjs report --label=multi-s1 | tail -20
echo ""
echo "=== session 2 ==="
node benchmarks/plugin-bench.mjs report --label=multi-s2 | tail -20
echo ""
echo "=== substrate: verified edits for /tmp/troth-bench-multi ==="
sqlite3 "$DB" "SELECT datetime(timestamp/1000,'unixepoch') AS ts, type,
  json_extract(verification,'\$.ast.ok') AS ast,
  json_extract(input,'\$.file_path') AS file
  FROM action_records WHERE cwd='/tmp/troth-bench-multi' AND type='edit'
  ORDER BY timestamp;"
echo ""
echo "=== substrate: injector context_injection decisions ==="
sqlite3 "$DB" "SELECT datetime(timestamp/1000,'unixepoch') AS ts,
  json_extract(input,'\$.lesson_count') AS lessons,
  json_extract(input,'\$.project_type') AS proj
  FROM action_records WHERE cwd='/tmp/troth-bench-multi' AND type='decision'
  ORDER BY timestamp;"
