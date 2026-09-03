#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The reranker gives every document a verdict even when one of them is longer
// than the server's batch: documents are cut to a budget, and a batch the
// server still calls too large is asked again shorter.
const assert = require('assert');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== reranker: a long document costs no verdict ===\n');

const LIMIT = 500;
const seen = [];
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    const j = JSON.parse(b || '{}');
    seen.push(j.documents.map((d) => d.length));
    if (j.documents.some((d) => d.length > LIMIT)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 500, message: 'input (' + LIMIT + ' tokens) is too large to process. increase the physical batch size (current batch size: 512)', type: 'server_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: j.documents.map((d, i) => ({ index: i, relevance_score: /proxy/.test(d) ? 1.5 : -4 })) }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TROTH_RERANK_PORT = String(server.address().port);
  process.env.TROTH_NO_MODEL_FETCH = '1';
  const lr = require(path.join(__dirname, '..', 'shared-core', 'local-reranker.js'));

  await t('every document gets a score when one of them exceeds the batch', async () => {
    const long = 'the proxy was restarted at noon. ' + 'x'.repeat(2500);
    const scores = await lr.rerank('when was the proxy restarted', [long, 'apples are red']);
    assert.ok(Array.isArray(scores), 'scores came back: ' + JSON.stringify(scores));
    assert.strictEqual(scores.length, 2);
    assert.ok(scores[0] > scores[1], 'the long document that answers scores above the one that does not');
    assert.ok(seen.length >= 2, 'the batch was asked again shorter: ' + JSON.stringify(seen));
    assert.ok(seen[seen.length - 1].every((n) => n <= LIMIT), 'the last batch fit the server: ' + JSON.stringify(seen));
  });

  await t('a batch that fits is asked once', async () => {
    const before = seen.length;
    const scores = await lr.rerank('q', ['short one', 'short two']);
    assert.deepStrictEqual(scores.map((s) => typeof s), ['number', 'number']);
    assert.strictEqual(seen.length, before + 1);
  });

  server.close();
  console.log('\nreranker-doc-cap: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
