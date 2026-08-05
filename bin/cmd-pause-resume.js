// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: pause, resume).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "pause" || command === "resume") {
  var opKeyMod3 = require("../shared-core/operator-key.js");
  var gp3 = require("../shared-core/global-pause.js");
  if (!opKeyMod3.exists()) {
    console.error("Refused: no operator key. Run `troth init` first.");
    process.exit(2);
  }
  var reason = args.slice(1).join(' ') || null;
  var pass3 = _readPassphraseSync("Operator passphrase");
  var signer3;
  try { signer3 = opKeyMod3.unlock(pass3); }
  catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
  try {
    var res3 = (command === "pause")
      ? gp3.pause(signer3, { reason: reason })
      : gp3.resume(signer3, { reason: reason });
    if (!res3.ok) {
      console.error("Refused: " + (res3.error || 'unknown'));
      process.exit(2);
    }
    console.log((command === "pause" ? "Paused" : "Resumed") + " (engram " + res3.id + ").");
    // Auto-stamp presence: operator just signed something — they're here.
    try { require("../shared-core/presence.js").recordPresenceProof(signer3, { note: 'auto via troth ' + command }); } catch (_) {}
  } finally {
    try { signer3.lock(); } catch (_) {}
  }
  process.exit(0);
}
};
