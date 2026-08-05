// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: race).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "race") {
  var runnerR = require("./runner");
  // `troth race "task" --providers qwen,opus,deepseek [--group myrace]`
  // Providers default to qwen,opus,deepseek when omitted.
  var providersArg = null;
  var groupArg = null;
  var taskParts = [];
  for (var i = 0; i < passthrough.length; i++) {
    if (passthrough[i] === '--providers' && i + 1 < passthrough.length) {
      providersArg = passthrough[i + 1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      i++;
    } else if (passthrough[i] === '--group' && i + 1 < passthrough.length) {
      groupArg = passthrough[i + 1];
      i++;
    } else {
      taskParts.push(passthrough[i]);
    }
  }
  process.exit(runnerR.cmdRace(taskParts.join(" "), {
    providers: providersArg,
    group_id: groupArg
  }));
}
};
