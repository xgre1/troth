#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// The reasoning switch reaches every local server: the request carries
// enable_thinking at the top level and under chat_template_kwargs, and the
// served_by fact says whether reasoning actually came back. The router road
// sends the switch on instead of a hard-coded off.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const REPO = path.join(__dirname, '..');
const { makeLlamaCppTransport } = require(path.join(REPO, 'shared-core', 'transports', 'llamacpp.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

// A fake local server: records the request body and streams a reply, with
// or without reasoning deltas.
function fakeServer(withReasoning) {
  const seen = { body: null };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { seen.body = JSON.parse(b); } catch (_) { seen.body = null; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (withReasoning) send({ model: 'm', choices: [{ delta: { reasoning_content: 'let me think' }, finish_reason: null }] });
      send({ model: 'm', choices: [{ delta: { content: 'hello' }, finish_reason: null }] });
      send({ model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, host: 'http://127.0.0.1:' + srv.address().port })));
}

async function runOnce(withReasoning, options) {
  const { srv, seen, host } = await fakeServer(withReasoning);
  try {
    const tx = makeLlamaCppTransport({ host, model: 'm' });
    const served = []; let text = '';
    for await (const ev of await tx.stream({ system: 'sys', user: 'hi', options: options || {} })) {
      if (ev && ev.served_by) served.push(ev.served_by);
      if (ev && ev.delta) text += ev.delta;
      if (ev && ev.done) break;
    }
    return { body: seen.body, served, text };
  } finally { srv.close(); }
}

console.log('\n=== the reasoning switch on the local road ===\n');

(async () => {
  await t('the request carries the switch on, at the top level and under chat_template_kwargs', async () => {
    const r = await runOnce(false);
    assert.ok(r.body, 'the body reached the server');
    assert.strictEqual(r.body.enable_thinking, true);
    assert.ok(r.body.chat_template_kwargs && r.body.chat_template_kwargs.enable_thinking === true, JSON.stringify(r.body.chat_template_kwargs));
    assert.strictEqual(r.text, 'hello');
  });

  await t('the switch off travels the same way', async () => {
    const r = await runOnce(false, { enable_thinking: false });
    assert.strictEqual(r.body.enable_thinking, false);
    assert.strictEqual(r.body.chat_template_kwargs.enable_thinking, false);
  });

  await t('served_by says reasoning false when none came back', async () => {
    const r = await runOnce(false);
    assert.ok(r.served.length >= 1, 'served_by was said');
    assert.strictEqual(r.served[r.served.length - 1].reasoning, false);
  });

  await t('served_by says reasoning true once reasoning arrives', async () => {
    const r = await runOnce(true);
    assert.strictEqual(r.served[r.served.length - 1].reasoning, true);
    assert.strictEqual(r.text, 'hello', 'the reasoning never leaks into the text');
  });

  await t('the router road sends the switch on instead of a hard-coded off (source pin)', async () => {
    const src = fs.readFileSync(path.join(REPO, 'shared-core', 'transports', 'router.js'), 'utf8');
    assert.ok(!/^\s*think:\s*false,?\s*$/m.test(src), 'no hard-coded think: false in the body');
    assert.ok(/enable_thinking:\s*!\(req\.options && req\.options\.enable_thinking === false\)/.test(src), 'the switch follows the caller');
  });

  console.log('\nllamacpp-thinking-switch: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
