// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: init).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { path, HOME, args, command, _readPassphraseSync } = ctx;
// `troth init` belongs to the interactive onboarding wizard (cmd-init-2.js);
// the operator crypto-bootstrap ceremony lives behind --seal. This guard would
// swallow bare `troth init` and exit before the wizard was ever reached .
if (command === "init" && args.indexOf("--seal") !== -1) {
  var bootstrap = require("../shared-core/bootstrap.js");
  var st = bootstrap.status();
  if (st.has_bootstrap_seal) {
    console.error("Refused: substrate is already bootstrapped (seal id " + st.bootstrap_seal_id + ").");
    console.error("Use the recovery_directive flow to re-anchor with a new key (Phase 1.4b).");
    process.exit(2);
  }
  var passphrase = _readPassphraseSync("Set operator passphrase (>= 8 chars)");
  if (!passphrase || passphrase.length < 8) {
    console.error("Refused: passphrase must be at least 8 chars.");
    process.exit(2);
  }
  // Charter is optional. Read a single-line summary from args[1] / env.
  var charter = args[1] || process.env.TROTH_PARTNER_CHARTER || "";
  var r = bootstrap.runInit({ passphrase: passphrase, charter: charter });
  if (!r.ok) {
    console.error("Bootstrap failed: " + r.error + (r.detail ? ' — ' + r.detail : ''));
    process.exit(2);
  }
  console.log("Substrate bootstrapped.");
  console.log("  operator public key id: " + r.public_key_id);
  console.log("  bootstrap_sealed engram: " + r.bootstrap_seal_id);
  if (r.partner_charter_id) {
    console.log("  partner_charter engram:  " + r.partner_charter_id);
  }
  console.log("\nKey material at " + path.join(HOME, ".troth", "operator-keys") + " (0600).");
  console.log("To promote LLM-captured facts: troth confirm <engram_id>");
  console.log("To halt all dispatch:          troth pause [reason]");
  process.exit(0);
}
};
