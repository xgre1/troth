// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: seal).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "seal") {
  // `troth seal --idempotency-key <key> [--scope <intent_scope>] [--note <text>]`
  // OR `troth seal --intent-id <engram_id>`
  function _flag6(name) {
    var idx = args.indexOf(name);
    return (idx >= 0 && args[idx + 1]) ? args[idx + 1] : null;
  }
  var idemKey = _flag6("--idempotency-key");
  var intentId = _flag6("--intent-id");
  var scopeArg = _flag6("--scope");
  var noteArg  = _flag6("--note");
  if (!idemKey && !intentId) {
    console.error("Usage: troth seal --idempotency-key <key> [--scope <intent_scope>] [--note <text>]");
    console.error("   or: troth seal --intent-id <engram_id>");
    process.exit(2);
  }
  var opKeyMod6 = require("../shared-core/operator-key.js");
  var sealMod6  = require("../shared-core/seal.js");
  if (!opKeyMod6.exists()) {
    console.error("Refused: no operator key. Run `troth init` first.");
    process.exit(2);
  }
  var pass6 = _readPassphraseSync("Operator passphrase");
  var signer6;
  try { signer6 = opKeyMod6.unlock(pass6); }
  catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
  try {
    var res6 = sealMod6.writeSeal({
      signer: signer6,
      sealed_intent_idempotency_key: idemKey,
      sealed_intent_id:              intentId,
      scope_of_intent:               scopeArg,
      note:                          noteArg
    });
    if (!res6.ok) { console.error("Refused: " + (res6.error || 'unknown')); process.exit(2); }
    console.log("Seal written (engram " + res6.id + ").");
    if (idemKey) console.log("  bound to idempotency_key: " + idemKey);
    if (intentId) console.log("  bound to intent id:      " + intentId);
    try { require("../shared-core/presence.js").recordPresenceProof(signer6, { note: 'auto via troth seal' }); } catch (_) {}
  } finally { try { signer6.lock(); } catch (_) {} }
  process.exit(0);
}
};
