// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The surfaces that name engines must agree with each other AND with where the
// turn actually goes. Every engine bug an operator has reported was a
// disagreement between exactly these three: Settings listed a provider, the
// /engine menu did not, and the turn went somewhere else again.
module.exports.describe = 'config, menu and dispatch tell the same story';
module.exports.run = async (ctx, check) => {
  // A machine with several providers paid for and ONE pinned in Settings.
  ctx.writeConfig({
    providers: {
      deepseek:   { enabled: true,  apiKey: 'sk-journey-deepseek' },
      anthropic:  { enabled: true,  apiKey: 'sk-journey-anthropic' },
      local:      { enabled: true,  host: '127.0.0.1', port: 1234 },
      openai_sub: { enabled: true },                          // codex token below
      openrouter: { enabled: false, apiKey: 'sk-journey-or' }, // OFF
      xai:        { enabled: true },                           // no credential
    },
  });
  ctx.writeHomeFile('.troth/codex-token.json', { access_token: 'j-at', refresh_token: 'j-rt' });

  const pinEnv = {
    TROTH_ENTITY_LLM: 'kimi_sub',
    TROTH_ENTITY_LLM_PIN: '1',                    // Settings: "always use Kimi"
    TROTH_KIMI_SUB_KEY: 'journey-fake-key',
    TROTH_KIMI_SUB_BASE: 'https://127.0.0.1:1/coding/',
    TROTH_LLM_TIMEOUT_MS: '6000',
  };

  const { events, stderr } = await ctx.daemon([
    ctx.say('/engine', 'A'),
    ctx.say('anything at all', 'A'),
    ctx.say('/engine deepseek', 'B'),
    ctx.say('anything at all', 'B'),
  ], { env: pinEnv });

  check('daemon boots with a pinned engine', events.some((e) => e.kind === 'ready'),
    String(stderr).slice(-200));

  const menu = events.find((e) => e.kind === 'response' && e.conversation_id === 'A' && Array.isArray(e.options));
  const values = menu ? menu.options.map((o) => o.value) : [];
  check('/engine offers a menu at all', values.length > 0,
    'responses: ' + JSON.stringify(events.filter((e) => e.kind === 'response' && e.conversation_id === 'A').map((e) => e.text).slice(0, 2)));

  // Everything the operator has credentialed is offerable — this is the exact
  // complaint: "Settings shows them all, /engine shows two".
  for (const want of ['/engine chatgpt', '/engine anthropic', '/engine local', '/engine deepseek']) {
    check('menu offers ' + want, values.includes(want), 'menu: ' + values.join(' | '));
  }
  // ...and nothing else. Offering what cannot answer is the same lie backwards.
  check('a disabled provider is never offered', !values.includes('/engine openrouter'), values.join(' | '));
  check('an uncredentialed provider is never offered', !values.includes('/engine xai'), values.join(' | '));

  const dA = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === 'A').map((e) => e.faculty);
  check('a plain turn still goes to the pinned engine', dA.length > 0 && dA.every((f) => f === 'kimi_sub'),
    JSON.stringify(dA));

  const dB = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === 'B').map((e) => e.faculty);
  check('an explicit /engine switch actually binds', dB[0] === 'router', JSON.stringify(dB));
};
