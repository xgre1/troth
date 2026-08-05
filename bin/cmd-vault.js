// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: vault).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "vault") {
  // `troth vault unlock`               — prompt passphrase, populate session cache
  // `troth vault lock`                 — zero out session cache
  // `troth vault status`               — show locked/unlocked + entry count
  // `troth vault list`                 — METADATA-only entry list (no values)
  // `troth vault set <key> <cap-scope-glob> [<injection-kind>] [<injection-name>]`
  //                                        prompts for VALUE (hidden), writes entry
  // `troth vault remove <key>`         — delete entry
  var vault7 = require("../shared-core/vault.js");
  var sub7 = args[1] || "status";
  if (sub7 === "status") {
    var s7 = vault7.status();
    console.log(JSON.stringify(s7, null, 2));
    process.exit(0);
  }
  if (sub7 === "lock") {
    vault7.lock();
    console.log("Vault locked.");
    process.exit(0);
  }
  if (sub7 === "unlock") {
    var pass7 = _readPassphraseSync("Operator passphrase (vault)");
    try {
      var u7 = vault7.unlock(pass7);
      console.log("Vault unlocked. " + u7.entry_count + " entries. Session expires at " + new Date(u7.session_expires_at).toISOString() + ".");
    } catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
    process.exit(0);
  }
  if (sub7 === "list") {
    var l7 = vault7.listEntries();
    if (!l7.ok) { console.error("Refused: " + l7.error); process.exit(2); }
    console.log(JSON.stringify(l7.entries, null, 2));
    process.exit(0);
  }
  if (sub7 === "set") {
    var key7 = args[2], capScope7 = args[3];
    var injKind = args[4] || "bearer";
    var injName = args[5] || null;
    if (!key7 || !capScope7) {
      console.error("Usage: troth vault set <key> <capability-scope-glob> [<injection-kind> [<header-or-env-name>]]");
      process.exit(2);
    }
    if (!vault7.isUnlocked()) {
      console.error("Refused: vault locked. Run `troth vault unlock` first.");
      process.exit(2);
    }
    var val7 = _readPassphraseSync("Credential value");
    var w7 = vault7.writeEntry({
      key: key7, value: val7,
      capability_scope_glob: capScope7,
      injection: injName ? { kind: injKind, name: injName } : { kind: injKind }
    });
    if (!w7.ok) { console.error("Refused: " + w7.error); process.exit(2); }
    console.log("Vault entry written: " + w7.key);
    process.exit(0);
  }
  if (sub7 === "remove") {
    var rkey7 = args[2];
    if (!rkey7) { console.error("Usage: troth vault remove <key>"); process.exit(2); }
    if (!vault7.isUnlocked()) {
      console.error("Refused: vault locked. Run `troth vault unlock` first.");
      process.exit(2);
    }
    var r7 = vault7.removeEntry(rkey7);
    if (!r7.ok) { console.error("Refused: " + r7.error); process.exit(2); }
    console.log("Removed: " + r7.key);
    process.exit(0);
  }
  console.error("Unknown vault subcommand: " + sub7);
  console.error("Try: status | unlock | lock | list | set | remove");
  process.exit(2);
}
};
