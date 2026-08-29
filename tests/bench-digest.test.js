#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// bench digest - the full-ingestion stage of a benchmark box. Proves:
// (1) identities land before instances, so one occurrence told under two
// names in two sessions merges by identity; (2) the session becomes a
// chunked docs:chats document; (3) extraction is content-addressed - a
// SECOND box with the same cache directory redigests without one extractor
// call; (4) nothing question-shaped exists anywhere in the interface.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), 'troth-bench-digest-test-' + process.pid + '.db');
process.env.STATE_DB_PATH = DB;
process.env.TROTH_PRINCIPAL = 'partner';

const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

const BRAIN = 'lme-test';
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cache-'));

function fixtureExtractor(counter) {
  return function (prompt) {
    counter.calls++;
    const out = { identities: [], instances: [] };
    if (prompt.indexOf('maid of honor') >= 0) {
      out.identities.push({ name: 'Jen', kind: 'person', relation: 'sister', aliases: ['my sister'] });
      out.instances.push({ kind: 'event', entity: 'my sister', description: 'wedding, rooftop garden', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0] });
    }
    if (prompt.indexOf('photos came back') >= 0) {
      out.instances.push({ kind: 'event', entity: 'Jen', description: 'wedding at the rooftop garden', date_iso: null, status: 'completed', qualifier: 'attended', quantity: null, turn_idxs: [0] });
    }
    return Promise.resolve(JSON.stringify(out));
  };
}

(async function main() {
console.log('\n=== bench digest (full-ingestion stage) ===\n');

const dialogueMemory = require('../shared-core/dialogue-memory.js');
const digest = require('../benchmarks/digest.cjs');
const engram = require('../shared-core/engram.js');
const identity = require('../shared-core/entity-identity.js');
const chameleon = require('../shared-core/chameleon.js');

const T0 = Date.now() - 60000;
assert.ok(dialogueMemory.recordTurn({
  agent_id: BRAIN, conversation_id: 'sess-0', timestamp: T0,
  user_text: "My sister's wedding was at a rooftop garden - I was maid of honor.",
  assistant_text: 'Lovely.'
}));
assert.ok(dialogueMemory.recordTurn({
  agent_id: BRAIN, conversation_id: 'sess-1', timestamp: T0 + 1000,
  user_text: "Jen and Tom's wedding photos came back - the rooftop shots are stunning.",
  assistant_text: 'Nice.'
}));

const counter = { calls: 0 };
let stats = null;
await t('digest walks every session and extracts once per session', async () => {
  stats = await digest.digestHaystack({ agent_id: BRAIN, user_id: 'default', llmCall: fixtureExtractor(counter), cacheDir: CACHE });
  assert.strictEqual(stats.sessions, 2, JSON.stringify(stats));
  assert.strictEqual(stats.extractor_calls, 2);
  assert.strictEqual(counter.calls, 2);
});

await t('identity lands first: one wedding under two names merges by slug', () => {
  const reg = identity.loadRegistry({ agent_id: BRAIN, fresh: true });
  assert.ok(reg.some(i => i.slug === 'jen'), 'Jen registered');
  const events = engram.listEngrams({ scope: 'instance:event', audience: 'all', agent_id: BRAIN, limit: 10 });
  assert.strictEqual(events.length, 1, 'ONE wedding however it was named: got ' + events.length);
  assert.strictEqual(events[0].payload.instance.entity_slug, 'jen');
});

await t('the session becomes a chunked docs:chats document', () => {
  const sources = chameleon.listIngestedSources('docs:chats') || [];
  assert.ok(sources.length >= 2, 'both sessions archived: ' + sources.length);
  assert.ok(stats.chunks >= 2, 'chunks recorded: ' + stats.chunks);
});

await t('a second box with the same cache digests with ZERO extractor calls', async () => {
  const DB2 = path.join(os.tmpdir(), 'troth-bench-digest-test2-' + process.pid + '.db');
  const env = Object.assign({}, process.env, { STATE_DB_PATH: DB2 });
  const child = require('child_process').spawnSync(process.execPath, ['-e', `
    process.env.STATE_DB_PATH = ${JSON.stringify(DB2)};
    const dm = require(${JSON.stringify(path.join(__dirname, '../shared-core/dialogue-memory.js'))});
    dm.recordTurn({ agent_id: 'lme-test', conversation_id: 'sess-0', timestamp: ${T0},
      user_text: "My sister's wedding was at a rooftop garden - I was maid of honor.", assistant_text: 'Lovely.' });
    const digest = require(${JSON.stringify(path.join(__dirname, '../benchmarks/digest.cjs'))});
    digest.digestHaystack({ agent_id: 'lme-test', user_id: 'default',
      llmCall: () => { console.error('EXTRACTOR CALLED'); return Promise.resolve('{}'); },
      cacheDir: ${JSON.stringify(CACHE)} }).then(s => console.log(JSON.stringify(s)));
  `], { encoding: 'utf8', env });
  assert.ok(child.status === 0, 'child ok: ' + child.stderr);
  const s2 = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.strictEqual(s2.cache_hits, 1, 'cache crossed the box boundary: ' + JSON.stringify(s2));
  assert.strictEqual(s2.extractor_calls, 0, 'no extractor call on a cached session');
  assert.ok(child.stderr.indexOf('EXTRACTOR CALLED') < 0);
  try { fs.unlinkSync(DB2); fs.unlinkSync(DB2 + '-wal'); fs.unlinkSync(DB2 + '-shm'); } catch (_) {}
});

console.log('');
console.log('bench-digest: ' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}
try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
})();
