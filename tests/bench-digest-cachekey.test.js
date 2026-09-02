#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// bench digest, the cache key: the extractor prompt dates every turn so the
// words' relative days resolve, which makes the day part of what is
// extracted. The same session said on another day is another extraction;
// the same session on the same day is one. And the v1.1 prompt names the
// open obligation status the parser and the view already know.
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  ✓ ' + name); pass++; })
    .catch(e => { console.log('  ✗ ' + name + ': ' + e.message); fail++; });
}

console.log('\n=== bench digest, cache key ===\n');

const digest = require('../benchmarks/digest.cjs');
const ic = require('../shared-core/instance-consolidation.js');
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-key-'));
const DAY = 86400000;
const feb5 = Date.UTC(2023, 1, 5, 18, 29);
const may30 = Date.UTC(2023, 4, 30, 14, 55);
const text = 'I just helped my friend prepare a nursery today, and we spent the afternoon at Buy Buy Baby.';
const turnsOn = (ts) => [{ id: 'x', timestamp: ts, session_id: 's', user_text: text }];

(async () => {
  await t('the same words on two days are two extractions; the same day is one', async () => {
    const counter = { calls: 0 };
    const llmCall = async (prompt) => {
      counter.calls++;
      const day = /\((\d{4}-\d{2}-\d{2})\)/.exec(prompt);
      return JSON.stringify({ identities: [], instances: [{ kind: 'activity', entity: 'my friend', description: 'Helped friend prepare a nursery', date_iso: day ? day[1] : null, status: 'completed', qualifier: 'helped', quantity: null, turn_idxs: [0] }] });
    };
    const a = await digest.extractSession({ turns: turnsOn(feb5), llmCall, cacheDir: CACHE });
    const b = await digest.extractSession({ turns: turnsOn(may30), llmCall, cacheDir: CACHE });
    const c = await digest.extractSession({ turns: turnsOn(feb5 + 3600000), llmCall, cacheDir: CACHE });
    assert.strictEqual(counter.calls, 2, 'two days, two extractor calls; the same day again is a cache hit');
    assert.strictEqual(a.parsed.instances[0].date_iso, '2023-02-05');
    assert.strictEqual(b.parsed.instances[0].date_iso, '2023-05-30');
    assert.strictEqual(c.stats.cache_hit, true);
    assert.strictEqual(c.parsed.instances[0].date_iso, '2023-02-05', 'the cached day is the day the words were said');
    assert.strictEqual(fs.readdirSync(CACHE).length, 2);
  });

  await t('the extraction prompt names the open obligation status', () => {
    const p = ic.buildCombinedPrompt(turnsOn(feb5));
    assert.ok(/status: completed \| planned \| recurring \| cancelled \| owed/.test(p), 'owed is in the status list');
    assert.ok(/still to pick up, still to return/.test(p), 'owed is defined by what it means');
    assert.ok(/combined-v(?:1\.[1-9]|[2-9])/.test(digest.PROMPT_VERSION), 'the prompt version moved with the prompt: ' + digest.PROMPT_VERSION);
  });

  console.log('\nbench-digest-cachekey: ' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
