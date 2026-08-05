// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: confirm).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command, _readPassphraseSync } = ctx;
if (command === "confirm") {
  if (!args[1]) {
    console.error("Usage: troth confirm <engram_id>");
    process.exit(2);
  }
  var opKeyMod = require("../shared-core/operator-key.js");
  var engramMod = require("../shared-core/engram.js");
  if (!opKeyMod.exists()) {
    console.error("Refused: no operator key. Run `troth init` first.");
    process.exit(2);
  }
  var targetId = args[1];
  // Pull the target engram. listEngrams doesn't accept an id filter, so
  // we fetch a bounded pool and find. Acceptable for v1.
  var pool = engramMod.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
  var target = pool.find(function (e) { return e.id === targetId; });
  if (!target) {
    console.error("Refused: engram " + targetId + " not found in recent pool (2000).");
    process.exit(2);
  }
  var stmt = target.statement || (target.output && target.output.statement);
  if (!stmt) {
    console.error("Refused: target engram has no statement.");
    process.exit(2);
  }
  var pass2 = _readPassphraseSync("Operator passphrase");
  var signer;
  try { signer = opKeyMod.unlock(pass2); }
  catch (e) { console.error("Unlock failed: " + e.message); process.exit(2); }
  try {
    var canon = opKeyMod.canonicalEngramBody({
      statement: stmt,
      scope: target.scope || (target.output && target.output.scope) || null,
      source_authority: 'operator_confirmed',
      extra_output: { promoted_from: targetId, lifetime: { supersedes: targetId, reason: 'operator_confirmation' } }
    });
    var sig = signer.sign(canon);
    var newId = engramMod.recordEngram({
      agent_id: 'operator',
      user_id:  'operator',
      cwd:      target.cwd || null,
      statement: stmt,
      source:   'operator-confirm via troth-confirm CLI',
      source_authority: 'operator_confirmed',
      scope: target.scope || (target.output && target.output.scope) || null,
      signature: sig,
      extra_output: { promoted_from: targetId, lifetime: { supersedes: targetId, reason: 'operator_confirmation' } },
      auto_verify: false
    });
    if (!newId) {
      console.error("Refused at engram.write — see logs.");
      process.exit(2);
    }
    console.log("Promoted " + targetId + " → " + newId + " (operator_confirmed, supersedes original).");
    // Auto-stamp presence: signed CLI invocation = bodily presence assertion.
    try { require("../shared-core/presence.js").recordPresenceProof(signer, { note: 'auto via troth confirm' }); } catch (_) {}
  } finally {
    try { signer.lock(); } catch (_) {}
  }
  process.exit(0);
}
};
