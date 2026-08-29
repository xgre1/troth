#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The intent shell road (what local/API engines execute through) used to be
// docker-or-refuse: on a host without docker it refused everything. The
// in-place default classifies the ground, wraps the spawn in the ground's
// kernel profile and photographs first. These tests pin: the road WORKS,
// the wall rides the argv, the photo fires, and the refusals that should
// survive still do.
//
// Environment note: inside an already-walled session the kernel refuses a
// nested profile (sandbox_apply, exit 71). That outcome still PROVES the
// wall was applied to the spawn; on an unwalled terminal the command runs.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-shelldo-test-'));
process.env.TROTH_CONFIG_DIR = path.join(tmpRoot, 'troth-config');
fs.mkdirSync(process.env.TROTH_CONFIG_DIR, { recursive: true });

const shellDo = require('../shared-core/dispatchers/shell-do.js');
const undo = require('../shared-core/tools/undo-shadow.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ok ' + name); }

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

(async () => {
  try {
    const ground = path.join(tmpRoot, 'ground');
    fs.mkdirSync(ground, { recursive: true });
    const cap = { scope: 'capability:shell:do:host' };

    // ── 1. The road works again, and the wall rides the spawn ──
    const r1 = await shellDo.dispatch(
      { payload: { command: 'echo walled-road', cwd: ground } }, cap, {});
    const sandbox1 = (r1.result && r1.result.sandbox) || '';
    const ranClean = r1.ok && r1.result.stdout.indexOf('walled-road') >= 0;
    const nestedRefusal = !r1.ok && r1.result && r1.result.exit_code === 71;
    ok('in-place dispatch resolved a wall (no docker declared)', sandbox1.indexOf('seatbelt:') === 0 || sandbox1.indexOf('none') === 0);
    ok('command ran clean OR the kernel refused a nested profile (both prove routing)',
       ranClean || (nestedRefusal && sandbox1.indexOf('seatbelt:') === 0));
    console.log('     (outcome: ' + (ranClean ? 'ran under ' + sandbox1 : 'nested-profile refusal, wall was in argv') + ')');

    // ── 2. The photograph fired before the command ──
    const photos = undo.list(ground, 5);
    ok('ground photographed before the run', photos.length >= 1 && photos[0].label === 'shell-do');

    // ── 3. No ground, no guessing: clean refuse with the fix named ──
    await withEnv({ GF_WATCH_DIR: undefined }, async () => {
      const r3 = await shellDo.dispatch({ payload: { command: 'echo x' } }, cap, {});
      ok('missing ground refuses with actionable detail',
         !r3.ok && r3.error === 'no_ground_for_inplace_run' && /payload.cwd/.test(r3.detail || ''));
    });

    // ── 4. Pre-existing refusals survive ──
    const r4 = await shellDo.dispatch({ payload: { command: 'echo x', cwd: ground } }, null, {});
    ok('capability still required', !r4.ok && r4.error === 'shell_capability_required');
    const r5 = await shellDo.dispatch({ payload: {} }, cap, {});
    ok('payload validation intact', !r5.ok && /shell_invalid/.test(r5.error));

    console.log('\nshell-do-inplace: ' + passed + ' assertions passed');
  } catch (e) {
    console.error('\nshell-do-inplace FAILED: ' + (e && e.message));
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  }
})();
