// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: record-intent).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "record-intent") {
  var actionRecRI = require("../shared-core/action-record.js");
  var stateRI     = require("../shared-core/state.js");
  var ri = { goal: null, consider: null, chose: null, cwd: null, rationales: {} };
  for (var rii = 0; rii < passthrough.length; rii++) {
    var rk = passthrough[rii], rv = passthrough[rii + 1];
    if      (rk === '--goal'     && rv) { ri.goal = rv; rii++; }
    else if (rk === '--consider' && rv) { ri.consider = rv.split(',').map(s => s.trim()).filter(Boolean); rii++; }
    else if (rk === '--chose'    && rv) { ri.chose = rv; rii++; }
    else if (rk === '--cwd'      && rv) { ri.cwd = rv; rii++; }
    else if (rk.indexOf('--rationale-') === 0 && rv) {
      var who = rk.slice('--rationale-'.length);
      ri.rationales[who] = rv; rii++;
    }
  }
  if (!ri.goal || !Array.isArray(ri.consider) || ri.consider.length < 2 || !ri.chose) {
    console.error("Usage: troth record-intent --goal \"<text>\" --consider A,B,C --chose A [--cwd P] [--rationale-A \"...\"]");
    console.error("Example:");
    console.error('  troth record-intent --goal "add JWT auth" --consider auth0,nextauth,clerk --chose auth0 \\');
    console.error('    --rationale-auth0 "fastest setup" --rationale-nextauth "open-source" --rationale-clerk "best DX"');
    process.exit(1);
  }
  if (ri.consider.indexOf(ri.chose) === -1) {
    console.error("--chose '" + ri.chose + "' must be one of --consider values: " + ri.consider.join(', '));
    process.exit(1);
  }
  var altsList = ri.consider
    .filter(function(p) { return p !== ri.chose; })
    .map(function(p) { return { path: p, rationale: ri.rationales[p] || null }; });
  var ridRec = {
    id: require('crypto').randomUUID(),
    timestamp: Date.now(),
    type: 'intent',
    agent_id: 'cli',
    cwd: ri.cwd || process.cwd(),
    input: { goal: ri.goal, source_message_hash: 'cli:record-intent' },
    output: {
      chosen_path: ri.chose,
      alternatives_considered: altsList,
      agent_proposal: 'manual'
    },
    verification: {},
    outcome: { accepted: true }
  };
  var rv2 = actionRecRI.validate(ridRec);
  if (!rv2.ok) {
    console.error("Refused: " + JSON.stringify(rv2.errors, null, 2));
    process.exit(2);
  }
  var ridId = stateRI.recordAction(ridRec, actionRecRI.toSearchText(ridRec));
  if (!ridId) { console.error("Substrate write failed."); process.exit(2); }
  console.log("\x1b[32m✓\x1b[0m intent recorded with " + altsList.length + " alternative(s)");
  console.log("  intent_id:    " + ridId);
  console.log("  goal:         " + ri.goal);
  console.log("  chosen:       " + ri.chose);
  console.log("  alternatives: " + altsList.map(function(a) { return a.path; }).join(', '));
  console.log("");
  console.log("Next: troth replay --intent " + ridId.slice(0, 8) + "  (list alternatives)");
  console.log("      troth replay --intent " + ridId.slice(0, 8) + " --use 0 --estimate");
  process.exit(0);
}
};
