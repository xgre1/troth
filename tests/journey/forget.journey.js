// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The Forget button, end to end, on the surface the operator actually clicks.
//
// Measured on a live substrate 2026-08-10: 5 of 6 clicks retired a DIFFERENT
// memory. The dashboard listed rows by id, sent only the statement text, and
// the handler re-derived its own target through a lookup whose candidate
// window is the newest 200 engrams — so an older row resolved to whichever
// recent one shared the most words. Unit tests pin the handler; this pins the
// whole chain the human touches: HTTP in, supersession out, neighbour intact.
module.exports.describe = 'clicking Forget retires that memory and leaves its lookalike alone';

module.exports.run = async (ctx, check) => {
  const path = require('path');
  const { spawnSync } = require('child_process');

  // Two memories worded so that a TEXT lookup is free to confuse them, written
  // through the substrate's own writer in this scenario's HOME (there is no
  // HTTP write surface for engrams, by design).
  const KEEP = 'the journey harbour ledger is reconciled every Tuesday by the finance desk';
  const DROP = 'the journey harbour ledger reconciliation moved to Thursday for the finance desk';
  const seed = spawnSync(ctx.NODE, ['-e',
    'const e=require(process.argv[1]);' +
    'const a=e.recordEngram({agent_id:"local-agent",user_id:"default",cwd:null,statement:process.argv[2],source:"journey",source_authority:"llm_inferred",auto_verify:false});' +
    'const b=e.recordEngram({agent_id:"local-agent",user_id:"default",cwd:null,statement:process.argv[3],source:"journey",source_authority:"llm_inferred",auto_verify:false});' +
    'console.log(JSON.stringify({keep:a,drop:b}));',
    path.join(ctx.root, 'shared-core', 'engram.js'), KEEP, DROP], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { HOME: ctx.home, TROTH_NO_MODEL_FETCH: '1', CLAUDE_PLUGIN_DATA: '' })
  });
  let ids = null;
  try { ids = JSON.parse(String(seed.stdout).trim().split('\n').pop()); } catch (_) {}
  check('two lookalike memories were written', !!(ids && ids.keep && ids.drop),
    'stdout=' + String(seed.stdout).slice(-120) + ' err=' + String(seed.stderr).slice(-160));
  if (!ids || !ids.drop) return;

  const proxy = await ctx.proxy({ env: { _TROTH_TEST_HOME: ctx.home, TROTH_MAINTENANCE: '0' } });

  const before = await proxy.get('/api/memory/search?q=' + encodeURIComponent('journey harbour ledger'));
  const items = (before.json && before.json.items) || [];
  check('both memories are listed, each with an id',
    items.length >= 2 && items.every((i) => !!i.id),
    'n=' + items.length + ' ids=' + items.map((i) => !!i.id).join(','));

  const drop = items.find((i) => String(i.statement || '').indexOf('Thursday') !== -1);
  const keep = items.find((i) => String(i.statement || '').indexOf('Tuesday') !== -1);
  check('the row we mean to forget is identifiable', !!drop && !!keep,
    JSON.stringify(items.map((i) => String(i.statement || '').slice(0, 40))));
  if (!drop || !keep) return;

  // The click: id travels with it, exactly as the dashboard now sends it.
  const r = await proxy.post('/api/memory/forget', { id: drop.id, statement: drop.statement });
  check('the click reports success', r.status === 200 && r.json && r.json.ok === true,
    'status=' + r.status + ' body=' + String(r.body).slice(0, 160));
  check('and it names the row we clicked', !!(r.json && r.json.side_effects && r.json.side_effects.forgot_id === drop.id),
    JSON.stringify(r.json && r.json.side_effects));

  // The search the human runs must be the recall the partner runs. The old
  // path scored word-overlap over the newest 200 engrams with no embeddings,
  // so it could not find a memory by MEANING at all.
  const sem = await proxy.get('/api/memory/search?q=' + encodeURIComponent('when is the accounts reconciliation done'));
  const semItems = (sem.json && sem.json.items) || [];
  check('search finds a memory by meaning, with no shared words',
    semItems.some((i) => String(i.statement || '').indexOf('harbour ledger') !== -1),
    JSON.stringify(semItems.slice(0, 3).map((i) => String(i.statement || '').slice(0, 44))));
  check('and every row says whether it can be forgotten',
    semItems.length > 0 && semItems.every((i) => typeof i.forgettable === 'boolean'),
    JSON.stringify(semItems.slice(0, 2)));

  const after = await proxy.get('/api/memory/search?q=' + encodeURIComponent('journey harbour ledger'));
  const left = ((after.json && after.json.items) || []).map((i) => String(i.statement || ''));
  check('the forgotten memory no longer surfaces',
    !left.some((s) => s.indexOf('Thursday') !== -1 && s.indexOf('FORGOTTEN') === -1),
    JSON.stringify(left.map((s) => s.slice(0, 44))));
  check('its near-identical neighbour SURVIVES (the bug this fixes)',
    left.some((s) => s.indexOf('Tuesday') !== -1),
    JSON.stringify(left.map((s) => s.slice(0, 44))));
};
