// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: memory-clear).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { fs, path, HOME, command, passthrough } = ctx;
if (command === "memory-clear") {
  // Clear reflexion memory (stale lessons from prior projects)
  var what = passthrough[0] || 'reflexions';
  if (!['reflexions', 'workflow', 'all'].includes(what)) {
    console.error('Usage: troth memory-clear [reflexions|workflow|all]');
    process.exit(1);
  }
  try {
    if (what === 'reflexions' || what === 'all') {
      var rPath = path.join(HOME, '.troth', 'reflexion.db');
      if (fs.existsSync(rPath)) { fs.unlinkSync(rPath); console.log('Cleared reflexions DB'); }
      else { console.log('No reflexions DB to clear'); }
    }
    if (what === 'workflow' || what === 'all') {
      var wPath = path.join(process.cwd(), '.troth', 'workflow.json');
      if (fs.existsSync(wPath)) { fs.unlinkSync(wPath); console.log('Cleared workflow state'); }
      else { console.log('No workflow state to clear'); }
    }
    if (what === 'all') {
      var tPath = path.join(HOME, '.troth', 'trajectories.db');
      if (fs.existsSync(tPath)) { fs.unlinkSync(tPath); console.log('Cleared trajectories DB'); }
    }
    console.log('Memory cleared. Restart proxy to take effect.');
    process.exit(0);
  } catch (e) { console.error('Clear failed:', e.message); process.exit(1); }
}
};
