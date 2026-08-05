#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Chat stays responsive while body-seed boots.
// Acceptance criterion: 'chat stays responsive while the body-seed
// boots.' Translation in the control-channel layer: a slow scope handler
// (e.g. a body-seed warmup) MUST NOT block a concurrent fast scope (the
// operator's control:chat). The control channel uses http.createServer,
// and each dispatch is awaited independently, so concurrency is a free
// property of the existing wiring — this test pins it as acceptance.
//
// Hermetic: spins up a real listener on an ephemeral port + a fresh
// Ed25519 operator key, sends two SIGNED envelopes (slow + fast), and
// asserts fast finishes WELL before slow.

const assert = require('assert');
const crypto = require('crypto');
const http   = require('http');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const controlChannel =
  require(path.join(PROJECT_ROOT, 'shared-core', 'control-channel.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log('  \u2713 ' + name); pass++; },
          (e) => { console.log('  \u2717 ' + name + ': ' + e.message); fail++; });
}

// Generate a fresh ed25519 operator key for this test only.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB_RAW = publicKey.export({ format: 'der', type: 'spki' }).slice(-32); // last 32B = raw key
const PUB_B64 = PUB_RAW.toString('base64');
const PUB_ID  = 'gck-test-' + crypto.createHash('sha256').update(PUB_RAW).digest('hex').slice(0, 16);

// Canonical-JSON identical to control-channel.js:_canonical.
function canonical(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

// ts and nonce are part of what gets signed, and the channel refuses an
// envelope without them (its freshness and replay guard, added after this test
// was written, which is why the whole file had been failing 3/3 with "stale or
// missing timestamp"). A real client stamps both; so does this one.
function signEnvelope(engram) {
  const stamped = Object.assign({}, engram, {
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex')
  });
  const canon = canonical(stamped);
  const sig = crypto.sign(null, Buffer.from(canon, 'utf8'), privateKey);
  return { engram: stamped, signature: sig.toString('base64'), operator_pubkey_id: PUB_ID };
}

function postEnvelope(port, envelope) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(envelope);
    const req = http.request({
      method: 'POST', host: '127.0.0.1', port, path: '/',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks, t_end: Date.now() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

console.log('\n=== control-channel concurrency: chat during body-seed boot ===\n');

(async () => {
  // Two handlers: slow_boot (simulates body-seed warmup) and fast_chat
  // (the operator's chat). Server returns the result of each.
  let slowStarted = null, slowEnded = null, fastStarted = null, fastEnded = null;
  const handlers = {
    'control:slow_boot': async () => {
      slowStarted = Date.now();
      await new Promise((r) => setTimeout(r, 500));
      slowEnded = Date.now();
      return { ok: true, simulated: 'body-seed warmup', took_ms: 500 };
    },
    'control:fast_chat': async () => {
      fastStarted = Date.now();
      fastEnded = Date.now();
      return { ok: true, reply: 'chat handled' };
    }
  };

  // controlChannel.start treats 0 as falsy → falls through to PORT_DEFAULT.
  // Pick a high random port in the dynamic range to keep this hermetic.
  function pickPort() { return 40000 + Math.floor(Math.random() * 10000); }
  const { server, port } = await controlChannel.start({
    port: pickPort(),
    operator_pubkey_b64: PUB_B64,
    operator_pubkey_id:  PUB_ID,
    handlers,
    audit: () => {}
  });

  try {
    await t('fast chat completes WHILE slow boot is in flight (not blocked)', async () => {
      const tStart = Date.now();
      // Kick off the slow boot — do NOT await; the substrate is busy.
      const slowP = postEnvelope(port, signEnvelope({
        scope: 'control:slow_boot', payload: {}
      }));
      // Tiny gap so the slow handler has actually entered the await.
      await new Promise((r) => setTimeout(r, 20));
      // Now operator chats. This MUST complete promptly.
      const fastResp = await postEnvelope(port, signEnvelope({
        scope: 'control:fast_chat', payload: { text: 'are you there?' }
      }));
      const fastLatency = fastResp.t_end - tStart;
      assert.strictEqual(fastResp.status, 200,
        'fast_chat returned: ' + fastResp.status + ' ' + fastResp.body);
      const fastJson = JSON.parse(fastResp.body);
      assert.strictEqual(fastJson.ok, true);
      assert.strictEqual(fastJson.result.reply, 'chat handled');

      // Acceptance: chat returned BEFORE the slow boot completed.
      const slowResp = await slowP;
      assert.strictEqual(slowResp.status, 200);
      assert.ok(fastEnded < slowEnded,
        'fast_chat must finish BEFORE slow_boot — fastEnded=' + fastEnded +
        ' slowEnded=' + slowEnded);
      // And the operator-perceived chat latency stays bounded (well under
      // the 500ms slow handler — give plenty of margin for CI noise).
      assert.ok(fastLatency < 250,
        'chat latency too high: ' + fastLatency + 'ms (slow handler is 500ms)');
    });

    await t('two slow handlers run in parallel (independent dispatch)', async () => {
      slowStarted = null; slowEnded = null;
      const a = postEnvelope(port, signEnvelope({ scope: 'control:slow_boot', payload: { tag: 'a' } }));
      const b = postEnvelope(port, signEnvelope({ scope: 'control:slow_boot', payload: { tag: 'b' } }));
      const start = Date.now();
      const [ra, rb] = await Promise.all([a, b]);
      const wall = Date.now() - start;
      assert.strictEqual(ra.status, 200);
      assert.strictEqual(rb.status, 200);
      // Two 500ms handlers in series would take ~1000ms; in parallel ~500ms.
      assert.ok(wall < 900,
        'parallel run took ' + wall + 'ms — looks serial (>900ms)');
    });

    await t('audit records dispatched event per request', async () => {
      const seen = [];
      const { server: s2, port: p2 } = await controlChannel.start({
        port: pickPort(),
        operator_pubkey_b64: PUB_B64,
        operator_pubkey_id:  PUB_ID,
        handlers,
        audit: (kind, fields) => seen.push({ kind, fields })
      });
      try {
        await postEnvelope(p2, signEnvelope({ scope: 'control:fast_chat', payload: {} }));
        const dispatched = seen.filter((s) => s.kind === 'control_channel.dispatched');
        assert.strictEqual(dispatched.length, 1, 'one dispatched record');
        assert.strictEqual(dispatched[0].fields.scope, 'control:fast_chat');
      } finally { s2.close(); }
    });

  } finally { server.close(); }

  console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
