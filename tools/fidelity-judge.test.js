// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const ROOT = require('path').resolve(__dirname, '..');
const fj = require(ROOT + '/shared-core/fidelity-judge.js');
let pass = 0, fail = 0;
function check(name, cond, msg) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (msg ? ' :: ' + msg : '')); }
}
function ids(chain) { return chain.map(function (c) { return c.provider + ':' + c.model; }); }

// isFlashModel
check('flash flagged', fj.isFlashModel('gemini-3-flash') === true);
check('haiku flagged', fj.isFlashModel('claude-haiku-4-5') === true);
check('gpt-4o-mini flagged', fj.isFlashModel('gpt-4o-mini') === true);
check('minimax NOT flash', fj.isFlashModel('minimax-m2.5') === false);
check('qwen3-max NOT flash', fj.isFlashModel('qwen3-max') === false);
check('deepseek-reasoner NOT flash', fj.isFlashModel('deepseek-reasoner') === false);

// orderJudgeChain
var P = {
  alibaba:    { enabled: true, apiKey: 'k', model: 'qwen3-max' },
  deepseek:   { enabled: true, apiKey: 'k', model: 'deepseek-reasoner' },
  openai_sub: { enabled: true, model: 'gpt-5.5' },
  anthropic:  { enabled: true, apiKey: 'k' },                       // must be excluded
  google_ai:  { enabled: true, apiKey: 'k', model: 'gemini-3-flash' }, // must be excluded (flash + not candidate)
  local:      { enabled: true, model: 'qwen2.5-coder-7b' }
};
var chain = fj.orderJudgeChain(P, { producerModel: 'claude-opus-4-8', localUp: true });
var got = ids(chain);
check('local first (free)', got[0].indexOf('local:') === 0, got.join(','));
check('anthropic excluded', got.every(function (s) { return s.indexOf('anthropic') < 0; }));
check('gemini flash excluded', got.every(function (s) { return s.indexOf('gemini') < 0; }));
check('includes alibaba qwen3-max', got.some(function (s) { return s === 'alibaba:qwen3-max'; }));
check('includes openai_sub fallback', got.some(function (s) { return s === 'openai_sub:gpt-5.5'; }));

// local not live => excluded
var chain2 = fj.orderJudgeChain(P, { producerModel: 'claude-opus-4-8', localUp: false });
check('local excluded when not live', ids(chain2).every(function (s) { return s.indexOf('local:') < 0; }));

// cross-family-first: producer=GPT => alibaba(qwen,cross) before openai_sub(gpt,same)
var chain3 = fj.orderJudgeChain({ alibaba: P.alibaba, openai_sub: P.openai_sub }, { producerModel: 'gpt-5.5', localUp: false });
var g3 = ids(chain3);
check('cross-family before same-family', g3.indexOf('alibaba:qwen3-max') < g3.indexOf('openai_sub:gpt-5.5'), g3.join(','));

// explicit pick wins, even flash (Advanced opt-in)
var chain4 = fj.orderJudgeChain(P, { pick: 'gemini-3-flash', producerModel: 'claude-opus-4-8', localUp: true });
check('explicit flash pick goes first', ids(chain4)[0].indexOf('gemini-3-flash') >= 0);

// no providers => empty chain
check('no providers => empty', fj.orderJudgeChain({}, {}).length === 0);

// makeJudge execution (mock adapters)
(async function () {
  var tried = [];
  var adapters = {
    providers: P,
    isLocalAvailable: function () { return true; },
    call: {
      local:      function () { tried.push('local'); return Promise.resolve(null); },      // local down/empty
      alibaba:    function () { tried.push('alibaba'); return Promise.resolve('LGTM'); },   // first usable
      openai_sub: function () { tried.push('openai_sub'); return Promise.resolve('nope'); }
    }
  };
  var judge = fj.makeJudge(adapters, { producerModel: 'claude-opus-4-8' });
  var out = await judge('rate this turn');
  check('makeJudge returns first non-empty', out === 'LGTM', 'got ' + out);
  check('makeJudge tried local before alibaba', tried.indexOf('local') < tried.indexOf('alibaba'));

  var allNull = fj.makeJudge({ providers: P, isLocalAvailable: function () { return true; }, call: { local: function () { return Promise.resolve(null); }, alibaba: function () { return Promise.resolve(''); } } }, {});
  check('makeJudge fail-open => null', (await allNull('x')) === null);

  var thrower = fj.makeJudge({ providers: P, isLocalAvailable: function () { return true; }, call: { local: function () { throw new Error('boom'); }, alibaba: function () { return Promise.resolve('LGTM'); } } }, {});
  check('makeJudge survives adapter throw', (await thrower('x')) === 'LGTM');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
