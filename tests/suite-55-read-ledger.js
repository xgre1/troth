// SPDX-License-Identifier: AGPL-3.0-only
// A file served from cache was still read.
//
// The read ledger (action_records type='read') is what every "what has been
// read" answer stands on: the code map's prior-reads context, and any future
// read-before-edit reasoning. Only the native Read hook wrote to it, so a
// file served by cached_read — the tool this project tells agents to prefer —
// left no trace, and the ledger told an incomplete truth. Measured while
// designing a read-before-edit check: the check would have accused exactly
// the reads the cache had served.
//
// The cache records both of its paths now, in the same record shape the Read
// hook writes, with one improvement this road gets for free: the content is
// in hand, so the hash is real instead of 'unverified'.
module.exports = function run({ test }) {
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nRead ledger covers the cache (RDL):');

test('RDL-1: cached_read ledgers the cold path AND the hit path, hash and all', function () {
  // Drive the real MCP server over stdio on a throwaway HOME, twice: the
  // first call reads disk, the second serves from cache. Both are reads.
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rdl-home-'));
  fs.mkdirSync(path.join(HOME, '.troth'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdl-docs-'));
  const target = path.join(dir, 'thing.js');
  const body = 'function thing() { return 1; }\n';
  fs.writeFileSync(target, body);
  const env = Object.assign({}, process.env, {
    HOME, _TROTH_TEST_HOME: HOME,
    STATE_DB_PATH: path.join(HOME, '.troth', 'state.db')
  });
  const drive = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'suite', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cached_read', arguments: { file_path: target } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cached_read', arguments: { file_path: target } } }
  ].map(JSON.stringify).join('\n') + '\n';
  const r = cp.spawnSync('node', [path.join(ROOT, 'plugin', 'mcp-servers', 'troth-cache', 'server.mjs')],
    { env, cwd: dir, input: drive, encoding: 'utf8', timeout: 30000 });
  const replies = r.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  // The first result of a session may carry the one-shot [troth] greeting as
  // its leading content block; the payload is whichever block parses as JSON.
  const src = (id) => {
    try {
      for (const c of replies.find(x => x.id === id).result.content) {
        try { return JSON.parse(c.text).source; } catch (_) {}
      }
    } catch (_) {}
    return '?';
  };
  assert.strictEqual(src(2), 'fs', 'first serve is cold');
  assert.strictEqual(src(3), 'troth-cache', 'second serve is the cache');

  const Database = require('better-sqlite3');
  const db = new Database(env.STATE_DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db.prepare("SELECT input, output FROM action_records WHERE type='read'").all();
  db.close();
  assert.strictEqual(rows.length, 2, 'both serves ledger as reads — a hit is still a read');
  const expectHash = require('crypto').createHash('sha256').update(body).digest('hex');
  for (const row of rows) {
    assert.ok(/thing\.js$/.test(JSON.parse(row.input).file_path), 'the ledger names the file');
    const o = JSON.parse(row.output);
    assert.strictEqual(o.hash, expectHash, 'a REAL content hash, not "unverified" — the content was in hand');
    assert.strictEqual(o.bytes, Buffer.byteLength(body));
  }
});

test('RDL-2: both serve paths call the one ledger writer (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'plugin', 'mcp-servers', 'troth-cache', 'server.mjs'), 'utf8');
  const reads = (src.match(/recordReadLedger\(/g) || []).length;
  assert.ok(reads >= 3, 'defined once, called on the hit path and the cold path: ' + reads);
  assert.ok(/type: 'read'/.test(src), 'in the same record shape the Read hook writes');
});
};
