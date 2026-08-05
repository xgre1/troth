// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The operator HOW-rules the fidelity critic enforces. Each rule is SCOPED so a
// client-specific rule never bleeds into another project. scope:
//   'global'        -> applies in every project
//   'project:<id>'  -> only when the active project matches
//   'client'        -> only on client-facing work (a coarse project bucket)
// The host calls loadRules({ cwd, project, clientWork }) to get the active set.
//
// The seed below is deliberately generic working practice. Rules about how YOUR
// work is presented to YOUR clients are yours, not a default every install
// inherits: an opinion about what to tell a customer is not something software
// should arrive already holding. Those live in ~/.troth/fidelity-rules.json
// (or the path in TROTH_FIDELITY_RULES) and merge over this seed by id.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const RULES = [
  { id: 'verify-evidence', scope: 'global',
    rule: 'Never state a claim or assumption without verifying it against data, tests, or the live system first.',
    bad: 'Saying "this is fixed" or "X works" without showing the check.' },
  { id: 'recommend-not-fork', scope: 'global',
    rule: 'End with a clear recommendation plus the next action. Do NOT present an A/B/C technical fork for the operator to resolve.',
    bad: 'Asking "do you want option A, B, or C?" instead of recommending one.' },
  { id: 'no-downscope', scope: 'global',
    rule: 'When the operator states an ambitious target, execute toward it. Never counter-propose a smaller scope.' },
  { id: 'no-skip', scope: 'global',
    rule: 'Finish every planned item. Do not silently drop or defer scope.' },
  { id: 'ready-to-paste', scope: 'global',
    rule: 'Deliver copy or messages as one complete copy-paste block. No "[paste X here]" placeholders that force manual assembly.' },
  { id: 'no-flipflop', scope: 'global',
    rule: 'Hold the thesis steady across turns. Integrate new info with a reasoning trail; do not reverse a locked foundation mid-session.' },
  { id: 'no-fabrication', scope: 'global',
    rule: 'Never cite unverified or fabricated third-party validation.' },
  { id: 'read-literally', scope: 'global',
    rule: 'Read the operator terse messages literally; negation words flip meaning. If two opposite readings are plausible, ask.' }
];

function operatorRulesPath() {
  const override = String(process.env.TROTH_FIDELITY_RULES || '').trim();
  return override || path.join(os.homedir(), '.troth', 'fidelity-rules.json');
}

// Accepts either a bare array or { rules: [...] }. A rule needs an id and a
// rule string; anything else in the file is ignored. A missing or malformed
// file yields no rules rather than an exception: a broken preference file must
// never take the critic offline, and the seed alone is a safe floor.
function operatorRules() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(operatorRulesPath(), 'utf8')); }
  catch (_) { return []; }
  const list = Array.isArray(parsed) ? parsed
             : (parsed && Array.isArray(parsed.rules) ? parsed.rules : []);
  const out = [];
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || typeof r.rule !== 'string') continue;
    const rule = { id: r.id, scope: typeof r.scope === 'string' ? r.scope : 'global', rule: r.rule };
    if (typeof r.bad === 'string') rule.bad = r.bad;
    out.push(rule);
  }
  return out;
}

// Seed first, operator second, merged by id: a local file can add a rule,
// restate one, or retire one by giving it an empty rule string.
function allRules() {
  const byId = new Map();
  for (const r of RULES) byId.set(r.id, r);
  for (const r of operatorRules()) byId.set(r.id, r);
  return Array.from(byId.values()).filter(function (r) { return r.rule; });
}

function loadRules(opts) {
  opts = opts || {};
  const clientWork = !!opts.clientWork;
  const project = opts.project || null;
  return allRules().filter(function (r) {
    if (r.scope === 'global') return true;
    if (r.scope === 'client') return clientWork;
    if (r.scope.indexOf('project:') === 0) return !!project && ('project:' + project) === r.scope;
    return false;
  });
}

module.exports = { RULES, loadRules, allRules, operatorRules, operatorRulesPath };
