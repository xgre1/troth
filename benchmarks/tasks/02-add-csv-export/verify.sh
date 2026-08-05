#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
DIR="${1:-/tmp/troth-bench-02-add-csv-export}"
if [ ! -d "$DIR" ]; then echo "scratch dir missing"; exit 2; fi
cd "$DIR"
if ! npm test >/tmp/bench-02-output.log 2>&1; then
  echo "✗ csv tests failed"
  tail -30 /tmp/bench-02-output.log
  exit 1
fi
SHA="$(openssl sha1 "$DIR/test/csv.test.js" | awk '{print $2}')"
ORIG="$(dirname "${BASH_SOURCE[0]}")/sample/test/csv.test.js"
if [ "$SHA" != "$(openssl sha1 "$ORIG" | awk '{print $2}')" ]; then
  echo "✗ agent modified test file"; exit 1
fi
echo "✓ task 02 passed"
