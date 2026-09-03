#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The hygiene pass retires what the write gates would refuse today but
// already stands in the pool: an occurrence whose entity is a word of the
// chat, a registry name that is no name, an insult riding as an alias, a
// relation that is a verdict sentence. Through superseding rows, never a
// delete; the older rows stay as history.
process.env.STATE_DB_PATH = require('os').tmpdir() + '/troth-hygiene-' + process.pid + '.db';
require('./hermetic-db.js');
const assert = require('assert');
const path = require('path');
const bw = require(path.join(__dirname, '..', 'shared-core', 'background-worker.js'));
const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const identity = require(path.join(__dirname, '..', 'shared-core', 'entity-identity.js'));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + ': ' + e.message); fail++; } }

console.log('\n=== memory hygiene ===\n');
const A = 'hygiene-test';
const inst = (entity, desc) => engram.recordEngram({
  agent_id: A, user_id: 'default', cwd: null,
  statement: 'activity: worked ' + entity + ' — ' + desc + ' [completed] (attested ×1)',
  scope: 'instance:activity', source: 'instance_consolidation', source_authority: 'plr_evolved', audience: 'substrate_internal', memory_class: 'operational', auto_verify: false,
  extra_output: { payload: { instance: { kind: 'activity', entity, description: desc, status: 'completed', qualifier: 'worked' } }, provenance_ref: ['dialogue.turn:x'] }
});
const ident = (canonical, kind, relation, aliases) => engram.recordEngram({
  agent_id: A, user_id: 'default', cwd: null,
  statement: canonical + ' — ' + kind + (relation ? ' (' + relation + ')' : '') + '; also known as: ' + aliases.join(', '),
  scope: 'entity:' + identity.slugify(canonical), source: 'entity-identity', source_authority: 'plr_evolved', auto_verify: false,
  extra_output: { payload: { entity_identity: { slug: identity.slugify(canonical), canonical, kind, relation, aliases: [canonical].concat(aliases) } } }
});

(async () => {
  inst('orea', 'Working as a software engineer using methodology');
  inst('user', 'Working on the sandbox');
  inst('Nikos', 'Reviewed the sandbox work');
  ident('Anthropic', 'organization', "entity blocking the user's fable", ['contosso', 'i mana poutanes gioi tis anthropic']);
  ident('orea', 'colleague', null, ['sinexise']);
  ident('Nikos', 'colleague', 'coworker', []);
  const doc = (cwd, title) => engram.recordEngram({
    agent_id: A, user_id: 'default', cwd,
    statement: '[' + title + ' #1] some chunk of text that was read',
    scope: 'docs:seen:' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20), source: 'seen:abc', source_authority: 'plr_evolved', auto_verify: false,
    extra_output: { provenance: { tier: 'operator', ref: null } }
  });
  doc('/Users/x/.claude/projects/-Users-x/abc/tool-results', 'mcp-plugin-troth-recall-1788.txt');
  doc('/Users/x/.claude/projects/-Users-x', 'hook-5b61-7-additionalContext.txt');
  doc('/Users/x/Documents/research', 'llama-cpp-notes.md');

  await t('occurrences whose entity is not an entity are retired; a real one stands', async () => {
    const r = await bw.tasks.memoryHygiene.run({ substrate_ctx: { agent_id: A, user_id: 'default', cwd: null } });
    assert.ok(/instances_retired=2/.test(r.notes[0]), r.notes[0]);
    assert.ok(/docs_retired=2/.test(r.notes[0]), r.notes[0]);
    const docs = engram.listEngrams({ scope_prefix: 'docs:', audience: 'all', agent_id: A, limit: 20 }) || [];
    assert.deepStrictEqual(docs.map((d) => d.statement.slice(1, 20)), ['llama-cpp-notes.md '], docs.map((d) => d.statement).join(' | '));
    const rows = engram.listEngrams({ scope_prefix: 'instance:', audience: 'all', agent_id: A, limit: 20 }) || [];
    assert.deepStrictEqual(rows.map((x) => x.payload.instance.entity).sort(), ['Nikos'], rows.map((x) => x.statement).join(' | '));
  });

  await t('the registry keeps names only: the insult leaves the aliases, the verdict leaves the relation, the non-name leaves the registry', async () => {
    const reg = identity.loadRegistry({ fresh: true });
    const names = reg.map((x) => x.canonical).sort();
    assert.deepStrictEqual(names, ['Anthropic', 'Nikos'], names.join(' | '));
    const anth = reg.find((x) => x.canonical === 'Anthropic');
    assert.deepStrictEqual(anth.aliases.sort(), ['Anthropic', 'contosso'], anth.aliases.join(' | '));
    assert.strictEqual(anth.relation, null);
    const st = reg.find((x) => x.canonical === 'Nikos');
    assert.strictEqual(st.relation, 'coworker');
  });

  await t('a second run finds nothing left to clean', async () => {
    const r = await bw.tasks.memoryHygiene.run({ substrate_ctx: { agent_id: A, user_id: 'default', cwd: null } });
    assert.ok(/instances_retired=0 identities_cleaned=0 identities_retired=0 docs_retired=0/.test(r.notes[0]), r.notes[0]);
  });

  console.log('\nmemory-hygiene: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
