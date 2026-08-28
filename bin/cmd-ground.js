// SPDX-License-Identifier: AGPL-3.0-only
// `troth open` / `troth close` / `troth opened` — the operator's own road to
// the ground registry.
//
// A folder the operator opens runs with their environment and their tools, so
// the entry that grants it is the one thing the partner must never write. It
// is a protected destination on every partner road; this command is the only
// writer, and it runs as the operator in the operator's own shell.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command !== 'open' && command !== 'close' && command !== 'opened') return;

const path = require('path');
const ground = require('../shared-core/tools/ground-policy.js');

function report(res, verb, quiet) {
  if (!res.ok) {
    console.error('Refused: ' + String(res.error || '').replace(/^refused:\s*/i, ''));
    process.exit(2);
  }
  if (quiet) return;
  console.log(res.path + (verb === 'open'
    ? (res.added ? ' is now opened ground.' : ' was already opened ground.')
    : (res.removed ? ' is no longer opened ground.' : ' was not opened ground.')));
}

if (command === 'opened') {
  const list = ground.openedFolders();
  if (!list.length) {
    console.log('No folders opened. Anything outside them still works — writes'
              + ' are scoped to the folder they happen in.');
    console.log('Registry: ' + ground.registryPath());
    process.exit(0);
  }
  for (const p of list) console.log(p);
  process.exit(0);
}

const targets = args.slice(1).filter((a) => !a.startsWith('-'));
if (!targets.length) targets.push(process.cwd());

for (const target of targets) {
  const abs = path.resolve(process.cwd(), target);
  report(command === 'open' ? ground.openFolder(abs) : ground.closeFolder(abs), command, false);
}
if (command === 'open') {
  console.log('Shell commands there now run with your own environment, minus'
            + ' partner project ground, the credential stores, and the files'
            + ' that decide what the partner may do.');
}
process.exit(0);
};
