// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Shared "judge a turn and record the verdict + warn-lesson" routine, used by BOTH
// the detached CC worker and the in-process app entity. Provider-agnostic: pass a
// judge, or let it build the default router judge (cheap reasoning, cross-family).
// Never throws (fail-open). WARN-first: records, never blocks.
const critic = require('./fidelity-critic.js');
const rulesMod = require('./fidelity-rules.js');
const verdict = require('./critic-verdict.js');
const crypto = require('crypto');
let _state = null;
function state() { if (!_state) _state = require('./state.js'); return _state; }

// opts: { turnText, toolSequence, cwd, sessionId, producerModel, project, clientWork, judge? }
async function runAndRecord(opts) {
  opts = opts || {};
  try {
    const rules = rulesMod.loadRules({ cwd: opts.cwd, project: opts.project, clientWork: !!opts.clientWork });
    let judge = opts.judge;
    if (typeof judge !== 'function') {
      try {
        const router = require('../proxy/modules/router.js');
        judge = router.makeFidelityJudge({ producerModel: opts.producerModel || 'claude' });
      } catch (_) { judge = async function () { return null; }; }
    }
    const result = await critic.runFidelityCritic({
      turnText: opts.turnText, toolSequence: opts.toolSequence, rules: rules, judge: judge
    });
    const fp = crypto.createHash('sha1')
      .update('fidelity|' + String(opts.turnText || '').slice(0, 200)).digest('hex').slice(0, 12);
    try {
      verdict.recordVerdict({
        result: result, model_used: opts.producerModel || null,
        cwd: opts.cwd, session_id: opts.sessionId, turn_fingerprint: fp
      });
    } catch (_) {}
    if (result && !result.clean && Array.isArray(result.violations) && result.violations.length) {
      try {
        const msg = 'FIDELITY (working-style) WARNING from the previous turn: ' +
          result.violations.map(function (v) { return '[' + v.rule_id + '] ' + v.evidence; }).join('; ') +
          '. Follow these operator HOW-rules in the next response.';
        state().recordLesson(opts.sessionId || null, opts.cwd || process.cwd(), 'fidelity_warn', fp, msg);
      } catch (_) {}
    }
    return result;
  } catch (_) {
    return { clean: true, violations: [], skipped: 'error' };
  }
}
module.exports = { runAndRecord };
