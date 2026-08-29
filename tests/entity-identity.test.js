#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// entity-identity — canonical identity for the entity axis.
// Specimen: the cross-session coreference class — "sister's wedding" and
// "Jen and Tom's wedding" naming one event, told sessions apart.
// Proves: identity engrams (scope entity:<slug>) + alias expansion make
// multiAxisQuery surface a record that shares ZERO tokens with the prompt,
// through the existing entity-axis scoring path — recognition-from-memory.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB = path.join(os.tmpdir(), 'troth-entity-identity-test-' + process.pid + '.db');
process.env.STATE_DB_PATH = DB;
process.env.TROTH_PRINCIPAL = 'partner';
delete process.env.TROTH_ENTITY_IDENTITY;

const assert = require('assert');
const identity = require('../shared-core/entity-identity.js');
const entityAxis = require('../shared-core/entity-axis.js');
const dialogueMemory = require('../shared-core/dialogue-memory.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

const BRAIN = 'test-brain';

console.log('\n=== entity-identity (identity for the entity axis) ===\n');

t('slugify: unicode-aware, diacritics stripped, punctuation collapsed', () => {
  assert.strictEqual(identity.slugify('Dr. Patel'), 'dr-patel');
  assert.strictEqual(identity.slugify('Jen'), 'jen');
  assert.strictEqual(identity.slugify('café corner'), 'cafe-corner');
  assert.strictEqual(identity.slugify('Αδερφή Μου'), 'αδερφη-μου');
});

let first = null;
t('recordEntityIdentity writes an engram in scope entity:<slug>', () => {
  first = identity.recordEntityIdentity({
    agent_id: BRAIN,
    name: 'Jen',
    kind: 'person',
    relation: "operator's sister",
    aliases: ['my sister'],
    provenance_ref: ['dialogue.turn:test-0001']
  });
  assert.ok(first && first.id, 'must return the engram id');
  assert.strictEqual(first.scope, 'entity:jen');
  const got = identity.getIdentity('Jen', { agent_id: BRAIN, fresh: true });
  assert.ok(got, 'registry must hold the identity');
  assert.ok(got.aliases.some(a => a.toLowerCase() === 'my sister'), 'alias recorded');
});

t('re-record with same data is a no-op (idempotent)', () => {
  const again = identity.recordEntityIdentity({
    agent_id: BRAIN, name: 'Jen', kind: 'person',
    relation: "operator's sister", aliases: ['my sister']
  });
  assert.strictEqual(again.updated, false, 'no new write for identical identity');
  assert.strictEqual(again.id, first.id, 'returns the existing engram id');
});

t('new alias supersedes: registry keeps ONE current view with the union', () => {
  const ext = identity.recordEntityIdentity({
    agent_id: BRAIN, name: 'Jen', aliases: ['Jennifer Kalt']
  });
  assert.ok(ext.updated, 'alias extension must write');
  assert.notStrictEqual(ext.id, first.id);
  const reg = identity.loadRegistry({ agent_id: BRAIN, fresh: true });
  const jens = reg.filter(i => i.slug === 'jen');
  assert.strictEqual(jens.length, 1, 'supersession chain must leave exactly one current identity, got ' + jens.length);
  const al = jens[0].aliases.map(a => a.toLowerCase());
  assert.ok(al.includes('my sister') && al.includes('jennifer kalt'), 'union of aliases: ' + al.join('|'));
});

t('lookupFromText: multi-word alias, case-insensitive, unicode boundaries', () => {
  const hits = identity.lookupFromText("MY SISTER's wedding was lovely", { agent_id: BRAIN, fresh: true });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].identity.slug, 'jen');
});

t('lookupFromText: word boundary — "Jenkins" must NOT match "Jen"', () => {
  const hits = identity.lookupFromText('the Jenkins pipeline is red', { agent_id: BRAIN });
  assert.strictEqual(hits.length, 0, 'substring match would flood the axis');
});

t('lookupFromText: unknown names match nothing (registry-driven, by design)', () => {
  const hits = identity.lookupFromText("Marcus said the quarterly numbers look fine", { agent_id: BRAIN });
  assert.strictEqual(hits.length, 0);
});

t('expandForQuery returns the full name set for a matched identity', () => {
  const ex = identity.expandForQuery("my sister's birthday", { agent_id: BRAIN });
  const toks = ex.tokens.map(s => s.toLowerCase());
  assert.ok(toks.includes('jen'), 'canonical joins the token set: ' + toks.join('|'));
  assert.ok(toks.includes('jennifer kalt'), 'sibling aliases join too');
});

// ── THE SPECIMEN — the weddings-class coreference resolution ────────────
t('SPECIMEN: "my sister\'s wedding" surfaces the "Jen and Tom" turn via the entity axis', () => {
  const ok = dialogueMemory.recordTurn({
    agent_id: BRAIN,
    user_text: "Jen and Tom's wedding at the rooftop garden was beautiful — I was maid of honor.",
    assistant_text: 'That sounds like a wonderful day.',
    conversation_id: 'sess-weddings-1'
  });
  assert.ok(ok, 'recordTurn must persist through the real write path');
  const ranked = entityAxis.multiAxisQuery({
    prompt: "my sister's wedding",
    agent_id: BRAIN,
    limit: 10
  });
  const hit = ranked.find(r => {
    const blob = String(r.row.input || '') + String(r.row.output || '');
    return blob.indexOf('rooftop garden') >= 0;
  });
  assert.ok(hit, 'the Jen-and-Tom turn must be surfaced (got ' + ranked.length + ' rows, none matching)');
  assert.ok(hit.axis_hits.includes('entity'), 'must arrive via the entity axis, not incidentally: ' + hit.axis_hits.join('|'));
});

t('CONTROL: with TROTH_ENTITY_IDENTITY=0 the same prompt does NOT reach the turn', () => {
  process.env.TROTH_ENTITY_IDENTITY = '0';
  try {
    const ranked = entityAxis.multiAxisQuery({
      prompt: "my sister's wedding",
      agent_id: BRAIN,
      limit: 10
    });
    const hit = ranked.find(r => {
      const blob = String(r.row.input || '') + String(r.row.output || '');
      return blob.indexOf('rooftop garden') >= 0 && r.axis_hits.includes('entity');
    });
    assert.ok(!hit, 'without identity expansion the coreference cannot resolve — if this fires, the specimen proves nothing');
  } finally {
    delete process.env.TROTH_ENTITY_IDENTITY;
  }
});

console.log('');
console.log('entity-identity: ' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch (_) {}
process.exit(fail ? 1 : 0);
