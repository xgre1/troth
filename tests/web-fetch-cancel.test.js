#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// A fetch in flight ends when the turn is stopped: the request is destroyed
// on the next poll of the turn's cancel, and the caller gets a result that
// says so, long before the socket timeout would have.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-fetch-cancel-'));
process.env.TROTH_WEB_ALLOWLIST_PATH = path.join(tmpRoot, 'web-allowlist.json');
fs.writeFileSync(process.env.TROTH_WEB_ALLOWLIST_PATH, JSON.stringify({ domains: ['localhost'], updated_ts: Date.now() }));

const webFetch = require('../shared-core/tools/web-fetch.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ok ' + name); }

// A server that accepts the connection and never answers: the TLS handshake
// waits forever, which is what a slow host looks like from the fetcher.
function silentServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => { sock.on('error', () => {}); });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await silentServer();
  const url = 'https://localhost:' + server.address().port + '/page';
  try {
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 150);
    const t0 = Date.now();
    const r = await webFetch.fetchUrl(url, { timeout_ms: 8000, shouldCancel: () => cancelled });
    const ms = Date.now() - t0;
    ok('a stopped turn ends the fetch: ' + ms + ' ms', ms < 2000);
    ok('the result says the fetch was cancelled', r && r.ok === false && /cancelled/.test(String(r.error || '')));

    const t1 = Date.now();
    const r2 = await webFetch.fetchUrl(url, { timeout_ms: 400, shouldCancel: () => false });
    ok('a turn that goes on lets the fetch reach its timeout', r2 && r2.ok === false && /timeout/.test(String(r2.error || '')) && Date.now() - t1 >= 350);

    const r3 = await webFetch.fetchUrl(url, { timeout_ms: 400 });
    ok('without a cancel hook the fetch behaves as before', r3 && r3.ok === false && /timeout/.test(String(r3.error || '')));
  } finally {
    server.close();
  }
  console.log('web-fetch-cancel: ' + passed + ' passed, 0 failed');
})().catch((e) => { console.error('web-fetch-cancel: FAIL ' + (e && e.stack || e)); process.exit(1); });
