// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: incognito).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "incognito") {
  var incoStateFile = require("path").join(require("os").homedir(), ".troth", "incognito.json");
  var incoFs = require("fs");
  var incoPath = require("path");
  var incoSub = (passthrough[0] || "status").toLowerCase();
  function incoRead() {
    try { return JSON.parse(incoFs.readFileSync(incoStateFile, "utf8")); }
    catch (e) { return { enabled: false, since: null }; }
  }
  function incoWrite(s) {
    try {
      incoFs.mkdirSync(incoPath.dirname(incoStateFile), { recursive: true });
      incoFs.writeFileSync(incoStateFile, JSON.stringify(s, null, 2));
    } catch (e) { console.error("write failed:", e.message); process.exit(1); }
  }
  var incoSt = incoRead();
  if (incoSub === "on") {
    incoWrite({ enabled: true, since: new Date().toISOString() });
    console.log("🕶️  incognito ON — substrate writes muted system-wide");
  } else if (incoSub === "off") {
    incoWrite({ enabled: false, since: null });
    console.log("👁  incognito OFF — substrate writes resume");
  } else if (incoSub === "toggle") {
    var incoNext = !incoSt.enabled;
    incoWrite({ enabled: incoNext, since: incoNext ? new Date().toISOString() : null });
    console.log((incoNext ? "🕶️  incognito ON" : "👁  incognito OFF"));
  } else {
    console.log((incoSt.enabled ? "🕶️  incognito ON" : "👁  incognito OFF") +
      (incoSt.since ? "  (since " + incoSt.since + ")" : ""));
  }
  process.exit(0);
}
};
