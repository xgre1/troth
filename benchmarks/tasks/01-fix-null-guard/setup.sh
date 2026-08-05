#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
TARGET="/tmp/troth-bench-01-fix-null-guard"
rm -rf "$TARGET"
cp -R "$SELF_DIR/sample" "$TARGET"
echo "scratch dir ready: $TARGET"
echo "next: cd $TARGET && claude   (paste prompt.md verbatim)"
