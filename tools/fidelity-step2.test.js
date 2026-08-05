// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Sandbox: STATE_DB_PATH points at a throwaway DB; unique cwd double-isolates.
const ROOT = require('path').resolve(__dirname, '..');
const cv = require(ROOT + '/shared-core/critic-verdict.js');
const rules = require(ROOT + '/shared-core/fidelity-rules.js');
const state = require(ROOT + '/shared-core/state.js');
const actionRecord = require(ROOT + '/shared-core/action-record.js');

const CWD = '/tmp/fidelity-test-cwd-' + process.pid;
let pass = 0, fail = 0;
function check(name, cond, msg) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (msg ? ' :: ' + msg : '')); }
}

console.log('DB sandbox: ' + (process.env.STATE_DB_PATH || '(unset!)'));

// --- fidelity-rules scope filtering ---
// The shipped seed must carry no client-scoped rule: how an operator describes
// their work to their own customers is their opinion to hold, not one a default
// install arrives with. Point the loader at a fixture so these assertions do not
// depend on whose home directory happens to be live.
const fsR = require('fs'), osR = require('os'), pathR = require('path');
const rulesDir = fsR.mkdtempSync(pathR.join(osR.tmpdir(), 'fidelity-rules-'));
const prevRulesEnv = process.env.TROTH_FIDELITY_RULES;
process.env.TROTH_FIDELITY_RULES = pathR.join(rulesDir, 'absent.json');
check('shipped seed is 8 global rules', rules.loadRules({}).length === 8, 'got ' + rules.loadRules({}).length);
check('shipped seed contains no client rule', rules.loadRules({ clientWork: true }).length === 8,
  'got ' + rules.loadRules({ clientWork: true }).length);

const rulesFixture = pathR.join(rulesDir, 'rules.json');
fsR.writeFileSync(rulesFixture, JSON.stringify({ rules: [
  { id: 'op-client', scope: 'client', rule: 'an operator client rule' },
  { id: 'no-skip',   scope: 'global', rule: 'restated by the operator' }
] }));
process.env.TROTH_FIDELITY_RULES = rulesFixture;
check('operator file adds its client rule', rules.loadRules({ clientWork: true }).length === 9,
  'got ' + rules.loadRules({ clientWork: true }).length);
check('client rule excluded by default', rules.loadRules({}).every(function (r) { return r.scope !== 'client'; }));
check('operator restatement replaces the seed rule of the same id',
  rules.loadRules({}).find(function (r) { return r.id === 'no-skip'; }).rule === 'restated by the operator');

// A malformed file must not take the critic offline.
fsR.writeFileSync(rulesFixture, 'not json at all');
check('malformed operator file falls back to the seed', rules.loadRules({}).length === 8,
  'got ' + rules.loadRules({}).length);

if (prevRulesEnv === undefined) delete process.env.TROTH_FIDELITY_RULES; else process.env.TROTH_FIDELITY_RULES = prevRulesEnv;
fsR.rmSync(rulesDir, { recursive: true, force: true });

// --- verdict logger ---
var flagged = { clean: false, violations: [{ rule_id: 'verify-evidence', evidence: 'claimed fixed without check', confidence: 0.85 }] };
var idF = cv.recordVerdict({ result: flagged, model_used: 'qwen3-max', cwd: CWD, session_id: 's1', turn_fingerprint: 'fp1' });
check('flagged verdict persisted (rowid)', !!idF, 'recordAction returned ' + idF + ' (STVC reject?)');

var idC = cv.recordVerdict({ result: { clean: true, violations: [] }, model_used: 'local', cwd: CWD, session_id: 's1' });
check('clean verdict persisted', !!idC);

var idS = cv.recordVerdict({ result: { clean: true, violations: [], skipped: 'no_judge' }, cwd: CWD, session_id: 's1' });
check('skipped verdict persisted', !!idS);

// a NON-critic decision row must NOT show up in getVerdicts
var other = actionRecord.create({ type: 'decision', agent_id: 'x', cwd: CWD, input: { kind: 'mode_detect' }, output: { decision: 'allow' } });
state.recordAction(other, actionRecord.toSearchText(other));

var got = cv.getVerdicts({ cwd: CWD });
check('getVerdicts returns 3 critic verdicts only', got.length === 3, 'got ' + got.length);
check('non-critic decision excluded', got.every(function (r) { return r.input.kind === 'critic_verdict'; }));

var warnRow = got.filter(function (r) { return r.output.decision === 'warn'; })[0];
check('flagged -> decision=warn', !!warnRow);
check('flagged carries rule_ids', warnRow && warnRow.input.rule_ids.indexOf('verify-evidence') >= 0);
check('flagged n_violations=1', warnRow && warnRow.output.n_violations === 1);
check('flagged confidence=0.85', warnRow && warnRow.output.confidence === 0.85);
check('clean -> decision=allow', got.some(function (r) { return r.output.decision === 'allow' && r.output.reason === 'clean'; }));
check('skip -> decision=skip', got.some(function (r) { return r.output.decision === 'skip'; }));
check('label starts null (for post-hoc FPR)', warnRow && warnRow.output.label === null);

// --- fail-open ---
var threw = false;
try { var n = cv.recordVerdict({}); check('empty opts => no throw, returns row or null', n === null || typeof n !== 'undefined'); }
catch (e) { threw = true; }
check('recordVerdict never throws', threw === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
