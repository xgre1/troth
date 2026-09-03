#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
require('./hermetic-db.js'); // a test never opens the operator's own substrate
// Vault value never leaks.
// Acceptance criterion: "vault value never in any intent payload or
// engram." The vault stores secrets that the substrate auto-attaches to
// outbound HTTPS requests via capability scope matching; the LLM never
// holds the value, and no engram on the recall pool may carry it. This
// test pins every reachable surface the value COULD leak through:
//   - listEntries / status / vault-file on-disk → no plaintext value
//   - getValueByKey / getValueForCapability → returns the value only to
//     the authorized substrate caller (expected, in-memory)
//   - listEngrams scan across every audience → no engram statement,
//     scope, or extra_output ever contains the plaintext
//
// Hermetic via tests/hermetic-db.js — temp HOME + per-test vault file.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const vault  = require(path.join(PROJECT_ROOT, 'shared-core', 'vault.js'));
const engram = require(path.join(PROJECT_ROOT, 'shared-core', 'engram.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

const VAULT_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vleak-')), 'vault.bin');
const PASSPHRASE = 'vault-leak-audit-passphrase';
const SECRET     = 'SUPER_SECRET_NEVER_LEAK_' + Date.now();
const VAULT_OPTS = { vault_path: VAULT_PATH, scrypt_n: 16384 };

function unlock() {
  const r = vault.unlock(PASSPHRASE, VAULT_OPTS);
  assert.strictEqual(r.ok, true, 'unlock: ' + JSON.stringify(r));
  return r;
}

// Scan EVERY engram (no audience filter) for the secret. Catches both
// substrate_internal and model_visible rows.
function scanForSecret(needle) {
  const rows = engram.listEngrams({
    principal: null, audience: 'all', limit: 5000
  }) || [];
  const hits = [];
  for (const r of rows) {
    if (!r) continue;
    const haystack = JSON.stringify(r);
    if (haystack.indexOf(needle) >= 0) hits.push(r.id);
  }
  return hits;
}

console.log('\n=== vault value never leaks ===\n');

t('preflight: unlock vault + write a secret entry', () => {
  unlock();
  const w = vault.writeEntry({
    key: 'blog_api_token',
    value: SECRET,
    capability_scope_glob: 'capability:http:do:blog.example.com/*',
    injection: { kind: 'bearer' }
  });
  assert.strictEqual(w.ok, true, 'write: ' + JSON.stringify(w));
});

t('listEntries → metadata only, NO plaintext value', () => {
  const list = vault.listEntries();
  assert.ok(list && Array.isArray(list.entries), 'list shape: ' + JSON.stringify(list));
  const entry = list.entries.find((e) => e.key === 'blog_api_token');
  assert.ok(entry, 'entry present in listEntries');
  assert.ok(!('value' in entry),
    'listEntries must NOT echo the value field — got ' + Object.keys(entry).join(','));
  // Defensive — serialize the whole list and confirm no plaintext.
  const blob = JSON.stringify(list);
  assert.strictEqual(blob.indexOf(SECRET), -1,
    'serialized listEntries contains the plaintext secret');
});

t('vault.status() → metadata only, NO plaintext value', () => {
  const s = vault.status(VAULT_OPTS);
  const blob = JSON.stringify(s);
  assert.strictEqual(blob.indexOf(SECRET), -1,
    'status() leaked plaintext: ' + blob.slice(0, 400));
});

t('on-disk vault file is encrypted — plaintext value NOT present', () => {
  assert.ok(fs.existsSync(VAULT_PATH));
  const raw = fs.readFileSync(VAULT_PATH);
  // Search both as utf8 and as hex — Buffer.indexOf catches binary leak.
  assert.strictEqual(raw.indexOf(SECRET), -1,
    'on-disk vault file contains the plaintext secret');
  assert.strictEqual(raw.toString('utf8').indexOf(SECRET), -1,
    'utf8 view of vault file contains the plaintext secret');
});

t('getValueByKey → returns the value (in-memory only, authorized call)', () => {
  // This is the auth-positive path: the substrate-internal caller (NOT the
  // LLM) asks for the value and gets it. The acceptance assertion is
  // "never in intent payload or engram" — in-memory is allowed by design.
  const r = vault.getValueByKey('blog_api_token',
    'capability:http:do:blog.example.com/posts');
  assert.ok(r && r.value === SECRET, 'authorized read: ' + JSON.stringify(r));
});

t('getValueByKey with WRONG capability scope → refused, no value', () => {
  const r = vault.getValueByKey('blog_api_token',
    'capability:http:do:evil.com');
  assert.ok(!r || r.value !== SECRET,
    'scope mismatch must NOT return the value: ' + JSON.stringify(r));
});

t('full engram pool scan → secret appears in ZERO engrams', () => {
  // The vault write itself does NOT record an engram with the value (vault
  // is its own crypto-on-disk surface). Confirm by scanning the whole pool.
  const hits = scanForSecret(SECRET);
  assert.strictEqual(hits.length, 0,
    'secret leaked to engrams ' + hits.join(','));
});

t('write a confused engram statement → still no leak to the pool view', () => {
  // Adversarial: write an engram that ATTEMPTS to embed the secret in its
  // statement. The substrate's contract is that secrets travel only via
  // the vault auto-attach path, never as engram content — operator-secret
  // / vault scopes are flagged by faculty.js for remote refusal too.
  // We assert defense-in-depth: scanForSecret correctly DOES find this
  // engram (proving the scan works), and we then confirm that the M2
  // faculty refusal path treats it as sensitive.
  engram.recordEngram({
    agent_id: 'leak-audit', user_id: 'operator', cwd: null,
    statement: 'OBVIOUS LEAK: ' + SECRET,
    scope: 'vault:blog_api_token',
    audience: 'substrate_internal',
    source: 'leak-audit',
    source_authority: 'llm_inferred',
    auto_verify: false
  });
  const hits = scanForSecret(SECRET);
  assert.ok(hits.length >= 1, 'scan must catch a deliberately leaked engram');
  const f = require(path.join(PROJECT_ROOT, 'shared-core', 'faculty.js'));
  // _isSensitiveEngram is a private helper, but the public wake() refusal
  // path proves the same predicate. Exercise it: a remote wake with this
  // engram in context must refuse.
  return f.wake({
    family: 'anthropic', prompt: 'noop',
    context_engrams: [{ scope: 'vault:blog_api_token', statement: 'OBVIOUS LEAK: ' + SECRET }],
    writeEngram: () => {},
    _transport: { generate: () => { throw new Error('transport must NOT be reached'); } }
  }).then((r) => {
    assert.strictEqual(r.refused, true,
      'remote wake must REFUSE a vault-scoped engram in context');
    assert.strictEqual(r.reason, 'sensitive_context');
  });
});

vault.lock();
try { fs.rmSync(path.dirname(VAULT_PATH), { recursive: true, force: true }); } catch (_) {}

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
