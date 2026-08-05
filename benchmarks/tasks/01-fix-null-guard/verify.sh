#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Verifier for task 01. Pass the scratch dir as $1 (defaults to the
# one setup.sh creates). Exit 0 = passed, non-zero = failed run.
set -euo pipefail
DIR="${1:-/tmp/troth-bench-01-fix-null-guard}"
if [ ! -d "$DIR" ]; then
  echo "scratch dir $DIR not found — did setup.sh run?"
  exit 2
fi
cd "$DIR"

# Tests must pass.
if ! npm test >/tmp/bench-01-output.log 2>&1; then
  echo "✗ tests still fail"
  tail -20 /tmp/bench-01-output.log
  exit 1
fi

# Agent must not have altered the test file (preserves benchmark integrity).
EXPECTED_SHA="$(openssl sha1 "$DIR/test/metrics.test.js" | awk '{print $2}')"
ORIG="$(dirname "${BASH_SOURCE[0]}")/sample/test/metrics.test.js"
ORIG_SHA="$(openssl sha1 "$ORIG" | awk '{print $2}')"
if [ "$EXPECTED_SHA" != "$ORIG_SHA" ]; then
  echo "✗ the agent modified test/metrics.test.js — run is invalid"
  exit 1
fi

echo "✓ task 01 passed"
exit 0
