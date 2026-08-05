// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: unlock).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, _readPassphraseSync, _flagL4 } = ctx;
if (command === "unlock") {
  // troth unlock [--ttl-hours N]   default 8h
  var opKeyU = require("../shared-core/operator-key.js");
  if (!opKeyU.exists()) {
    console.error("Refused: no operator key. Run `troth init` first.");
    process.exit(2);
  }
  var ttlHoursStr = _flagL4("--ttl-hours");
  var ttlMs = (ttlHoursStr && Number(ttlHoursStr) > 0)
    ? Number(ttlHoursStr) * 60 * 60 * 1000
    : opKeyU.SESSION_DEFAULT_TTL_MS;
  var passU = _readPassphraseSync("Operator passphrase");
  var resU;
  try {
    resU = opKeyU.unlockSession(passU, { ttl_ms: ttlMs });
  } catch (e) {
    console.error("Unlock failed: " + e.message);
    process.exit(2);
  }
  console.log("Operator session unlocked.");
  console.log("  public_key_id: " + resU.public_key_id);
  console.log("  expires_at:    " + new Date(resU.expires_at).toISOString());
  console.log("  ttl_hours:     " + (ttlMs / 1000 / 60 / 60).toFixed(2));
  console.log("");
  console.log("Future `troth` commands needing operator signature will pick up");
  console.log("the cached signer without re-prompting. Run `troth lock` to wipe.");
  process.exit(0);
}
};
