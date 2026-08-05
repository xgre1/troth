// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// An actual conversation, through the actual chain.
//
// Everything else runs on the echo faculty, which answers before the router,
// the transport, the stream parser and the dialogue writer are reached — so
// "the daemon replies" was proven and "a turn works" was not. Here a stand-in
// vendor endpoint speaks real Anthropic SSE, so the only thing missing is the
// vendor's network: no key, no bill, and it behaves the same in a container.
//
// The stand-in also records what it was shown, which is the only honest way to
// check what the product actually puts in front of a model.
module.exports.describe = 'a real turn: routed, streamed, answered, remembered';

module.exports.run = async (ctx, check) => {
  const upstream = await require('./lib/upstream.js').start({
    reply: (body, n) => 'Answer number ' + n + '. I read ' +
      JSON.stringify(String(JSON.stringify(body)).length) + ' bytes of context.',
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

    const CANARY = 'PELICAN-3312';
    const first = await ctx.daemon([
      ctx.say('My deployment key phrase is ' + CANARY + '. Hold on to it.', 'C1'),
    ], { env, settleMs: 16000 });

    check('the daemon boots against the stand-in', first.events.some((e) => e.kind === 'ready'),
      String(first.stderr).slice(-200));

    // The vendor was actually called — not bypassed, not stubbed out earlier.
    check('the request reached a model endpoint', upstream.requests.length > 0,
      'the stand-in was never called: the turn never left the process');

    const r1 = first.events.find((e) => e.kind === 'response' && e.conversation_id === 'C1');
    check('the turn came back ok', !!r1 && r1.status === 'ok',
      r1 ? ('status=' + r1.status + ' reason=' + r1.reason) : 'no response frame');
    check('the streamed answer is assembled whole',
      !!r1 && typeof r1.text === 'string' && r1.text.indexOf('Answer number 0') !== -1,
      r1 ? JSON.stringify(String(r1.text).slice(0, 120)) : '');
    check('it is attributed to the engine that answered',
      !!r1 && (r1.faculty === 'kimi_sub' || /kimi/i.test(String(r1.faculty || ''))),
      r1 ? String(r1.faculty) : '');

    // A NEW process, same HOME: the conversation has to have survived, because
    // that is the whole product.
    const callsBefore = upstream.requests.length;
    const second = await ctx.daemon([
      ctx.say('What was my deployment key phrase?', 'C1'),
    ], { env, settleMs: 16000 });

    check('a second process answers too',
      second.events.some((e) => e.kind === 'response' && e.conversation_id === 'C1'),
      'no response after restart');
    check('the second process called the model as well',
      upstream.requests.length > callsBefore, 'no new request reached the endpoint');

    // What matters is not the model's answer — the stand-in cannot know it —
    // but whether the product PUT the earlier turn in front of it.
    const shownAfterRestart = JSON.stringify(upstream.requests.slice(callsBefore));
    check('the earlier turn is carried into the new process',
      shownAfterRestart.indexOf(CANARY) !== -1,
      'the model was asked the follow-up with no sight of what was said before');

    // And the operator's key must never be part of that context.
    check('the membership key never appears in what the model is shown',
      upstream.seen().indexOf('sk-fake-standin') === -1 ||
      // it legitimately rides the auth header, never the body
      JSON.stringify(upstream.requests.map((r) => r.body)).indexOf('sk-fake-standin') === -1,
      'the key reached the message body');
  } finally {
    await upstream.close();
  }
};
