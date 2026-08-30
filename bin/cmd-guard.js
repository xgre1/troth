// SPDX-License-Identifier: AGPL-3.0-only
// `troth guard` / `troth guarded` — the operator's road to the guarded
// publish destinations.
//
// A guarded destination is one where a push must wait for a named gate to be
// green. The list ships empty; arming an entry is the operator saying "this
// place gets a checklist" — and the partner then satisfies that checklist
// from its own hand (the run_gate tool), with no click in between.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command !== 'guard' && command !== 'guarded') return;

const pub = require('../shared-core/tools/publish-gate.js');

if (command === 'guarded') {
  const list = pub.loadGuarded();
  if (!list.length) {
    console.log('Nothing guarded. `troth guard <destination> --gate "<command>"` arms one,');
    console.log('e.g. troth guard github.com/owner/repo --gate "scripts/release-gate.sh repo"');
  } else {
    for (const g of list) {
      console.log(g.match + '  →  ' + g.gate + (g.note ? '   (' + g.note + ')' : ''));
    }
    console.log('List: ' + pub.guardedPath());
  }
  process.exit(0);
}

const rest = args.slice(1);
const removeIx = rest.indexOf('--remove');
if (removeIx !== -1) {
  const target = rest.filter((a) => !a.startsWith('-'))[0];
  if (!target) { console.error('Name the destination to disarm: troth guard --remove <match>'); process.exit(2); }
  const r = pub.removeGuard(target);
  console.log(r.removed ? 'Disarmed: ' + target : 'Nothing matched: ' + target);
  process.exit(0);
}

const gateIx = rest.indexOf('--gate');
const gate = gateIx !== -1 ? rest[gateIx + 1] : null;
const match = rest.filter((a, i) => !a.startsWith('-') && i !== gateIx + 1)[0];
if (!match || !gate) {
  console.error('Usage: troth guard <destination> --gate "<command>"');
  console.error('       troth guard --remove <destination>');
  console.error('       troth guarded');
  process.exit(2);
}
const r = pub.addGuard(match, gate);
if (!r.ok) { console.error('refused: ' + r.error); process.exit(1); }
console.log((r.updated ? 'Updated' : 'Armed') + ': ' + r.match + '  →  ' + r.gate);
console.log('A push there now waits on a green gate pass for the exact tree at HEAD.');
process.exit(0);
};
