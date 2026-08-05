// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: drafts).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _getOperatorSigner, _flagL4 } = ctx;
if (command === "drafts") {
  // troth drafts list
  // troth drafts confirm <draft_engram_id>
  var subD = args[1];
  var ap = require("../shared-core/active-project.js");
  if (subD === "list") {
    var drafts = ap.listDrafts();
    if (!drafts.length) {
      console.log("No draft active_projects waiting for confirmation.");
      process.exit(0);
    }
    console.log("Draft active_projects (operator confirmation pending):");
    for (var i = 0; i < drafts.length; i++) {
      var d = drafts[i];
      console.log("  " + d.id);
      console.log("    short_name: " + d.short_name);
      console.log("    purpose:    " + (d.purpose || '(none)'));
      if (d.classifier) {
        console.log("    classifier: verb=" + d.classifier.verb +
                    " subject=" + (d.classifier.subject || '?') +
                    " confidence=" + (typeof d.classifier.confidence === 'number' ? d.classifier.confidence.toFixed(2) : '?'));
        if (d.classifier.origin_text) {
          console.log("    origin:     \"" + String(d.classifier.origin_text).slice(0, 140) + "\"");
        }
      }
      console.log("");
    }
    console.log("Confirm with: troth drafts confirm <id>");
    process.exit(0);
  }
  if (subD === "cancel") {
    var cancelArg = args[2];
    if (!cancelArg) {
      console.error("Usage: troth drafts cancel <draft_engram_id_or_scope> [--reason \"<text>\"]");
      process.exit(2);
    }
    var reasonD = _flagL4("--reason");
    var opKeyDC = require("../shared-core/operator-key.js");
    if (!opKeyDC.exists()) { console.error("Refused: no operator key. Run `troth init` first."); process.exit(2); }
    var signerDC;
    try {
      var unlockedDC = _getOperatorSigner("Operator passphrase");
      signerDC = unlockedDC.signer;
    } catch (e) { console.error(e.message); process.exit(2); }
    try {
      var resDC = ap.cancelProject(cancelArg, signerDC, { reason: reasonD });
      if (!resDC.ok) {
        console.error("Refused: " + (resDC.error || 'unknown') + (resDC.detail ? ' — ' + resDC.detail : ''));
        process.exit(2);
      }
      console.log("Cancelled: " + resDC.scope);
      console.log("  engram_id: " + resDC.id);
      if (reasonD) console.log("  reason:    " + reasonD);
    } finally { try { signerDC.lock(); } catch (_) {} }
    process.exit(0);
  }
  if (subD === "confirm") {
    var draftId = args[2];
    if (!draftId) {
      console.error("Usage: troth drafts confirm <draft_engram_id>");
      process.exit(2);
    }
    var opKeyD = require("../shared-core/operator-key.js");
    if (!opKeyD.exists()) { console.error("Refused: no operator key. Run `troth init` first."); process.exit(2); }
    var signerD, fromSessionD;
    try {
      var unlockedD = _getOperatorSigner("Operator passphrase");
      signerD = unlockedD.signer;
      fromSessionD = unlockedD.from_session;
    } catch (e) { console.error(e.message); process.exit(2); }
    try {
      var resD = ap.confirmDraft(draftId, signerD);
      if (!resD.ok) {
        console.error("Refused: " + (resD.error || 'unknown') + (resD.detail ? ' — ' + resD.detail : ''));
        process.exit(2);
      }
      console.log("Confirmed: draft → active");
      console.log("  scope:       " + resD.scope);
      console.log("  engram_id:   " + resD.id);
      console.log("  via_session: " + (fromSessionD ? 'yes (no passphrase)' : 'no (passphrase prompt)'));
      try { require("../shared-core/presence.js").recordPresenceProof(signerD, { note: 'auto via troth drafts confirm' }); } catch (_) {}
    } finally { try { signerD.lock(); } catch (_) {} }
    process.exit(0);
  }
  console.error("Usage: troth drafts list | troth drafts confirm <draft_engram_id> | troth drafts cancel <id_or_scope> [--reason]");
  process.exit(2);
}
};
