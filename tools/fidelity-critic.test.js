// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fc = require(require('path').join(__dirname, '..', 'shared-core', 'fidelity-critic.js'));
let pass = 0, fail = 0;
function check(name, cond, msg) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (msg ? ' :: ' + msg : '')); }
}
const RULES = [
  { id: 'no-assume', rule: 'Never assume; verify with evidence before claiming.', bad: 'I assume X works.' },
  { id: 'no-fork', rule: 'Give a recommendation, not an A/B/C technical fork.' }
];
const IDS = RULES.map(function (r) { return r.id; });
(async function main() {
  const p = fc.buildVerdictPrompt(RULES, 'some assistant turn text here that is long enough', [{ name: 'Read', target: '/x.js' }]);
  check('prompt has rule id', p.indexOf('[no-assume]') >= 0);
  check('prompt has turn text', p.indexOf('some assistant turn text') >= 0);
  check('prompt has tool seq', p.indexOf('Read /x.js') >= 0);
  check('prompt has LGTM contract', p.indexOf('LGTM') >= 0);

  check('LGTM clean', fc.parseVerdict('LGTM', IDS).clean === true);
  var v1 = fc.parseVerdict('[no-assume] said "I assume the key is set" :: 0.9', IDS);
  check('violation parsed', v1.clean === false && v1.violations.length === 1 && v1.violations[0].rule_id === 'no-assume');
  check('confidence parsed', v1.violations[0].confidence === 0.9);
  check('missing conf default 0.6', fc.parseVerdict('[no-fork] gave option A/B/C', IDS).violations[0].confidence === 0.6);
  check('hallucinated rule dropped', fc.parseVerdict('[made-up] x :: 0.99', IDS).clean === true);
  check('think block stripped', fc.parseVerdict('<think>[no-assume] flag</think>\nLGTM', IDS).clean === true);
  check('null => clean', fc.parseVerdict(null, IDS).clean === true);

  var r;
  r = await fc.runFidelityCritic({ turnText: 'long enough turn text for the critic to consider properly', rules: RULES });
  check('no judge => skipped', r.skipped === 'no_judge' && r.clean === true);
  r = await fc.runFidelityCritic({ turnText: 'long enough turn text', rules: [], judge: function () { return Promise.resolve('LGTM'); } });
  check('no rules => skipped', r.skipped === 'no_rules');
  r = await fc.runFidelityCritic({ turnText: 'hi', rules: RULES, judge: function () { return Promise.resolve('LGTM'); } });
  check('too short => skipped', r.skipped === 'too_short');
  r = await fc.runFidelityCritic({ turnText: 'a sufficiently long assistant turn under review here', rules: RULES, judge: function () { return Promise.resolve('LGTM'); } });
  check('clean judge => clean', r.clean === true && !r.skipped);
  r = await fc.runFidelityCritic({ turnText: 'a sufficiently long assistant turn under review here', rules: RULES, judge: function () { return Promise.resolve('[no-assume] assumed the db schema :: 0.8'); } });
  check('violation judge => flagged', r.clean === false && r.violations.length === 1);
  r = await fc.runFidelityCritic({ turnText: 'a sufficiently long assistant turn under review here', rules: RULES, judge: function () { return Promise.resolve('[no-assume] weak signal :: 0.2'); } });
  check('low confidence filtered', r.clean === true);
  r = await fc.runFidelityCritic({ turnText: 'a sufficiently long assistant turn under review here', rules: RULES, judge: function () { throw new Error('boom'); } });
  check('judge throws => fail-open clean', r.clean === true && r.skipped === 'error');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
