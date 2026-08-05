// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Fast self-service smoke runner. `npm run smoke`.
//
// Auto-discovers every tests/smoke/*.smoke.js, each exporting an async run(t)
// that registers checks via `await t(name, fn)`. All run against a HERMETIC temp
// substrate (real modules, real DB, never the operator's data). This is the
// standard "did I break anything" check: seconds, real, extensible (a new
// feature = drop one *.smoke.js file). Add checks here, not throwaway /tmp stubs.
require('../hermetic-db.js'); // MUST be first: isolate temp HOME/.troth
const fs = require('fs'), path = require('path');

const res = { pass: 0, fail: 0 };
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); res.pass++; }
  catch (e) { console.log('  ✗ ' + name + ' :: ' + ((e && e.message) || e)); res.fail++; }
}

(async () => {
  const dir = __dirname;
  const only = process.argv[2]; // optional filter substring
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.smoke.js'))
    .filter(f => !only || f.indexOf(only) !== -1)
    .sort();
  if (!files.length) { console.log('no *.smoke.js found' + (only ? ' matching ' + only : '')); process.exit(0); }
  for (const f of files) {
    console.log('\n[' + f.replace('.smoke.js', '') + ']');
    let run;
    try { const m = require(path.join(dir, f)); run = (typeof m === 'function') ? m : m.run; }
    catch (e) { console.log('  ✗ load ' + f + ' :: ' + e.message); res.fail++; continue; }
    if (typeof run !== 'function') { console.log('  (no run() export)'); continue; }
    try { await run(t); } catch (e) { console.log('  ✗ run ' + f + ' threw :: ' + e.message); res.fail++; }
  }
  console.log('\n' + res.pass + ' passed, ' + res.fail + ' failed');
  process.exit(res.fail ? 1 : 0);
})();
