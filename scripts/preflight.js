#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Runs as npm `preinstall`. Two jobs: refuse Node < 22 BEFORE anything
// installs, with the exact recovery commands printed; and, on a plain
// `npm install` inside a git checkout, say that package-lock.json is
// tracked and how to pull cleanly if it changed.
//
// Why at install and not only at runtime: on a stock Ubuntu VM (Node 18)
// `npm ci` completes with nothing but EBADENGINE warnings — engines in
// package.json are advisory unless the user set engine-strict — and the
// failure then surfaces minutes later as `troth` refusing to start —
// exactly how first-day users hit it. Failing here turns
// a delayed mystery into an immediate instruction.
//
// Deliberately dependency-free and silent on `npm ci`: this runs on every
// `npm ci` / `npm install -g`, including CI and the Docker clean-room.
'use strict';

var fs = require('fs');
var path = require('path');

var major = parseInt(process.versions.node.split('.')[0], 10);
if (major >= 22) {
  // The lockfile is committed so `npm ci` installs exactly what it pins. A
  // plain `npm install` may rewrite it (another npm, another registry, an
  // added package), and the next `git pull` then stops on the local change.
  // Said once, at the moment it can still be avoided; a global or tarball
  // install has no checkout and stays silent.
  var root = process.env.INIT_CWD || process.cwd();
  var plainInstall = process.env.npm_command === 'install' && process.env.npm_config_global !== 'true';
  if (plainInstall && fs.existsSync(path.join(root, '.git')) && fs.existsSync(path.join(root, 'package-lock.json'))) {
    console.error('');
    console.error('troth: package-lock.json is tracked. `npm ci` keeps it as pinned; if this');
    console.error('install changed it, run `git checkout -- package-lock.json` before `git pull`.');
    console.error('');
  }
  process.exit(0);
}

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
