#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The ChatGPT lane's model choice: plain gpt ids of any generation are
// honoured, "*-codex" ids and foreign ids fall to the default, the default
// is the id verified with a ChatGPT account, and the shortlist behind it is
// non-empty and starts with the default.
const assert = require('assert');
const path = require('path');
const cx = require(path.join(__dirname, '..', 'shared-core', 'transports', 'codex-oauth.js'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }
console.log('\n=== ChatGPT lane model ladder ===\n');
t('a plain gpt id of any generation is honoured', () => {
  assert.strictEqual(cx.resolveCodexModel('gpt-5.6-terra', null), 'gpt-5.6-terra');
  assert.strictEqual(cx.resolveCodexModel('gpt-6-astra', null), 'gpt-6-astra');
});
t('a codex-only id or a foreign id falls to the default', () => {
  assert.strictEqual(cx.resolveCodexModel('gpt-5.3-codex', null), cx.DEFAULT_MODEL);
  assert.strictEqual(cx.resolveCodexModel('qwen3.6-35b-a3b-mtp', null), cx.DEFAULT_MODEL);
  assert.strictEqual(cx.resolveCodexModel(null, null), cx.DEFAULT_MODEL);
});
t('the default is the id verified on a ChatGPT account and heads the shortlist', () => {
  assert.strictEqual(cx.DEFAULT_MODEL, 'gpt-6-astra');
  assert.ok(Array.isArray(cx.FALLBACK_MODELS) && cx.FALLBACK_MODELS.length >= 2);
  assert.strictEqual(cx.FALLBACK_MODELS[0], cx.DEFAULT_MODEL);
});
console.log('\ncodex-model-ladder: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
