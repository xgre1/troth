// SPDX-License-Identifier: AGPL-3.0-only
// Test harness extracted verbatim from tests/test-all.js (behavior identical).
let passed = 0;
let failed = 0;

// Autonomous (L4) features are not part of the public engine. Skip any test
// whose name advertises an L4 ID so the public suite stays green while the
// private repo keeps the deeper coverage.
const PUBLIC_SKIP_PREFIXES = (process.env.TROTH_RUN_L4==='1') ? [] : ['L4-'];
let skipped = 0;
const SKIP = Symbol.for('troth.test.skip');
// Thrown by skip(); caught by test() and flushAsyncTests().
function skip(reason) {
  const e = new Error('skipped: ' + (reason || 'not runnable here'));
  e[SKIP] = true;
  e.skipReason = reason || 'not runnable here';
  throw e;
}

function test(name, fn) {
  if (PUBLIC_SKIP_PREFIXES.some((p) => name.startsWith(p))) {
    // Autonomy-layer tests cover the closed overlay and cannot run here.
    // Counted and REPORTED as skipped: a skip that prints as a pass would
    // inflate the suite's headline number, and the number is a claim.
    skipped++;
    return;
  }
  // Async bodies are queued UNSTARTED and run one at a time by
  // flushAsyncTests. Until  fn ran here, at require time, so
  // every async body across every suite was in flight at once and only the
  // awaiting was serial. Three tests leaned on that overlap without knowing
  // it (TOO-40 raced a require.cache wipe, E2E-1 and E2E-CONC-4 spawned
  // daemons before other suites moved HOME); each now pins what it needs
  // explicitly, so the runner can be what its name always claimed.
  if (typeof fn === 'function' && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    testQueue.push({ name, fn });
    return;
  }

  // A test that cannot run here has to be able to say so. Three bodies used to
  // print "(skip: ... closed overlay)" and then return, which the harness read
  // as success, so the headline counted them among the passes. `skip(reason)`
  // throws a marker this runner recognises; anything else thrown is still a
  // failure.

  try {
    const maybePromise = fn();
    if (maybePromise && typeof maybePromise.then === 'function') {
      // A plain function that returns a promise has already started; queue
      // the awaiting so its result still reports in declaration order.
      maybePromise.catch(() => {});
      testQueue.push({ name, promise: maybePromise });
    } else {
      console.log('  \u2713 ' + name);
      passed++;
    }
  } catch (e) {
    if (e && e[SKIP]) {
      console.log('  \u25cb ' + name + ' (' + e.skipReason + ')');
      skipped++;
      return;
    }
    console.log('  \u2717 ' + name + ': ' + e.message);
    failed++;
  }
}

// Serial async test runner. Tests that return promises push here; flushed at
// the end so failures print in declaration order.
const testQueue = [];
async function flushAsyncTests() {
  while (testQueue.length) {
    const { name, promise, fn } = testQueue.shift();
    try {
      await (fn ? fn() : promise);
      console.log('  \u2713 ' + name);
      passed++;
    } catch (e) {
      if (e && e[SKIP]) {
        console.log('  \u25cb ' + name + ' (' + e.skipReason + ')');
        skipped++;
        continue;
      }
      console.log('  \u2717 ' + name + ': ' + e.message);
      failed++;
    }
  }
}

module.exports = { test, skip, flushAsyncTests, counts: () => ({ passed, failed, skipped }) };
