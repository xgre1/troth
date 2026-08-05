// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: presence).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "presence") {
  var opKeyMod4 = require("../shared-core/operator-key.js");
  var presence4 = require("../shared-core/presence.js");
  if (!opKeyMod4.exists()) {
    console.error("Refused: no operator key. Run `troth init` first.");
    process.exit(2);
  }
  var note4 = args.slice(1).join(' ') || null;
  var pass4 = _readPassphraseSync("Operator passphrase");
  var signer4;
  try { signer4 = opKeyMod4.unlock(pass4); }
  catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
  try {
    var res4 = presence4.recordPresenceProof(signer4, { note: note4 });
    if (!res4.ok) { console.error("Refused: " + (res4.error || 'unknown')); process.exit(2); }
    var ageHours = presence4.DEFAULT_MAX_AGE_MS / (60 * 60 * 1000);
    console.log("Presence recorded (engram " + res4.id + ").");
    console.log("Valid for ~" + ageHours + "h (max_age_ms=" + presence4.DEFAULT_MAX_AGE_MS + ").");
  } finally { try { signer4.lock(); } catch (_) {} }
  process.exit(0);
}
};
