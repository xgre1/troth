// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: config).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command === "config" && args[1] === "inbox") {
  var stateMod = require("../shared-core/state.js");
  var sub = args[2] || "list";
  try {
    if (sub === "list") {
      var status = args[3] || "pending";
      var rows = stateMod.listOperatorRequests({ status: status, limit: 100 });
      console.log("Operator inbox (" + rows.length + " " + status + "):");
      for (var ix = 0; ix < rows.length; ix++) {
        var r = rows[ix];
        var d = r.detail || {};
        console.log("  #" + r.id + " [" + r.urgency + "] " + r.kind + " · " + (r.goal_class || "no-class") +
                    " · " + new Date(r.ts).toISOString());
        console.log("      " + JSON.stringify(d));
      }
      process.exit(0);
    }
    if (sub === "resolve" || sub === "dismiss") {
      var id = parseInt(args[3], 10);
      if (!id) { console.error("Usage: troth config inbox " + sub + " <id> [note]"); process.exit(2); }
      var note = args.slice(4).join(" ") || null;
      var rr = stateMod.resolveOperatorRequest({
        id: id, status: sub === "dismiss" ? "dismissed" : "resolved",
        note: note, resolved_by: "operator"
      });
      if (rr.ok) { console.log("OK · request " + id + " " + (sub === "dismiss" ? "dismissed" : "resolved")); process.exit(0); }
      console.error("Refused: " + (rr.error || "no change")); process.exit(2);
    }
    console.error("Usage: troth config inbox <list|resolve|dismiss>");
    process.exit(2);
  } catch (e) {
    console.error("Refused: " + e.message);
    process.exit(2);
  }
}
};
