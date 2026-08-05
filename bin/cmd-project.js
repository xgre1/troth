// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: project).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync, _flagL4 } = ctx;
if (command === "project") {
  var subP = args[1];
  if (subP !== "add") {
    console.error("Usage: troth project add <short_name> --purpose \"<text>\" [--scope-pattern <glob>] [--budget-usd <n>] [--budget-window-ms <n>] [--expected-completion-ms <n>]");
    process.exit(2);
  }
  var shortP = args[2];
  var purposeP = _flagL4("--purpose");
  if (!shortP || !purposeP) {
    console.error("Usage: troth project add <short_name> --purpose \"<text>\" [...]");
    process.exit(2);
  }
  var scopePat = _flagL4("--scope-pattern");
  var budUsd = _flagL4("--budget-usd");
  var budWin = _flagL4("--budget-window-ms");
  var expectedC = _flagL4("--expected-completion-ms");
  var opKeyP = require("../shared-core/operator-key.js");
  var apMod = require("../shared-core/active-project.js");
  if (!opKeyP.exists()) { console.error("Refused: no operator key. Run `troth init` first."); process.exit(2); }
  var passP = _readPassphraseSync("Operator passphrase");
  var signerP;
  try { signerP = opKeyP.unlock(passP); } catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
  try {
    var extraP = {
      purpose: purposeP,
      scope_pattern: scopePat || null,
      budget_usd: budUsd ? Number(budUsd) : null,
      budget_window_ms: budWin ? Number(budWin) : null,
      expected_completion: expectedC ? Number(expectedC) : null,
      status: 'active',
      milestones: []
    };
    var canonP = opKeyP.canonicalEngramBody({
      statement: "active_project " + shortP,
      scope: "active_project:" + shortP,
      source_authority: "operator_confirmed",
      extra_output: extraP
    });
    var resP = apMod.writeActiveProject({
      short_name: shortP,
      purpose: purposeP,
      scope_pattern: scopePat || null,
      budget_usd: budUsd ? Number(budUsd) : null,
      budget_window_ms: budWin ? Number(budWin) : null,
      expected_completion: expectedC ? Number(expectedC) : null,
      signature: signerP.sign(canonP)
    });
    if (!resP.ok) { console.error("Refused: " + resP.error + (resP.detail ? ' — ' + resP.detail : '')); process.exit(2); }
    console.log("Active project added: " + resP.id);
    console.log("  scope:    " + resP.scope);
    console.log("  purpose:  " + purposeP);
    if (scopePat) console.log("  scope_pattern: " + scopePat);
    if (budUsd)   console.log("  budget_usd:    " + budUsd);
    try { require("../shared-core/presence.js").recordPresenceProof(signerP, { note: 'auto via troth project add' }); } catch (_) {}
  } finally { try { signerP.lock(); } catch (_) {} }
  process.exit(0);
}
};
