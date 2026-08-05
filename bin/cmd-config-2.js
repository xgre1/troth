// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: config).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command === "config" && args[1] === "credential") {
  var vault = require("../shared-core/tools/credential-vault.js");
  var csub = args[2] || "list";
  try {
    if (csub === "list") {
      var creds = vault.listCredentials({});
      console.log("Vault @ " + vault.path + " (" + creds.length + " credential" + (creds.length === 1 ? "" : "s") + "):");
      for (var ci = 0; ci < creds.length; ci++) {
        var cc = creds[ci];
        var scopeStr = (cc.allowed_classes && cc.allowed_classes.length) ? cc.allowed_classes.join(",") : "any";
        console.log("  " + cc.name + " · scope: " + scopeStr + (cc.description ? " · " + cc.description : ""));
      }
      process.exit(0);
    }
    if (csub === "add") {
      var cname = args[3];
      var cvalue = args[4];
      if (!cname || !cvalue) { console.error("Usage: troth config credential add NAME VALUE [--classes=c1,c2] [--desc=...]"); process.exit(2); }
      var classes = [];
      var desc = null;
      for (var ai = 5; ai < args.length; ai++) {
        if (args[ai].indexOf("--classes=") === 0) classes = args[ai].slice(10).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        else if (args[ai].indexOf("--desc=") === 0) desc = args[ai].slice(7);
      }
      vault.setCredential({ name: cname, value: cvalue, allowed_classes: classes, description: desc });
      console.log("OK · credential " + cname + " added.");
      process.exit(0);
    }
    if (csub === "remove") {
      var rname = args[3];
      if (!rname) { console.error("Usage: troth config credential remove NAME"); process.exit(2); }
      vault.removeCredential(rname);
      console.log("OK · credential " + rname + " removed.");
      process.exit(0);
    }
    console.error("Usage: troth config credential <list|add|remove>");
    process.exit(2);
  } catch (e) {
    console.error("Refused: " + e.message);
    process.exit(2);
  }
}
};
