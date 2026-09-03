#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A conversation keeps one llama.cpp slot across its calls, so the server
// finds the conversation's KV cache where it left it.
const assert = require('assert');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== llama.cpp slot per conversation ===\n');

const seen = [];
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/props') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ total_slots: 4, default_generation_settings: { n_ctx: 8192 } })); return; }
    if (req.url === '/tokenize') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"tokens":[]}'); return; }
    let j = {}; try { j = JSON.parse(b || '{}'); } catch (_) {}
    seen.push(j);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

async function drain(it) {
  if (it && typeof it.next === 'function' && !it[Symbol.asyncIterator]) { for (let i = 0; i < 50; i++) { const ev = await it.next(); if (!ev || ev.done) break; } return; }
  for await (const _ of it) { /* consume */ }
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = 'http://127.0.0.1:' + server.address().port;
  const { makeLlamaCppTransport } = require(path.join(__dirname, '..', 'shared-core', 'transports', 'llamacpp.js'));
  const tr = makeLlamaCppTransport({ host, model: 'test' });
  const call = (options) => drain(tr.stream({ system: 's', user: 'u', options }));

  await t('the same conversation lands on the same slot, another conversation may not', async () => {
    await call({ conversation_id: 'pane-a' });
    await call({ conversation_id: 'pane-a' });
    await call({ conversation_id: 'pane-b' });
    assert.strictEqual(seen.length, 3, 'three calls reached the server');
    for (const j of seen) assert.ok(Number.isInteger(j.id_slot) && j.id_slot >= 0 && j.id_slot < 4, 'a slot within the server\'s count: ' + j.id_slot);
    assert.strictEqual(seen[0].id_slot, seen[1].id_slot, 'one conversation, one slot');
    assert.strictEqual(seen[0].cache_prompt, true, 'the cache is asked for');
  });

  await t('an explicit slot wins', async () => {
    await call({ conversation_id: 'pane-a', slot_id: 3 });
    assert.strictEqual(seen[seen.length - 1].id_slot, 3);
  });

  server.close();
  console.log('\nllamacpp-slot: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
