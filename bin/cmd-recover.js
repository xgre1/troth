// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: recover).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "recover") {
  // `troth recover --recovery-key-dir <path> --new-key-dir <path>`
  // Re-anchors substrate authority via the recovery_directive's pre-
  // authorized successor key. Passphrases for BOTH the recovery key
  // and the new primary key are read separately. Env shortcuts:
  //   TROTH_RECOVERY_PASSPHRASE / TROTH_OPERATOR_PASSPHRASE_NEW
  function _flag(name) {
    var idx = args.indexOf(name);
    return (idx >= 0 && args[idx + 1]) ? args[idx + 1] : null;
  }
  var recoveryDir = _flag("--recovery-key-dir");
  var newDir      = _flag("--new-key-dir");
  if (!recoveryDir || !newDir) {
    console.error("Usage: troth recover --recovery-key-dir <path> --new-key-dir <path>");
    console.error("  Optional env: TROTH_RECOVERY_PASSPHRASE, TROTH_OPERATOR_PASSPHRASE_NEW");
    process.exit(2);
  }
  var recoverMod = require("../shared-core/recover.js");
  var bootMod2   = require("../shared-core/bootstrap.js");
  var directive  = bootMod2.getActiveRecoveryDirective();
  if (!directive) {
    console.error("Refused: no active recovery_directive in substrate. Re-init with --recovery-pubkey to enable recovery.");
    process.exit(2);
  }
  console.log("Active recovery directive pinned to pubkey: " + directive.recovery_public_key_id);
  var recPass = process.env.TROTH_RECOVERY_PASSPHRASE || _readPassphraseSync("Recovery key passphrase");
  // Swap env so the second read uses the dedicated var
  var savedEnv = process.env.TROTH_OPERATOR_PASSPHRASE;
  if (process.env.TROTH_OPERATOR_PASSPHRASE_NEW) {
    process.env.TROTH_OPERATOR_PASSPHRASE = process.env.TROTH_OPERATOR_PASSPHRASE_NEW;
  } else {
    delete process.env.TROTH_OPERATOR_PASSPHRASE;
  }
  var newPass = _readPassphraseSync("New primary key passphrase (>= 8 chars)");
  if (savedEnv === undefined) delete process.env.TROTH_OPERATOR_PASSPHRASE;
  else process.env.TROTH_OPERATOR_PASSPHRASE = savedEnv;
  if (!newPass || newPass.length < 8) {
    console.error("Refused: new passphrase must be >= 8 chars.");
    process.exit(2);
  }
  var rr = recoverMod.runRecovery({
    recovery_passphrase: recPass,
    recovery_key_dir:    recoveryDir,
    new_passphrase:      newPass,
    new_key_dir:         newDir
  });
  if (!rr.ok) {
    console.error("Recovery failed: " + rr.error + (rr.detail ? ' — ' + rr.detail : ''));
    process.exit(2);
  }
  console.log("Substrate re-anchored.");
  console.log("  new pubkey id:             " + rr.new_public_key_id);
  console.log("  new operator_key engram:   " + rr.new_operator_key_engram_id);
  if (rr.old_operator_key_engram_id) {
    console.log("  retired (superseded) engram: " + rr.old_operator_key_engram_id);
  }
  console.log("  recovery directive used:   " + rr.recovery_directive_id);
  console.log("\nNew key material at " + newDir + " — set TROTH_OPERATOR_KEY_DIR=" + newDir + " or move into ~/.troth/operator-keys/");
  process.exit(0);
}
};
