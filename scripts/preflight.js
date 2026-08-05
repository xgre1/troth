#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Runs as npm `preinstall`. One job: refuse Node < 22 BEFORE anything
// installs, with the exact recovery commands printed.
//
// Why at install and not only at runtime: on a stock Ubuntu VM (Node 18)
// `npm ci` completes with nothing but EBADENGINE warnings — engines in
// package.json are advisory unless the user set engine-strict — and the
// failure then surfaces minutes later as `troth` refusing to start. Two
// real first-day users hit exactly that on 2026-08-04. Failing here turns
// a delayed mystery into an immediate instruction.
//
// Deliberately dependency-free and silent on success: this runs on every
// `npm ci` / `npm install -g`, including CI and the Docker clean-room.
'use strict';

var major = parseInt(process.versions.node.split('.')[0], 10);
if (major >= 22) process.exit(0);

console.error('');
console.error('troth needs Node.js >= 22 — this is v' + process.versions.node + '.');
console.error('');
console.error('Debian/Ubuntu (stock apt node is too old):');
console.error('  sudo apt-get install -y curl');
console.error('  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -');
console.error('  sudo apt-get install -y nodejs');
console.error('');
console.error('macOS:  brew install node');
console.error('');
console.error('Then run the install again.');
console.error('');
process.exit(1);
