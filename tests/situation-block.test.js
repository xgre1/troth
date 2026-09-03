#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The situation block names the minute, never the millisecond, and rides at
// the tail of the turn context so the stable blocks before it keep their
// place in the server's cache.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sa = require(path.join(__dirname, '..', 'shared-core', 'situated-awareness.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== situation block ===\n');

t('the time is rendered to the minute', () => {
  const out = sa.renderForPrefix({ time: { iso_time: '2026-09-03T21:05:12.345Z', tz: 'Europe/Athens', day_of_week: 'Wednesday', hour_local: 0 } });
  assert.ok(/time: 2026-09-03T21:05Z Europe\/Athens/.test(out), out);
  assert.ok(!/12\.345/.test(out), 'no seconds or milliseconds');
});

t('the block rides after the dialogue window in the entity turn context (source pin)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'troth-entity.js'), 'utf8');
  const situ = src.indexOf("situationBlock = sa.renderForPrefix(snap)");
  const tail = src.indexOf("if (situationBlock) { lines.push(''); lines.push(situationBlock); }");
  const transcript = src.lastIndexOf('lines.push(transcript);', tail);
  assert.ok(situ > 0 && tail > 0, 'both sites present');
  assert.ok(transcript > 0 && transcript < tail, 'the situation is pushed after the transcript');
  assert.ok(!/lines\.push\(block\);\s*\n\s*lines\.push\(''\);\s*\n\s*}\s*\n\s*} catch \(_\) \{ \/\* situated awareness/.test(src), 'the block is no longer pushed at the head');
});

console.log('\nsituation-block: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
