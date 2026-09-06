#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// /inspect: a deterministic command that reads the machine through the proxy
// and answers in text on every documented form, including when no proxy is up.
const assert = require('assert');
const http = require('http');
const { DETERMINISTIC_HANDLERS: H } = require('../shared-core/slash/executor.js');
const parser = require('../shared-core/slash/parser.js');
const ctx = { agent_id: 'inspect-test', cwd: null, user_id: 'op', conversation_id: 'i1' };

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

(async () => {
  console.log('inspect-slash');
  await t('registered with a bundled deterministic skill', () => {
    assert.strictEqual(typeof H.inspect, 'function');
    const skill = require('../shared-core/slash/loader.js').loadAll({ cwd: require('os').tmpdir() }).get('inspect');
    assert.ok(skill && skill.kind === 'deterministic');
  });
  await t('no proxy: every form answers in text and none errors', async () => {
    process.env.TROTH_PROXY_URL = 'http://127.0.0.1:9';
    for (const line of ['/inspect', '/inspect load', '/inspect logs PAYLOAD', '/inspect probe gpt-x']) {
      const r = await H.inspect(parser.parse(line), ctx);
      assert.strictEqual(r.ok, true, line + ': ' + JSON.stringify(r));
      assert.ok(/not answering/.test(r.text), line + ' says the proxy is down: ' + r.text);
    }
  });
  await t('with a proxy: load and stats, the log grep and the lane probe read through', async () => {
    const asked = [];
    const srv = http.createServer((req, res) => {
      asked.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/stats') return res.end(JSON.stringify({ version: '0.1.22', pid: 4242, requests: 1234, errors: 2 }));
      if (req.url === '/api/system/load') return res.end(JSON.stringify({ top: { by_cpu: [{ command: 'troth-proxy-8000', cpu: 12.5, rss_mb: 300 }] } }));
      if (req.url.startsWith('/api/logs')) return res.end(JSON.stringify({ lines: ['[12:00] PAYLOAD BREAKDOWN a', '[12:01] PAYLOAD AFTER INJECT b'] }));
      if (req.url.startsWith('/api/providers/codex/probe')) return res.end(JSON.stringify({ ok: true, model: 'gpt-x' }));
      res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    process.env.TROTH_PROXY_URL = 'http://127.0.0.1:' + srv.address().port;
    try {
      const bare = await H.inspect(parser.parse('/inspect'), ctx);
      assert.ok(/4,242|4242/.test(bare.text) && /1,234|1234/.test(bare.text), 'stats named: ' + bare.text);
      assert.ok(/troth-proxy-8000/.test(bare.text) && /12\.5% cpu/.test(bare.text), 'the top process named: ' + bare.text);
      const logs = await H.inspect(parser.parse('/inspect logs PAYLOAD'), ctx);
      assert.ok(/PAYLOAD AFTER INJECT b/.test(logs.text), 'log lines: ' + logs.text);
      assert.ok(asked.some((u) => /\/api\/logs\?.*grep=PAYLOAD/.test(u)), 'the grep reached the proxy: ' + asked.join(' '));
      const probe = await H.inspect(parser.parse('/inspect probe gpt-x'), ctx);
      assert.ok(/✓ the ChatGPT lane answers \(gpt-x\)/.test(probe.text), probe.text);
    } finally { srv.close(); delete process.env.TROTH_PROXY_URL; }
  });
  console.log('\ninspect-slash: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
