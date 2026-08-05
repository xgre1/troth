// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// FPR / calibration harness for the fidelity critic. Reads logged verdicts from the
// substrate and reports decision breakdown + flag-rate per rule + recent flagged
// evidence, so precision can be MEASURED before granting any block authority.
// A rule firing on a large fraction of turns is a calibration smell.
//
// Usage: node tools/fidelity-fpr.js [days=7] [cwd]
const ROOT = require('path').resolve(__dirname, '..');
const cv = require(ROOT + '/shared-core/critic-verdict.js');

(function main() {
  const days = parseFloat(process.argv[2] || '7');
  const cwd = process.argv[3] || null;
  const since = Date.now() - days * 24 * 3600 * 1000;
  const opts = { since: since, limit: 1000 };
  if (cwd) opts.cwd = cwd;
  const verdicts = cv.getVerdicts(opts);

  console.log('=== Fidelity critic verdicts (last ' + days + 'd' + (cwd ? ', cwd=' + cwd : '') + ') ===');
  console.log('total logged:', verdicts.length);
  if (!verdicts.length) {
    console.log('(none yet — critic has not run, or no turns judged in this window)');
    return;
  }
  const by = { warn: 0, allow: 0, skip: 0, other: 0 };
  const perRule = {};
  verdicts.forEach(function (v) {
    const d = (v.output && v.output.decision) || 'other';
    if (by[d] === undefined) by.other++; else by[d]++;
    const sig = (v.input && v.input.signals) || [];
    sig.forEach(function (s) {
      const r = s.rule_id || '?';
      if (!perRule[r]) perRule[r] = { flags: 0, examples: [] };
      perRule[r].flags++;
      if (perRule[r].examples.length < 2 && s.evidence) perRule[r].examples.push(s.evidence);
    });
  });
  const ran = by.warn + by.allow;   // non-skip judgments
  console.log('decisions: warn=' + by.warn + '  allow=' + by.allow + '  skip=' + by.skip + (by.other ? '  other=' + by.other : ''));
  console.log('judged (non-skip):', ran);
  console.log('\n=== per-rule flag rate (flags / judged) — high rate = calibration smell ===');
  Object.keys(perRule).sort(function (a, b) { return perRule[b].flags - perRule[a].flags; }).forEach(function (r) {
    const f = perRule[r].flags;
    const rate = ran ? (100 * f / ran).toFixed(0) + '%' : 'n/a';
    console.log('  ' + r.padEnd(22) + 'flags=' + String(f).padEnd(4) + 'rate=' + rate);
    perRule[r].examples.forEach(function (e) { console.log('       e.g. ' + String(e).slice(0, 90)); });
  });
  console.log('\n=== last 5 flagged turns ===');
  verdicts.filter(function (v) { return (v.output && v.output.decision) === 'warn'; }).slice(0, 5).forEach(function (v) {
    console.log('  ' + new Date(v.timestamp).toISOString() + '  [' + ((v.input && v.input.rule_ids) || []).join(',') + ']  conf=' + (v.output && v.output.confidence));
  });
  console.log('\nNote: labels are unset (append-only store); flag-rate is the proxy for FPR until manual labeling lands.');
})();
