// SPDX-License-Identifier: AGPL-3.0-only
// `troth agents [dir]` — write or refresh the troth contract block in a
// project's AGENTS.md, the cross-tool file nearly every coding agent reads at
// session start. This is the road troth's guidance takes to agents that
// carry none of its hooks. Running the command IS the consent: troth never
// plants text in an operator's repository on its own.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "agents") {
  var pathA = require('path');
  var contract = require('../shared-core/agents-contract.js');
  var projectId = require('../shared-core/project-id.js');

  var target = passthrough[0] ? pathA.resolve(passthrough[0]) : process.cwd();
  // The project is the repository, not the folder the shell happens to be in.
  var dir = projectId.projectRootFor(target);
  var r;
  try { r = contract.applyToDir(dir); }
  catch (e) { console.error('Could not write AGENTS.md: ' + e.message); process.exit(1); }

  var said = {
    created:   'created ' + r.file,
    appended:  'added the troth block to ' + r.file,
    updated:   'refreshed the troth block in ' + r.file,
    unchanged: r.file + ' already carries the current block'
  }[r.action];
  console.log('\x1b[32m✓\x1b[0m ' + said);
  console.log('Every agent that reads AGENTS.md (Codex, Cursor, Copilot, Gemini CLI, ...) now meets the substrate first.');
  process.exit(0);
}
};
