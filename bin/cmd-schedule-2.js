// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: schedule).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "schedule") {
  var scheduler = require("../proxy/modules/scheduler");
  var subCmd = passthrough[0];
  if (subCmd === "add") {
    var cronExpr = passthrough[1];
    var schedTask = passthrough.slice(2).join(" ");
    if (!cronExpr || !schedTask) {
      console.error('Usage: troth schedule add "daily 9:00" "review PRs"');
      console.error('       troth schedule add "every 30m" "check build status"');
      console.error('       troth schedule add "hourly" "run tests"');
      process.exit(1);
    }
    var r = scheduler.addSchedule(cronExpr, schedTask);
    if (r.ok) {
      console.log("\x1b[32m✓\x1b[0m Schedule added: " + r.schedule.id);
      console.log("  cron: " + r.schedule.cron);
      console.log("  task: " + r.schedule.task);
      console.log("  cwd:  " + r.schedule.cwd);
      if (r.note) console.log("\x1b[33m!\x1b[0m " + r.note);
    } else {
      console.error("\x1b[31mError:\x1b[0m " + r.error);
    }
    process.exit(r.ok ? 0 : 1);
  }
  if (subCmd === "list" || !subCmd) {
    var scheds = scheduler.listSchedules();
    if (scheds.length === 0) {
      console.log("\x1b[2mNo schedules yet. Add one:\x1b[0m");
      console.log('  troth schedule add "daily 9:00" "review PRs"');
    } else {
      for (var si = 0; si < scheds.length; si++) {
        var s = scheds[si];
        var status = s.enabled ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
        console.log("  " + status + " " + s.id + "  " + s.cron + "  " + s.task.slice(0, 60));
        if (s.lastRun) console.log("    last: " + s.lastRun + (s.lastRunId ? " → " + s.lastRunId : ""));
      }
    }
    if (scheds.length && !scheduler.schedulingEnabled()) {
      console.log("\x1b[33m!\x1b[0m The scheduler timer is off, so none of these fire.");
      console.log("  Start the proxy with TROTH_ENABLE_SCHEDULER=1 to run them unattended.");
    }
    process.exit(0);
  }
  if (subCmd === "remove" || subCmd === "rm") {
    var rmId = passthrough[1];
    if (!rmId) { console.error("Usage: troth schedule remove <id>"); process.exit(1); }
    var r = scheduler.removeSchedule(rmId);
    if (r.ok) console.log("\x1b[32m✓\x1b[0m Removed schedule " + rmId);
    else console.error("\x1b[31mError:\x1b[0m " + r.error);
    process.exit(r.ok ? 0 : 1);
  }
  console.error("Usage: troth schedule [add|list|remove]");
  process.exit(1);
}
};
