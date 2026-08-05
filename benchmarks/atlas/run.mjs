#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Atlas roundtrip benchmark — Layer 4 of the substrate.
//
// Validates that a `troth atlas export` bundle can be imported into a
// completely fresh substrate and produce identical query results, plus
// that causal chains survive the trip (since parent_id is part of the
// ActionRecord schema, it's exported verbatim and must reconstruct).
//
// Also tests version-drift refusal: a bundle whose __atlas.version is
// not v0.1 must be rejected with a clear error, not silently imported.
//
// Usage:
//   node benchmarks/atlas/run.mjs
//
// Exits non-zero on any assertion failure.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

// Two isolated data dirs: source (we seed it) and dest (empty, receives import).
const T = Date.now();
const SRC_DIR  = '/tmp/gc-atlas-src-' + T;
const DEST_DIR = '/tmp/gc-atlas-dest-' + T;
const ATLAS    = '/tmp/gc-atlas-' + T + '.ndjson';
mkdirSync(SRC_DIR,  { recursive: true });
mkdirSync(DEST_DIR, { recursive: true });

let failed = 0;
function assert(cond, label) {
  const mark = cond ? '✓' : '✗';
  console.log('  ' + mark + ' ' + label);
  if (!cond) failed++;
}

// ── Phase 1: seed source substrate with a small causal chain ─────────────
console.log('[seed] populating source substrate at ' + SRC_DIR);

// Run the seeder as a subprocess so it picks up the isolated data dir
// cleanly and doesn't pollute the parent's require cache.
const seedScript = `
  process.env.CLAUDE_PLUGIN_DATA = '${SRC_DIR}';
  const state = require('${REPO}/shared-core/state.js');
  const AR    = require('${REPO}/shared-core/action-record.js');

  const CWD = '/repo/project-a';
  const SESS = 'atlas-src-' + Date.now();

  // root decision
  const root = AR.create({
    type: 'decision', agent_id: 'claude-code',
    session_id: SESS, cwd: CWD,
    input:  { kind: 'context_injection', project_type: 'node' },
    output: { decision: 'inject', reason: 'user_prompt_submit' }
  });
  state.recordAction(root, AR.toSearchText(root));

  // read child
  const rd = AR.create({
    type: 'read', agent_id: 'claude-code',
    session_id: SESS, cwd: CWD, parent_id: root.id,
    input:  { file_path: '/repo/project-a/src/index.js' },
    output: { hash: 'aa11bb22', line_count: 40 }
  });
  state.recordAction(rd, AR.toSearchText(rd));

  // edit grandchild (AST-verified so it's 'verified pass')
  const ed = AR.create({
    type: 'edit', agent_id: 'claude-code',
    session_id: SESS, cwd: CWD, parent_id: rd.id,
    input:  { file_path: '/repo/project-a/src/index.js', format: 'edit' },
    output: { hash_after: 'cc33dd44' },
    verification: { ast: { ok: true, skipped: false } }
  });
  state.recordAction(ed, AR.toSearchText(ed));

  console.log(JSON.stringify({ root: root.id, read: rd.id, edit: ed.id }));
`;
const seedOut = execFileSync('node', ['-e', seedScript], { encoding: 'utf8', env: process.env });
const seeded = JSON.parse(seedOut.trim().split('\n').pop());

// ── Phase 2: export via the CLI ──────────────────────────────────────────
console.log('[export] troth atlas export --out ' + ATLAS);
const troth = resolve(REPO, 'bin', 'troth.js');
execFileSync('node', [troth, 'atlas', 'export', '--out', ATLAS], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: SRC_DIR })
});
const atlasText = readFileSync(ATLAS, 'utf8');
const lines = atlasText.split(/\r?\n/).filter(l => l.trim());
console.log('[export] wrote ' + lines.length + ' lines');

// ── Phase 3: import into fresh dest substrate ────────────────────────────
console.log('[import] troth atlas import ' + ATLAS + ' → ' + DEST_DIR);
const importOutput = execFileSync('node', [troth, 'atlas', 'import', ATLAS], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: DEST_DIR })
});
console.log(importOutput.trim());

// ── Phase 4: roundtrip assertions ────────────────────────────────────────
console.log('[check] assertions:');

// Load state + causality modules pointed at the DEST dir in this process.
process.env.CLAUDE_PLUGIN_DATA = DEST_DIR;
delete require.cache[require.resolve(resolve(REPO, 'shared-core/state.js'))];
const destState = require(resolve(REPO, 'shared-core/state.js'));
const causality = require(resolve(REPO, 'shared-core/causality.js'));

// Reload source state for parity comparisons.
const srcState = (function () {
  const srcScript = `
    process.env.CLAUDE_PLUGIN_DATA = '${SRC_DIR}';
    const s = require('${REPO}/shared-core/state.js');
    const rows = s._dbForQuery().prepare('SELECT COUNT(*) AS n FROM action_records').get();
    console.log(JSON.stringify({ count: rows.n }));
  `;
  const out = execFileSync('node', ['-e', srcScript], { encoding: 'utf8', env: process.env });
  return JSON.parse(out.trim());
})();

// Same row count.
const destCount = destState._dbForQuery().prepare('SELECT COUNT(*) AS n FROM action_records').get().n;
assert(destCount === srcState.count,
  'dest substrate has same row count as source (src=' + srcState.count + ', dest=' + destCount + ')');

// Every seeded id is queryable in dest.
const rowRoot = destState.getAction(seeded.root);
const rowRead = destState.getAction(seeded.read);
const rowEdit = destState.getAction(seeded.edit);
assert(!!rowRoot && !!rowRead && !!rowEdit, 'all three seeded actions fetch-able via destState.getAction');

// Causal chain reconstructs end-to-end.
const chain = causality.traceCausalChain(destState, seeded.edit) || [];
const kinds = chain.map(n => (n.input && n.input.kind) || n.type);
assert(chain.length === 3, 'traceCausalChain returns 3 nodes in dest (got ' + chain.length + ')');
assert(kinds.includes('context_injection') && kinds.includes('read') && kinds.includes('edit'),
  'chain kinds include context_injection + read + edit (got ' + JSON.stringify(kinds) + ')');

// Verified-action query returns the edit.
const Q = require(resolve(REPO, 'shared-core/query.js'));
const verified = Q.getVerifiedActions(destState, { type: 'edit', cwd: '/repo/project-a', limit: 10 });
assert(verified.length === 1, 'getVerifiedActions surfaces the imported edit (got ' + verified.length + ')');
assert(verified[0].id === seeded.edit, 'surfaced edit id matches seeded id');

// ── Phase 5: version-drift refusal ───────────────────────────────────────
// Craft a bundle with an incompatible version header and confirm the
// importer refuses cleanly.
const badAtlas = '/tmp/gc-atlas-bad-' + T + '.ndjson';
writeFileSync(badAtlas,
  JSON.stringify({ __atlas: { version: '9.9', created_at: Date.now(), count: 0 } }) + '\n');
let badResult;
try {
  badResult = execFileSync('node', [troth, 'atlas', 'import', badAtlas], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: DEST_DIR })
  });
} catch (e) {
  // CLI may exit non-zero on incompatible version — both behaviors are fine
  // as long as NO records were imported. Capture output for inspection.
  badResult = (e.stdout || '') + (e.stderr || '');
}
assert(/incompatible_version|incompat|version/i.test(badResult),
  'version-drift bundle is refused with a clear error (output: ' + badResult.trim().slice(0, 120) + ')');

const destCountAfterBad = destState._dbForQuery().prepare('SELECT COUNT(*) AS n FROM action_records').get().n;
assert(destCountAfterBad === destCount,
  'incompatible-version import did not add any rows (before=' + destCount + ', after=' + destCountAfterBad + ')');

// ── Phase 6: import idempotence (skip conflict) ──────────────────────────
console.log('[idempotence] re-import same atlas with --conflict skip');
const reimport = execFileSync('node', [troth, 'atlas', 'import', ATLAS], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: DEST_DIR })
});
const destCountAfterRe = destState._dbForQuery().prepare('SELECT COUNT(*) AS n FROM action_records').get().n;
assert(destCountAfterRe === destCount,
  'idempotent re-import left row count unchanged (' + destCountAfterRe + ')');
assert(/skipped/i.test(reimport),
  'CLI reports conflict resolution (output mentions skipped)');

// ── Report ───────────────────────────────────────────────────────────────
console.log('\n[report]');
console.log('  src records       : ' + srcState.count);
console.log('  atlas lines       : ' + lines.length);
console.log('  dest records      : ' + destCount);
console.log('  chain length      : ' + chain.length);
console.log('  atlas file        : ' + ATLAS);
console.log('  src data dir      : ' + SRC_DIR);
console.log('  dest data dir     : ' + DEST_DIR);
console.log('  assertions        : ' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));

if (failed > 0) process.exit(1);
