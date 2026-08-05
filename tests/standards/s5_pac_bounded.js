// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// S5 — Self-modification is PAC-bounded. No self/faculty write may hot-patch
// the STVC predicate set (the statistically-unrecoverable trap,
// the design work). The registry is registerable
// at boot but SEALED before the cognitive loop; after seal it is frozen and
// registration throws. This verifies the guarantee, not the load-time state.
const path = require('path');

module.exports = {
  id: 'S5',
  title: 'Self-modification PAC-bounded (predicate set sealable + immutable)',
  expect: 'pass',
  owedBy: 'the seal mechanism',
  run() {
    // Load a FRESH copy so sealing here cannot leak into other checks.
    const file = path.join(__dirname, '..', '..', 'shared-core', 'state-machine.js');
    delete require.cache[require.resolve(file)];
    let sm;
    try { sm = require(file); } catch (e) { return { pass: false, detail: 'cannot load state-machine.js: ' + e.message }; }

    if (typeof sm.sealPredicateKinds !== 'function') {
      return { pass: false, detail: 'no sealPredicateKinds() — predicate set cannot be made immutable' };
    }
    if (!sm.PREDICATE_KINDS || typeof sm.PREDICATE_KINDS !== 'object') {
      return { pass: false, detail: 'PREDICATE_KINDS not exported' };
    }
    sm.sealPredicateKinds();
    if (!Object.isFrozen(sm.PREDICATE_KINDS)) {
      return { pass: false, detail: 'after seal, PREDICATE_KINDS is not frozen' };
    }
    // Post-seal registration must be refused.
    let refused = false;
    try { sm.registerPredicateKind('__s5_probe__', () => null); }
    catch (_) { refused = true; }
    if (!refused) return { pass: false, detail: 'registerPredicateKind succeeded AFTER seal — predicate set is mutable in-loop' };
    // Clean the fresh module from cache so a later require gets an unsealed one.
    delete require.cache[require.resolve(file)];
    return { pass: true, detail: 'predicate set seals to frozen + post-seal registration refused' };
  },
};
