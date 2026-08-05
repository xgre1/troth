// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: schema).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "schema") {
  var stateS = require("../shared-core/state.js");
  var subS = passthrough[0];

  if (subS === "list") {
    var statusFilter = null, sigFilter = null;
    for (var si = 1; si < passthrough.length; si++) {
      if (passthrough[si] === "--status" && si + 1 < passthrough.length) { statusFilter = passthrough[++si]; }
      else if (passthrough[si] === "--signature" && si + 1 < passthrough.length) { sigFilter = passthrough[++si]; }
    }
    var profiles = stateS.listWireFormatProfiles({
      status: statusFilter, domain_signature: sigFilter, limit: 50
    });
    if (!profiles.length) { console.log("No wire-format profiles yet."); process.exit(0); }
    console.log("status      author        signature         aliases  id");
    console.log("-".repeat(72));
    for (var pi = 0; pi < profiles.length; pi++) {
      var p = profiles[pi];
      var aliasCount = 0;
      try { aliasCount = Object.keys(JSON.parse(p.header_json).aliases || {}).length; } catch (e) {}
      console.log(
        (p.status + "         ").slice(0, 11) + " " +
        (p.author || "?         ").slice(0, 13).padEnd(13) + " " +
        p.domain_signature.slice(0, 16) + "  " +
        String(aliasCount).padStart(7) + "  " +
        p.id.slice(0, 8)
      );
    }
    process.exit(0);
  }

  if (subS === "show") {
    var showId = passthrough[1];
    if (!showId) { console.error("Usage: troth schema show <id>"); process.exit(1); }
    var p2 = stateS.getWireFormatProfile(showId);
    if (!p2) { console.error("Profile not found: " + showId); process.exit(1); }
    console.log("id:               " + p2.id);
    console.log("status:           " + p2.status);
    console.log("domain_signature: " + p2.domain_signature);
    console.log("author:           " + (p2.author || "?"));
    console.log("created_at:       " + new Date(p2.created_at).toISOString());
    if (p2.activated_at) console.log("activated_at:     " + new Date(p2.activated_at).toISOString());
    if (p2.discarded_at) console.log("discarded_at:     " + new Date(p2.discarded_at).toISOString());
    if (p2.perf_score != null) console.log("perf_score:       " + p2.perf_score);
    if (p2.sample_count != null) console.log("sample_count:     " + p2.sample_count);
    console.log("");
    console.log("header_json:");
    try { console.log(JSON.stringify(JSON.parse(p2.header_json), null, 2)); }
    catch (e) { console.log(p2.header_json); }
    process.exit(0);
  }

  if (subS === "activate") {
    var actId = passthrough[1];
    if (!actId) { console.error("Usage: troth schema activate <id>"); process.exit(1); }
    var ok = stateS.activateWireFormatProfile(actId);
    if (!ok) { console.error("Activate failed (profile not found or already discarded)"); process.exit(1); }
    console.log("\x1b[32m✓\x1b[0m activated profile " + actId.slice(0, 8));
    process.exit(0);
  }

  if (subS === "discard") {
    var disId = passthrough[1];
    if (!disId) { console.error("Usage: troth schema discard <id>"); process.exit(1); }
    var ok2 = stateS.discardWireFormatProfile(disId);
    if (!ok2) { console.error("Discard failed (profile not found)"); process.exit(1); }
    console.log("\x1b[32m✓\x1b[0m discarded profile " + disId.slice(0, 8));
    process.exit(0);
  }

  if (subS === "active") {
    var actSig = null;
    for (var ai = 1; ai < passthrough.length; ai++) {
      if (passthrough[ai] === "--signature" && ai + 1 < passthrough.length) { actSig = passthrough[++ai]; }
    }
    if (!actSig) { console.error("Usage: troth schema active --signature <sig>"); process.exit(1); }
    var pa = stateS.getActiveWireFormatProfile(actSig);
    if (!pa) { console.log("No active profile for signature: " + actSig); process.exit(0); }
    console.log("active profile id: " + pa.id);
    console.log("author:            " + (pa.author || "?"));
    console.log("activated_at:      " + new Date(pa.activated_at).toISOString());
    process.exit(0);
  }

  console.error("Usage:");
  console.error("  troth schema list [--status candidate|active|discarded] [--signature <sig>]");
  console.error("  troth schema show <id>");
  console.error("  troth schema activate <id>");
  console.error("  troth schema discard <id>");
  console.error("  troth schema active --signature <sig>");
  process.exit(1);
}
};
