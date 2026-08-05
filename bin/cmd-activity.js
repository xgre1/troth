// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: activity).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, _flagL4, _hasFlagL4 } = ctx;
if (command === "activity") {
  // troth activity [--json] [--limit N]   compact activity snapshot
  // Read-only — never writes; never signs. Cheap enough to call from
  // Tauri Activity tab poll (~every 2-3s).
  var ap = require("../shared-core/active-project.js");
  var limitA = _flagL4("--limit");
  var snap = ap.activitySnapshot({ limit_recent: limitA ? Number(limitA) : 10 });
  if (_hasFlagL4("--json")) {
    process.stdout.write(JSON.stringify(snap));
    process.exit(0);
  }
  console.log("Partner Activity (now_state: " + snap.now_state + ")");
  console.log("");
  console.log("  Active projects: " + snap.active_projects.length);
  snap.active_projects.forEach(function (p) {
    console.log("    • " + p.short_name + " — " + (p.purpose || '(no purpose)'));
  });
  console.log("");
  console.log("  Drafts pending: " + snap.open_drafts.length);
  snap.open_drafts.forEach(function (d) {
    console.log("    • " + d.short_name + " — " + (d.purpose || '(no purpose)') + "  [id: " + d.id.slice(0, 8) + "]");
  });
  console.log("");
  console.log("  Recent events (" + snap.recent_events.length + "):");
  snap.recent_events.forEach(function (e) {
    var ago = e.ts ? Math.floor((Date.now() - e.ts) / 1000) + "s ago" : "?";
    console.log("    [" + e.kind + " " + ago + "] " + (e.statement || e.scope).slice(0, 80));
  });
  process.exit(0);
}
};
