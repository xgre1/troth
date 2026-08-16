// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The two shelves a person reads: the knowledge they gave the partner, and the
// rules they gave it. Both fetch when the view opens, and both were shipped
// with no test pressing them.
//
// What that cost, measured 2026-08-11: the knowledge shelf called an `esc`
// helper that is declared INSIDE another function. ReferenceError. The fetch
// .catch() then printed "Could not read the corpora" — a data-shaped message
// for a code fault, so it read as an empty substrate and sent the operator
// looking in the wrong place. The endpoint was fine the whole time.
//
// The first attempt at this guard was hollow: it pressed the button on a
// machine with no corpora, so the renderer returned at its empty branch and
// never reached the line that threw. A shelf must have something ON it before
// pressing it proves anything.
module.exports.describe = 'the knowledge and rules shelves render real content without throwing';

module.exports.run = async (ctx, check) => {
  const path = require('path');
  const { spawnSync } = require('child_process');
  const browserLib = require('./lib/browser.js');

  // A corpus, written the way ingest writes one: chunks under a docs: scope.
  const seed = spawnSync(ctx.NODE, ['-e',
    'const s=require(process.argv[1]);const ar=require(process.argv[2]);' +
    'const L=require(process.argv[3]);' +
    'for (let i=0;i<4;i++){const id=ar.uuidv7();s.recordAction({id,timestamp:Date.now()+i,type:"commitment",' +
    'agent_id:"journey",user_id:"default",cwd:null,memory_class:"semantic",audience:"model_visible",' +
    'input:{source:"ingest:docs:harbour-manual"},' +
    'output:{statement:"[section "+i+"] the harbour manual, page "+i,commitment_type:"engram",' +
    'scope:"docs:harbour-manual",salience:1,source_authority:"regex_extracted"}},"harbour manual "+i);}' +
    'L.recordRule({text:"file the harbour manifests the same day they are signed"})' +
    '  .then(function(r){ console.log(JSON.stringify({rule:!!(r&&r.ok)})); });',
    path.join(ctx.root, 'shared-core', 'state.js'),
    path.join(ctx.root, 'shared-core', 'action-record.js'),
    path.join(ctx.root, 'shared-core', 'lesson.js')], {
    encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { HOME: ctx.home, TROTH_NO_MODEL_FETCH: '1', CLAUDE_PLUGIN_DATA: '' })
  });
  let seeded = null;
  try { seeded = JSON.parse(String(seed.stdout).trim().split('\n').pop()); } catch (_) {}
  check('a corpus and a rule were seeded', !!(seeded && seeded.rule),
    'stdout=' + String(seed.stdout).slice(-140) + ' err=' + String(seed.stderr).slice(-200));
  if (!seeded || !seeded.rule) return;

  const proxy = await ctx.proxy({ env: { _TROTH_TEST_HOME: ctx.home, TROTH_MAINTENANCE: '0' } });

  // The endpoints first, so a UI failure below cannot be blamed on the server.
  const counts = await proxy.get('/api/substrate/counts');
  check('the counts endpoint carries the knowledge number the filter shows',
    ((counts.json || {}).knowledge) === 4, JSON.stringify((counts.json || {}).knowledge));

  const scopes = await proxy.get('/api/substrate/scopes?prefix=docs:');
  const corpora = ((scopes.json || {}).scopes) || [];
  check('the inventory endpoint reports the corpus with its true size',
    corpora.some((s) => s.scope === 'docs:harbour-manual' && s.count === 4),
    JSON.stringify(corpora.slice(0, 3)));
  const rules = await proxy.get('/api/substrate/rules?limit=5');
  check('the rules endpoint returns the operator rule',
    (((rules.json || {}).items) || []).some((r) => /harbour manifests/.test(String(r.text || ''))),
    JSON.stringify(rules.json));

  let page;
  try { page = await browserLib.open(ctx.root); }
  catch (e) {
    check('a browser is available to look with', false, String(e && e.message));
    return;
  }

  try {
    await page.goto('http://127.0.0.1:' + proxy.port + '/ui', { waitMs: 900 });
    await page.installErrorTrap();

  // Poll, never sleep: a fixed wait passes alone and fails in a full run,
  // which teaches nobody anything except to distrust the suite.
  const settle = async (expr, want, ms) => {
    const deadline = Date.now() + (ms || 8000);
    let last = '';
    while (Date.now() < deadline) {
      last = String(await page.eval(expr) || '');
      if (want.test(last)) return last;
      await new Promise((r) => setTimeout(r, 200));
    }
    return last;
  };


    // Open the page a person opens; the class list is filled when it does.
    await page.eval("(typeof navigate === 'function') ? (navigate('substrate'), 'ok') : 'no-navigate'");
    await settle("(function(){var s=document.getElementById('rec-type');return s?Array.prototype.map.call(s.options,function(o){return o.value}).join(','):''})()",
      /__knowledge__/, 10000);

    // Drive it the way a person does: pick the class in the records filter.
    // There is no separate card to press — that was the first shape and it
    // asked the operator to know that a document is stored differently from
    // an action record.
    const shelf = await page.eval(`(function(){
      try {
        var sel = document.getElementById('rec-type');
        if (!sel) return { missing: 'rec-type' };
        var has = Array.prototype.some.call(sel.options, function(o){ return o.value === '__knowledge__'; });
        if (!has) return { missing: 'knowledge option' };
        sel.value = '__knowledge__';
        sel.dispatchEvent(new Event('change'));
        return { called: true };
      } catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check('the records filter offers the knowledge class and switching to it does not throw',
      !!(shelf && shelf.called && !shelf.threw), JSON.stringify(shelf));

    const shelfText = await settle("(document.getElementById('rec-rows')||{}).innerText || ''", /harbour-manual|Could not read/);
    check('and it renders the corpus rather than a failure message',
      /harbour-manual/.test(String(shelfText)) && !/Could not read/i.test(String(shelfText)),
      JSON.stringify(String(shelfText).slice(0, 160)));

    // Settled, not sampled: the rows and the count land in separate ticks,
    // and on a slow runner an instant read still sees "loading…" after the
    // rows have arrived. Wait for ANY final wording — the check itself then
    // judges whether that wording is the human one.
    const summary = await settle("(document.getElementById('rec-meta')||{}).textContent || ''", /document|corpora|Could not/i);
    check('the count describes what is shown, in words a person uses',
      /1 document/.test(String(summary)) && /4 passages/.test(String(summary)) && !/corpora/i.test(String(summary)),
      JSON.stringify(summary));

    // Opening one is the whole point: recall answers "which passage matches",
    // never "what is in here".
    const opened = await page.eval(`(function(){
      try { openCorpus('docs:harbour-manual', 0); return { called: true }; }
      catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check('opening a corpus does not throw', !!(opened && opened.called && !opened.threw), JSON.stringify(opened));
    const chunks = await settle("(document.getElementById('rec-rows')||{}).innerText || ''", /page 0|Could not/);
    check('and it reads in ingest order', /page 0/.test(String(chunks)),
      JSON.stringify(String(chunks).slice(0, 160)));

    const rulesShelf = await page.eval(`(function(){
      try {
        if (typeof loadOperatorRules !== 'function') return { missing: true };
        loadOperatorRules();
        return { called: true };
      } catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check('pressing the rules shelf does not throw', !!(rulesShelf && rulesShelf.called && !rulesShelf.threw),
      JSON.stringify(rulesShelf));
    const rulesText = await settle("(document.getElementById('operator-rules-rows')||{}).innerText || ''", /harbour manifests|No standing rules/);
    check('and the operator rule is on it', /harbour manifests/.test(String(rulesText)),
      JSON.stringify(String(rulesText).slice(0, 160)));

    const errs = (await page.pageErrors()) || [];
    check('neither shelf raised a page error', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  } finally { page.close(); }
};
