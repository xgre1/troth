// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: cap).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _getOperatorSigner, _flagL4, _hasFlagL4 } = ctx;
if (command === "cap") {
  var sub = args[1];
  if (sub !== "mint") {
    console.error("Usage: troth cap mint <scope> [--max low|medium|high|sealed_only] [--expiry-ms N] [--budget-usd N] [--budget-window-ms N] [--allow-eval]");
    process.exit(2);
  }
  var scope = args[2];
  if (!scope || scope.indexOf("capability:") !== 0) {
    console.error("Usage: scope must start with 'capability:' (e.g. 'capability:http:do:api.notion.com')");
    process.exit(2);
  }
  var maxC = _flagL4("--max") || "low";
  var expiryC = _flagL4("--expiry-ms");
  var budgetUsd = _flagL4("--budget-usd");
  var budgetWin = _flagL4("--budget-window-ms");
  var allowEval = _hasFlagL4("--allow-eval");
  var opKeyC = require("../shared-core/operator-key.js");
  var intentModC = require("../shared-core/intent.js");
  if (!opKeyC.exists()) { console.error("Refused: no operator key. Run `troth init` first."); process.exit(2); }
  var signerC, fromSessionC;
  try {
    var unlockedC = _getOperatorSigner("Operator passphrase");
    signerC = unlockedC.signer;
    fromSessionC = unlockedC.from_session;
  } catch (e) { console.error(e.message); process.exit(2); }
  try {
    // Must match the EXACT extra_output writeCapability assembles (it
    // adds parent_capability_id default + Object.assigns this on top).
    // Sign must == write or integration point refuses.
    var extraC = {
      payload_schema:       null,
      max_irreversibility:  maxC,
      expiry:               expiryC ? Number(expiryC) : null,
      revoked:              false,
      scope_glob:           scope,
      parent_capability_id: null,
      budget_usd:           budgetUsd ? Number(budgetUsd) : null,
      budget_window_ms:     budgetWin ? Number(budgetWin) : null
    };
    if (allowEval) extraC.allow_eval = true;
    var canonC = opKeyC.canonicalEngramBody({
      statement: "cap " + scope,
      scope: scope,
      source_authority: "operator_confirmed",
      extra_output: extraC
    });
    var resC = intentModC.writeCapability({
      scope: scope,
      statement: "cap " + scope,
      max_irreversibility: maxC,
      expiry: expiryC ? Number(expiryC) : null,
      signature: signerC.sign(canonC),
      extra_output: extraC
    });
    if (!resC.ok) { console.error("Refused: " + resC.error + (resC.detail ? ' — ' + resC.detail : '')); process.exit(2); }
    console.log("Capability minted: " + resC.id);
    console.log("  scope:               " + scope);
    console.log("  max_irreversibility: " + maxC);
    if (expiryC)  console.log("  expiry:              " + new Date(Number(expiryC)).toISOString());
    if (budgetUsd) console.log("  budget_usd:          " + budgetUsd);
    if (allowEval) console.log("  allow_eval:          true");
    try { require("../shared-core/presence.js").recordPresenceProof(signerC, { note: 'auto via troth cap mint' }); } catch (_) {}
  } finally { try { signerC.lock(); } catch (_) {} }
  process.exit(0);
}
};
