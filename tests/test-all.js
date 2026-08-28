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
require('./suite-36-forget-target.js')({ test, skip });
require('./suite-37-router-resilience.js')({ test, skip });
require('./suite-38-corpus-inventory.js')({ test, skip });
require('./suite-39-operator-rules.js')({ test, skip });
require('./suite-40-ingest-secret-gate.js')({ test, skip });
require('./suite-41-outcome-fold.js')({ test, skip });
require('./suite-42-knowledge-reservoir.js')({ test, skip });
require('./suite-43-code-graph.js')({ test, skip });
require('./suite-44-dead-vectors.js')({ test, skip });
require('./suite-45-web-provenance.js')({ test, skip });
require('./suite-46-external-not-truth.js')({ test, skip });
require('./suite-47-pause-and-queue.js')({ test, skip });
require('./suite-48-project-identity.js')({ test, skip });
require('./suite-49-inference-flags.js')({ test, skip });
require('./suite-50-browser-reap.js')({ test, skip });
require('./suite-51-recall-whole.js')({ test, skip });
require('./suite-52-system-load.js')({ test, skip });
require('./suite-53-lesson-hygiene.js')({ test, skip });
require('./suite-54-knowledge-import.js')({ test, skip });
require('./suite-55-read-ledger.js')({ test, skip });
require('./suite-56-protocol-contract.js')({ test, skip });
require('./suite-57-memory-surface.js')({ test, skip });
require('./suite-58-agents-contract.js')({ test, skip });
require('./suite-59-how-rails.js')({ test, skip });
require('./suite-60-recallforce.js')({ test, skip });
require('./suite-61-hook-budget.js')({ test, skip });
require('./suite-62-decision-record.js')({ test, skip });
require('./suite-63-memory-dispatch.js')({ test, skip });
require('./suite-64-irreversibility-floor.js')({ test, skip });
require('./suite-65-dialogue-dedup.js')({ test, skip });
require('./suite-66-constraint-ledger.js')({ test, skip });
require('./suite-67-verifiable-claims.js')({ test, skip });
require('./suite-68-substrate-sync.js')({ test, skip });
require('./suite-69-context-window.js')({ test, skip });
require('./suite-70-field-contract.js')({ test, skip });
require('./suite-71-run-id-containment.js')({ test, skip });
require('./suite-72-ground-policy.js')({ test, skip });
require('./suite-73-ground-walls.js')({ test, skip });

// --- SUMMARY ---
flushAsyncTests().then(() => {
  const { passed, failed } = counts();
  const skipped = (counts().skipped || 0);
  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed'
    + (skipped ? ', ' + skipped + ' skipped (coverage of the closed overlay, which is not in this tree)' : '') + ' ===\n');
  process.exit(failed > 0 ? 1 : 0);
});
