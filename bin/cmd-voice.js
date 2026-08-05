// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: voice).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "voice") {
  // `troth voice show`                        — display current voice profile
  // `troth voice set <key>=<value> [...more]` — operator-signed update
  //   Valid keys: name, tone, verbosity, prefer, avoid, notes
  //   Examples:
  //     troth voice set tone=terse verbosity=minimal
  //     troth voice set name=Felix prefer=substrate,partner avoid=agent,bot
  //     troth voice set notes="be technically precise, push back when wrong"
  var voiceMod = require("../shared-core/voice-profile.js");
  var sub10 = args[1] || "show";
  if (sub10 === "show") {
    var v10 = voiceMod.getActiveVoiceProfile();
    console.log(JSON.stringify(v10, null, 2));
    console.log("\n--- rendered for LLM tick ---");
    console.log(voiceMod.renderForTick());
    process.exit(0);
  }
  if (sub10 === "set") {
    var opKeyMod10 = require("../shared-core/operator-key.js");
    if (!opKeyMod10.exists()) {
      console.error("Refused: no operator key. Run `troth init` first.");
      process.exit(2);
    }
    var assignments = args.slice(2);
    if (!assignments.length) {
      console.error("Usage: troth voice set <key>=<value> [<key>=<value> ...]");
      console.error("       keys: name, tone (terse|warm|formal|playful|neutral),");
      console.error("             verbosity (minimal|normal|verbose),");
      console.error("             prefer=<comma-list>, avoid=<comma-list>, notes=<text>");
      process.exit(2);
    }
    var update10 = {};
    for (var i10 = 0; i10 < assignments.length; i10++) {
      var eq = assignments[i10].indexOf('=');
      if (eq < 0) {
        console.error("Bad assignment (missing =): " + assignments[i10]);
        process.exit(2);
      }
      var k10 = assignments[i10].slice(0, eq);
      var raw10 = assignments[i10].slice(eq + 1);
      if (k10 === 'prefer' || k10 === 'avoid') {
        update10.vocabulary_preferences = update10.vocabulary_preferences || {};
        update10.vocabulary_preferences[k10] = raw10.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      } else if (k10 === 'name' || k10 === 'tone' || k10 === 'verbosity' || k10 === 'notes') {
        update10[k10] = raw10;
      } else {
        console.error("Unknown key: " + k10);
        process.exit(2);
      }
    }
    var pass10 = _readPassphraseSync("Operator passphrase");
    var signer10;
    try { signer10 = opKeyMod10.unlock(pass10); }
    catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
    try {
      var res10 = voiceMod.writeVoiceProfile({ signer: signer10, profile: update10 });
      if (!res10.ok) { console.error("Refused: " + res10.error); process.exit(2); }
      console.log("Voice profile updated (engram " + res10.id + ").");
      console.log(JSON.stringify(res10.profile, null, 2));
      try { require("../shared-core/presence.js").recordPresenceProof(signer10, { note: 'auto via troth voice set' }); } catch (_) {}
    } finally { try { signer10.lock(); } catch (_) {} }
    process.exit(0);
  }
  console.error("Unknown voice subcommand: " + sub10 + ". Try: show | set");
  process.exit(2);
}
};
