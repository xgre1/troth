// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: config).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command === "config" && args[1] === "web" && args[2] === "allowlist") {
  var allow = require("../shared-core/tools/web-allowlist.js");
  var sub = args[3] || "list";
  try {
    if (sub === "list") {
      var ds = allow.listAllowed();
      console.log("Allowlist (" + ds.length + " domain" + (ds.length === 1 ? "" : "s") + ") @ " + allow.path);
      for (var ix = 0; ix < ds.length; ix++) console.log("  " + ds[ix]);
      process.exit(0);
    }
    if (sub === "add") {
      var p1 = args[4];
      if (!p1) { console.error("Usage: troth config web allowlist add <domain-or-*.domain>"); process.exit(2); }
      var r1 = allow.addDomain(p1);
      console.log("Added. Allowlist now " + r1.length + " domains.");
      process.exit(0);
    }
    if (sub === "remove") {
      var p2 = args[4];
      if (!p2) { console.error("Usage: troth config web allowlist remove <domain-or-*.domain>"); process.exit(2); }
      var r2 = allow.removeDomain(p2);
      console.log("Removed. Allowlist now " + r2.length + " domains.");
      process.exit(0);
    }
    if (sub === "reset") {
      var r3 = allow.resetToSeed();
      console.log("Reset to seed. Allowlist now " + r3.length + " domains.");
      process.exit(0);
    }
    console.error("Usage: troth config web allowlist <list|add|remove|reset>");
    process.exit(2);
  } catch (e) {
    console.error("Refused: " + e.message);
    process.exit(2);
  }
}
};
