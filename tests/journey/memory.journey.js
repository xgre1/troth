// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Memory, checked where it actually matters: not "was a row written" but "was
// the operator's own fact put in front of the model, in a later process, on a
// different day's worth of state". The stand-in vendor records everything it is
// shown, so this reads the real context envelope rather than trusting a count.
module.exports.describe = 'what the operator told it once is there the next time';

module.exports.run = async (ctx, check) => {
  const upstream = await require('./lib/upstream.js').start({
    reply: () => 'Noted.',
  });

  try {
    const env = {
      TROTH_ENTITY_LLM: 'kimi_sub',
      TROTH_ENTITY_LLM_PIN: '1',
      TROTH_KIMI_SUB_KEY: 'sk-fake-standin',
      TROTH_KIMI_SUB_BASE: upstream.base,
      TROTH_LLM_TIMEOUT_MS: '20000',
    };
    ctx.writeConfig({ providers: {} });

    const FACT = 'the release train leaves on OSPREY-8801';

    // Write it the way a person does.
    const write = await ctx.daemon([
      ctx.say('/remember ' + FACT, 'M1'),
    ], { env, settleMs: 12000 });
    const ack = write.events.find((e) => e.kind === 'response' && e.conversation_id === 'M1');
    check('the fact is accepted', !!ack && !write.events.some((e) => e.kind === 'error'),
      ack ? String(ack.text).slice(0, 120) : 'no reply to /remember');

    // A separate process, a separate conversation. Nothing in memory of the
    // first run survives except what was written to disk.
    const before = upstream.requests.length;
    await ctx.daemon([
      ctx.say('When does the release train leave?', 'M2'),
    ], { env, settleMs: 16000 });

    const shown = JSON.stringify(upstream.requests.slice(before));
    check('the model is asked with the fact in hand', shown.indexOf('OSPREY-8801') !== -1,
      'the question reached the model with no trace of what was remembered');

    // Recall must survive an unrelated conversation in between — the common
    // real shape, and where a naive last-N window quietly drops it.
    const mid = upstream.requests.length;
    await ctx.daemon([
      ctx.say('Tell me something about the weather instead.', 'M3'),
      ctx.say('And when does the release train leave?', 'M4'),
    ], { env, settleMs: 20000 });
    const later = JSON.stringify(upstream.requests.slice(mid));
    check('it survives an unrelated conversation in between',
      later.indexOf('OSPREY-8801') !== -1,
      'the fact fell out of context once something else was discussed');

    // Recall is not supposed to hand the model everything ever said. If the
    // envelope grows without bound the model pays for it on every turn.
    const sizes = upstream.requests.map((r) => JSON.stringify(r.body).length);
    const biggest = Math.max.apply(null, sizes);
    check('the context envelope stays bounded', biggest < 400000,
      'largest request was ' + biggest + ' bytes');
  } finally {
    await upstream.close();
  }
};
