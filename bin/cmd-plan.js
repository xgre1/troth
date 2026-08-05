// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: plan).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { fs, path, command } = ctx;
if (command === "plan") {
  // Show current workflow state
  try {
    var planFile = path.join(process.cwd(), '.troth', 'workflow.json');
    if (!fs.existsSync(planFile)) { console.log('No active workflow plan in this directory.'); process.exit(0); }
    var plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    console.log('=== Workflow State ===');
    console.log('Task:  ' + plan.task);
    console.log('Phase: ' + plan.phase);
    console.log('Started: ' + new Date(plan.started_at).toISOString().slice(0, 16).replace('T', ' '));
    if (plan.plan) console.log('\nPlan:\n' + plan.plan);
    if (plan.completed_steps && plan.completed_steps.length) {
      console.log('\nCompleted (' + plan.completed_steps.length + '):');
      plan.completed_steps.forEach(function(s) { console.log('  [x] ' + s); });
    }
    if (plan.pending_steps && plan.pending_steps.length) {
      console.log('\nPending (' + plan.pending_steps.length + '):');
      plan.pending_steps.forEach(function(s) { console.log('  [ ] ' + s); });
    }
    process.exit(0);
  } catch (e) { console.error('Plan failed:', e.message); process.exit(1); }
}
};
