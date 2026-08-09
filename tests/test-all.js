// SPDX-License-Identifier: AGPL-3.0-only
require('./hermetic-db.js'); // pin a throwaway STATE_DB_PATH before any state.js load
// Ordered runner over tests/suites/*. Bodies are verbatim splits of the old
// single-file suite; chunk order preserves the original declaration order.
const { test, skip, flushAsyncTests, counts } = require('./harness.js');

console.log('\n=== troth Test Suite ===\n');

require('./suite-01-parser.js')({ test, skip });
require('./suite-02-ratelimit-behavior.js')({ test, skip });
require('./suite-03-end-to-end-regression.js')({ test, skip });
require('./suite-04-zero-llm-intent-extraction.js')({ test, skip });
require('./suite-05-identity-extract.js')({ test, skip });
require('./suite-06-voice-triage.js')({ test, skip });
require('./suite-07-intent-routed-mounting-policy.js')({ test, skip });
require('./suite-08-config-file-single-writer.js')({ test, skip });
require('./suite-09-focused-attention.js')({ test, skip });
require('./suite-11-production-e2e.js')({ test, skip });
require('./suite-12-mcp-hosts-shared.js')({ test, skip });
require('./suite-13-mcp-routes-open.js')({ test, skip });
require('./suite-14-image-gen.js')({ test, skip });
require('./suite-15-forget-suppression.js')({ test, skip });
require('./suite-16-faculty-fallthrough.js')({ test, skip });
require('./suite-17-mcp-governed-actions.js')({ test, skip });
require('./suite-18-mcp-hands.js')({ test, skip });
require('./suite-19-router-pin-failfast.js')({ test, skip });
require('./suite-20-kimi-native.js')({ test, skip });
require('./suite-21-claude-backbone-browser-rule.js')({ test, skip });
require('./suite-22-secret-redactor.js')({ test, skip });
require('./suite-23-kimi-cli-lane.js')({ test, skip });
require('./suite-24-loopback-origin-guard.js')({ test, skip });
require('./suite-25-sandbox-seatbelt.js')({ test, skip });
require('./suite-26-mcp-child-boundary.js')({ test, skip });
require('./suite-27-workspace-jail.js')({ test, skip });
require('./suite-28-tool-path-walls.js')({ test, skip });
require('./suite-29-dmg-pass-walls.js')({ test, skip });
require('./suite-30-derive-coherence.js')({ test, skip });
require('./suite-31-memory-readiness.js')({ test, skip });
require('./suite-32-plan-usage.js')({ test, skip });
require('./suite-33-archive-provenance.js')({ test, skip });
require('./suite-34-maintenance.js')({ test, skip });
require('./suite-35-import-atomicity.js')({ test, skip });

// --- SUMMARY ---
flushAsyncTests().then(() => {
  const { passed, failed } = counts();
  const skipped = (counts().skipped || 0);
  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed'
    + (skipped ? ', ' + skipped + ' skipped (coverage of the closed overlay, which is not in this tree)' : '') + ' ===\n');
  process.exit(failed > 0 ? 1 : 0);
});
