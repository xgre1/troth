// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// S3 — Authority is signature-rooted and SINGLE-SOURCED.
//
// The anti-drift property: every surface must rank memory through ONE shared
// authority model, never a forked local copy. A forked map (the literal
// `const _AUTH_W = { operator_confirmed: 1.0,... }`) makes the partner rank
// its own memory differently depending on which surface asked.
//
// On the unlabeled default: an unlabeled engram pool is dominated by low-trust
// provenance (test/seed/deliberator/watcher), so weighting it 1.00 would lift
// that pool to operator tier. Unlabeled sits at the conservative
// regex_extracted floor until source-derived authority lands. This standard
// therefore does NOT pin a specific unlabeled weight — it pins the STRUCTURAL
// property: ONE authority model, no forked definitions.
//
// Check: no module outside shared-core/authority-weights.js DEFINES its own
// authority-weight map. The precise fork signature is a variable assignment to
// an object literal that maps the authority tiers to numbers — matched as
// `<name> = {... operator_confirmed: <num>... }`. References, imports, and
// comments do not match (we require the `= {` assignment form). The canonical
// module and this test file are excluded.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHARED = path.join(ROOT, 'shared-core');
const APP_DIRS = [
  SHARED,
  path.join(ROOT, 'proxy', 'modules'),
  path.join(ROOT, 'proxy'),
  path.join(ROOT, 'bin'),
];
const CANONICAL = path.join(SHARED, 'authority-weights.js');
const SELF = __filename;

// A forked recall-WEIGHT map DEFINITION: an assignment (`= {`) to an object
// literal that binds operator_confirmed to a DECIMAL weight (e.g. 1.0 / 0.30 —
// must contain a '.'). Matches the real fork pattern
// (`const _AUTH_W = { operator_confirmed: 1.0,... }`) but deliberately does
// NOT match engram.js's `TIER_RANK = { operator_confirmed: 4,... }`, which is a
// SEPARATE concept — integer supersede-ordering (who can override whom), not a
// recall weight. Integer-valued maps are excluded by requiring a decimal point.
const FORK_DEF_RE = /=\s*(?:Object\.freeze\(\s*)?\{[^}]*operator_confirmed\s*:\s*[0-9]*\.[0-9]/;

function listFiles(dir) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.(js|mjs)$/.test(e.name)) continue;
    out.push(path.join(dir, e.name));
  }
  return out;
}

// Strip /* */ block comments and // line comments so commented-out forks don't
// false-positive.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

module.exports = {
  id: 'S3',
  title: 'Authority signature-rooted + single-sourced (no forked weight maps)',
  expect: 'pass',
  owedBy: 'single-mind (single authority model DONE; source-derived backfill pending decision #4)',
  run() {
    const files = [];
    for (const d of APP_DIRS) files.push(...listFiles(d));
    const offenders = [];
    for (const f of files) {
      if (f === CANONICAL || f === SELF) continue;
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      if (FORK_DEF_RE.test(stripComments(src))) {
        offenders.push(path.relative(ROOT, f));
      }
    }
    // Sanity: the canonical module must actually export the map.
    let canonicalOk = false;
    try { canonicalOk = !!require(CANONICAL).AUTHORITY_WEIGHTS; } catch (_) {}
    if (!canonicalOk) {
      return { pass: false, detail: 'authority-weights.js does not export AUTHORITY_WEIGHTS' };
    }
    if (!offenders.length) {
      return { pass: true, detail: 'authority weights single-sourced in authority-weights.js; no forked definitions' };
    }
    return {
      pass: false,
      detail: 'forked authority-weight definition(s) outside authority-weights.js: ' + offenders.join(', ') +
              ' — import { authorityWeightOf } from shared-core/authority-weights.js instead',
    };
  },
};
