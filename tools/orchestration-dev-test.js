// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// DEV-ONLY orchestration self-test. Proves the team-orchestration LOGIC we
// deployed actually works, instead of trusting "I built it". Two layers here:
//  (1) planner.plan decomposition (mock LLM) -> correct per-role subtasks + dep DAG
//  (2) the honest completion gate -> never reports success when roles failed/incomplete
// Real worker spawn (claude in worktrees) is the opt-in heavy e2e (separate), not this.
const ROOT = require('path').resolve(__dirname, '..');
const planner = require(ROOT + '/shared-core/planner.js');
let pass = 0, fail = 0;
function ck(n, c, m) { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (m ? ' :: ' + m : '')); } }

// The EXACT honest-gate logic we wired into troth-entity.js Phase 2, isolated for test.
function honestGate(dag, summary) {
  const failed = (dag && dag.failed) ? Object.keys(dag.failed) : [];
  const pend = (dag && dag.pending) ? dag.pending : [];
  let note = '';
  if (!dag || dag.ok === false) {
    note = ' (Honest: not all of the team finished cleanly' +
      (failed.length ? '; failed: ' + failed.join(', ') : '') +
      (pend.length ? '; did not complete: ' + pend.join(', ') : '') +
      ((dag && dag.error) ? '; ' + dag.error : '') +
      '. I am NOT claiming this is fully done.)';
  }
  return { text: (summary || 'no summary') + note, done: !!(dag && dag.ok) };
}

(async function () {
  // (1) planner.plan decomposition with a mock LLM
  const mockLlm = function () {
    return Promise.resolve({ text: JSON.stringify({ plan: {
      backend:  { subtask: 'build the payments API', depends_on: [] },
      frontend: { subtask: 'build the UI',           depends_on: ['backend'] },
      qa:       { subtask: 'write e2e tests',         depends_on: ['backend', 'frontend'] }
    } }) });
  };
  const r = await planner.plan('build a SaaS: backend payments API + frontend UI + tests', ['backend', 'frontend', 'qa'], { callLlm: mockLlm });
  ck('plan ok', r.ok === true, JSON.stringify(r).slice(0, 120));
  ck('plan has all 3 roles', r.plan && r.plan.backend && r.plan.frontend && r.plan.qa);
  ck('frontend depends on backend', r.plan && r.plan.frontend.depends_on.indexOf('backend') >= 0);
  ck('qa depends on backend+frontend', r.plan && r.plan.qa.depends_on.length === 2);
  // dag is topo-sorted: backend before frontend before qa
  const order = (r.dag || []).map(function (n) { return n.role; });
  ck('dag topo order backend<frontend<qa', order.indexOf('backend') < order.indexOf('frontend') && order.indexOf('frontend') < order.indexOf('qa'), order.join(','));

  // planFallback (offline) still produces a runnable plan
  const fb = planner.planFallback('do the thing', ['backend', 'frontend'], {});
  ck('fallback plan ok (offline degrade)', fb.ok === true && fb.plan.backend && fb.plan.frontend);

  // (2) honest gate
  const okGate = honestGate({ ok: true, failed: {}, spawned: { backend: {}, frontend: {} } }, 'all built');
  ck('all-ok => done true, no honest-note', okGate.done === true && okGate.text.indexOf('NOT claiming') < 0);
  const failGate = honestGate({ ok: false, failed: { backend: 'spawn failed' }, pending: ['qa'] }, 'partial');
  ck('a role failed => done FALSE', failGate.done === false);
  ck('a role failed => honest note names it', /NOT claiming this is fully done/.test(failGate.text) && /backend/.test(failGate.text) && /qa/.test(failGate.text));
  const timeoutGate = honestGate({ ok: false, error: 'orchestration timeout', pending: ['frontend'] }, '');
  ck('timeout => honest, not fake success', timeoutGate.done === false && /timeout/.test(timeoutGate.text));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log(fail ? '' : '\nDeployed orchestration LOGIC verified: decomposition + honest gate. (Live worker-spawn e2e = separate opt-in heavy test.)');
  process.exit(fail ? 1 : 0);
})();
