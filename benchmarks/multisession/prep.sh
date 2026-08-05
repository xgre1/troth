#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Usage: bash prep.sh <1|2>
# Session 1: seeds /tmp/troth-bench-multi with peakValue null-crash.
# Session 2: activates avgValue null-crash in the SAME cwd so the
#            injector's getVerifiedActions(cwd) surfaces session 1's
#            verified edit as precedent.
set -euo pipefail
N="${1:-}"
if [ "$N" != "1" ] && [ "$N" != "2" ]; then
  echo "usage: bash prep.sh <1|2>" >&2
  exit 2
fi
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO="$(cd "$SELF_DIR/../.." && pwd)"
TARGET="/tmp/troth-bench-multi"

if [ "$N" = "1" ]; then
  rm -rf "$TARGET"
  cp -R "$SELF_DIR/sample" "$TARGET"
  mv "$TARGET/test/avg.test.js.disabled" "$TARGET/test/avg.test.js.off" 2>/dev/null || true
  node "$REPO/benchmarks/plugin-bench.mjs" start --label=multi-s1 >/dev/null
  echo "session 1 ready in $TARGET"
else
  # Restore peakValue fix from session 1 stays; now enable avg test that
  # exposes the sibling bug. The src file is left as the agent left it
  # after session 1, so the NEW failure is purely avgValue.
  if [ ! -d "$TARGET" ]; then
    echo "error: session 1 scratch missing — run prep.sh 1 first" >&2
    exit 1
  fi
  # Re-break avgValue so session 2 has something real to fix. Session 1's
  # peakValue fix stays in place — the substrate should surface it as
  # precedent so session 2 can apply the same pattern to avgValue.
  cat > "$TARGET/src/metrics.js" <<'JS'
// metrics helpers. samples look like: { t: <ms>, value: <number|null> }
// the probe returns null when it fails, so null values really do reach
// these functions in production.

function peakValue(samples) {
  const values = samples.map(s => s.value).filter(v => v !== null);
  return Math.max(...values);
}

function avgValue(samples) {
  const sum = samples.reduce((a, s) => a + s.value, 0);
  return sum / samples.length;
}

module.exports = { peakValue, avgValue };
JS
  mv "$TARGET/test/avg.test.js.off" "$TARGET/test/avg.test.js"
  node "$REPO/benchmarks/plugin-bench.mjs" start --label=multi-s2 >/dev/null
  echo "session 2 ready in $TARGET"
fi

cat <<EOF

────────────────────────────────────────────────
 Step: open Claude Code in the scratch dir
────────────────────────────────────────────────
   cd $TARGET && claude

 Paste this prompt verbatim:
────────────────────────────────────────────────
npm test fails. Fix the production code so it passes.
Don't modify any file under test/.
────────────────────────────────────────────────
 When done, type /exit and come back here.
EOF
