// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: inheritance).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "inheritance") {
  // `troth inheritance status`     — show whether an inheritance directive exists
  // `troth inheritance claim --successor-key-dir <path> --new-key-dir <path>`
  //                                  — successor re-anchors substrate after operator death
  var bootMod11   = require("../shared-core/bootstrap.js");
  var sub11 = args[1] || "status";
  if (sub11 === "status") {
    var d11 = bootMod11.getActiveInheritanceDirective();
    if (!d11) {
      console.log("No active inheritance_directive. (Pass --inheritance-pubkey at init to enable end-of-life flow.)");
      process.exit(0);
    }
    console.log("Active inheritance directive:");
    console.log("  id:                       " + d11.id);
    console.log("  successor pubkey id:      " + d11.inheritance_public_key_id);
    console.log("  dormancy_threshold:       " + Math.round(d11.dormancy_threshold_ms / (24 * 60 * 60 * 1000)) + "d");
    console.log("  dissolve_on_dormant:      " + d11.dissolve_on_dormant);
    if (d11.inheritance_note) console.log("  note:                    " + d11.inheritance_note);
    process.exit(0);
  }
  if (sub11 === "claim") {
    function _flag11(name) {
      var idx = args.indexOf(name);
      return (idx >= 0 && args[idx + 1]) ? args[idx + 1] : null;
    }
    var succDir = _flag11("--successor-key-dir");
    var newDir11 = _flag11("--new-key-dir");
    if (!succDir || !newDir11) {
      console.error("Usage: troth inheritance claim --successor-key-dir <path> --new-key-dir <path>");
      console.error("  Optional env: TROTH_SUCCESSOR_PASSPHRASE, TROTH_OPERATOR_PASSPHRASE_NEW");
      process.exit(2);
    }
    var inhMod = require("../shared-core/inheritance.js");
    var directive11 = bootMod11.getActiveInheritanceDirective();
    if (!directive11) {
      console.error("Refused: no active inheritance_directive in substrate.");
      process.exit(2);
    }
    if (directive11.dissolve_on_dormant) {
      console.error("Refused: inheritance_directive.dissolve_on_dormant=true. Partner is set to die with operator.");
      process.exit(2);
    }
    console.log("Active inheritance directive pinned to pubkey: " + directive11.inheritance_public_key_id);
    var succPass = process.env.TROTH_SUCCESSOR_PASSPHRASE || _readPassphraseSync("Successor key passphrase");
    var savedEnv11 = process.env.TROTH_OPERATOR_PASSPHRASE;
    if (process.env.TROTH_OPERATOR_PASSPHRASE_NEW) {
      process.env.TROTH_OPERATOR_PASSPHRASE = process.env.TROTH_OPERATOR_PASSPHRASE_NEW;
    } else { delete process.env.TROTH_OPERATOR_PASSPHRASE; }
    var newPass11 = _readPassphraseSync("New primary key passphrase (>= 8 chars)");
    if (savedEnv11 === undefined) delete process.env.TROTH_OPERATOR_PASSPHRASE;
    else process.env.TROTH_OPERATOR_PASSPHRASE = savedEnv11;
    if (!newPass11 || newPass11.length < 8) {
      console.error("Refused: new passphrase must be >= 8 chars.");
      process.exit(2);
    }
    var cr = inhMod.runClaim({
      successor_passphrase: succPass,
      successor_key_dir:    succDir,
      new_passphrase:       newPass11,
      new_key_dir:          newDir11
    });
    if (!cr.ok) {
      console.error("Inheritance claim failed: " + cr.error + (cr.detail ? ' — ' + cr.detail : ''));
      process.exit(2);
    }
    console.log("Substrate re-anchored to successor.");
    console.log("  new pubkey id:               " + cr.new_public_key_id);
    console.log("  new operator_key engram:     " + cr.new_operator_key_engram_id);
    if (cr.old_operator_key_engram_id) console.log("  retired engram:              " + cr.old_operator_key_engram_id);
    console.log("  inheritance_directive used:  " + cr.inheritance_directive_id);
    console.log("\nFresh presence_proof auto-recorded. Substrate exits dormant.");
    process.exit(0);
  }
  console.error("Unknown inheritance subcommand: " + sub11 + ". Try: status | claim");
  process.exit(2);
}
};
