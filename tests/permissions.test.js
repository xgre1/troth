#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The operator's OK, kept by its scope: once answers one call, session this
// process, always lands in permissions.json under the substrate directory
// and holds afterwards. A command line names the road it asks for on
// walled ground, and a shape that is not a plain read names none.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
process.env.TROTH_CONFIG_DIR = path.join(dir, '.troth');
const perms = require(path.join(__dirname, '..', 'shared-core', 'tools', 'permissions.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== permissions ===\n');

t('a plain read of the machine names the process-inspect road, a pipeline included', () => {
  assert.strictEqual(perms.roadFor('ps -p 834 -o pid,etime,time,%cpu'), 'process-inspect');
  assert.strictEqual(perms.roadFor('ps -Ao pid,%cpu,comm -r | head -8'), 'process-inspect');
  assert.strictEqual(perms.roadFor('top -l 1 -o cpu -n 5 | tail -6 | awk "{print $1}"'), 'process-inspect');
  assert.strictEqual(perms.roadFor('lsof -nP -iTCP -sTCP:LISTEN | grep node'), 'process-inspect');
});

t('the unified log and a signal name their own roads', () => {
  assert.strictEqual(perms.roadFor('log show --last 1h --predicate \'process == "duetexpertd"\' --style compact | tail -30'), 'unified-log');
  assert.strictEqual(perms.roadFor('killall duetexpertd; sleep 20; ps -Ao pid,%cpu,time,comm -r | head -8'), 'signal');
  assert.strictEqual(perms.roadFor('kill -9 1234'), 'signal');
});

t('a shape that is not a plain read names no road', () => {
  assert.strictEqual(perms.roadFor('ps aux > /tmp/out.txt'), null);
  assert.strictEqual(perms.roadFor('ps aux; rm -rf ~/x'), null);
  assert.strictEqual(perms.roadFor('echo $(ps aux)'), null);
  assert.strictEqual(perms.roadFor('npm test'), null);
  assert.strictEqual(perms.roadFor('cat file.txt | grep x'), null);
  assert.strictEqual(perms.roadFor(''), null);
});

t('the answer the partner carries needs the operator\'s words, and a bare ack is a one-time OK', () => {
  assert.strictEqual(perms.parseAnswer(null).ok, false);
  assert.strictEqual(perms.parseAnswer({ scope: 'always' }).ok, false);
  const once = perms.parseAnswer({ words: 'ok run it' });
  assert.deepStrictEqual([once.ok, once.scope, once.words], [true, 'once', 'ok run it']);
  const ack = perms.parseAnswer(true);
  assert.deepStrictEqual([ack.ok, ack.scope], [true, 'once']);
  assert.strictEqual(perms.parseAnswer({ words: 'yes', scope: 'weekly' }).scope, 'once');
});

t('once is not kept, session holds in this process, always lands on disk with the words and the moment', () => {
  const key = perms.keyFor('ground', 'process-inspect');
  assert.strictEqual(perms.standing(key), null);
  perms.grant(key, { scope: 'once', words: 'ok' }, 'read processes');
  assert.strictEqual(perms.standing(key), null, 'once must not stand');
  perms.grant(key, { scope: 'session', words: 'ok for now' }, 'read processes');
  assert.strictEqual(perms.standing(key).scope, 'session');
  assert.strictEqual(fs.existsSync(perms.filePath()), false, 'a session OK never touches the disk');
  const key2 = perms.keyFor('danger', 'rm_rf');
  perms.grant(key2, { scope: 'always', words: 'yes, always for build folders' }, 'rm -rf');
  const onDisk = JSON.parse(fs.readFileSync(perms.filePath(), 'utf8')).permissions;
  assert.strictEqual(onDisk.length, 1);
  assert.strictEqual(onDisk[0].key, 'danger:rm_rf');
  assert.strictEqual(onDisk[0].words, 'yes, always for build folders');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(onDisk[0].at));
  const mode = fs.statSync(perms.filePath()).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'the file is the operator\'s own');
  perms._reset();
  assert.strictEqual(perms.standing(key), null, 'the session OK dies with the process');
  assert.strictEqual(perms.standing(key2).scope, 'always', 'always survives');
  perms.revoke(key2);
  assert.strictEqual(perms.standing(key2), null);
});

t('the words of a refusal name the key and how the OK travels', () => {
  const text = perms.needed('ground:unified-log', 'the unified log does not run inside a ground wall.', '');
  assert.ok(text.includes('ground:unified-log'));
  assert.ok(text.includes('permission: { words:'));
  assert.ok(text.includes('always'));
});

console.log('\nResults: ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
