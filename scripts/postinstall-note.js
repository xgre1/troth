#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Runs as npm `postinstall`. Prints the next step, because the step people
// actually skip is the one after the install: two first-day users on
// 2026-08-04 ran `npm ci` from a clone and then typed `troth setup` into
// "command not found" — the `npm link` line between them never happened.
// npm shows root-project script output, so this lands exactly where the
// eyes already are. Global installs hide it; those users have `troth` on
// PATH already and lose nothing.
'use strict';

console.log('');
console.log('troth is installed.');
console.log('');
console.log('  Next:  troth setup     (guided: engine, memory, routing — opens the dashboard)');
console.log('  Then:  troth           (talk to your partner)');
console.log('');
console.log('If `troth` is not found, you installed from a clone — the command is not');
console.log('on your PATH yet. Either run `sudo npm link` here, or skip the clone');
console.log('entirely with:  npm install -g github:xgre1/troth');
console.log('');
