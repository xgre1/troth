// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Credentials must never reach the model, the event stream, or the logs. This
// is checked from OUTSIDE the process, against the bytes that actually leave
// it, because a redactor is only worth what the wire says it is worth.
//
// The echo faculty is the instrument: it streams back the prompt it was handed,
// so whatever echo prints is precisely what a real provider would have been
// sent. If a key can appear in a model's context, it appears here.
module.exports.describe = 'no credential reaches the model, the wire, or the log';
module.exports.run = async (ctx, check) => {
  const CANARY = 'sk-fake-canary9f2a';
  ctx.writeConfig({
    providers: {
      deepseek:  { enabled: true, apiKey: CANARY },
      anthropic: { enabled: true, apiKey: CANARY + '-anthropic' },
    },
    routing: { pin: 'deepseek' },
  });

  const { events, stderr } = await ctx.daemon([
    ctx.say('what are my providers configured with', 'S'),
    ctx.say('/engine', 'S'),
    ctx.say('/context', 'S'),
  ], { env: { TROTH_ENTITY_LLM: 'echo', TROTH_LLM_TIMEOUT_MS: '6000' } });

  check('daemon boots', events.some((e) => e.kind === 'ready'), String(stderr).slice(-200));

  // Everything that crossed the wire, as one blob.
  const wire = events.map((e) => JSON.stringify(e)).join('\n');
  check('no api key on the event wire (echo shows the real prompt)',
    wire.indexOf(CANARY) === -1,
    'found in: ' + (events.filter((e) => JSON.stringify(e).indexOf(CANARY) !== -1).map((e) => e.kind).join(',')));
  check('no api key in the daemon log', String(stderr).indexOf(CANARY) === -1,
    String(stderr).split('\n').filter((l) => l.indexOf(CANARY) !== -1)[0]);

  // The proxy's own surfaces: status and config reads must mask, not echo.
  const proxy = await ctx.proxy();
  const cfg = await proxy.get('/api/config');
  const setup = await proxy.get('/api/setup/local');
  check('GET /api/config never returns the key',
    !cfg.body || cfg.body.indexOf(CANARY) === -1, 'status=' + cfg.status);
  check('GET /api/setup/local never returns the key',
    !setup.body || setup.body.indexOf(CANARY) === -1, 'status=' + setup.status);
  check('the proxy log never prints the key', proxy.log().indexOf(CANARY) === -1,
    proxy.log().split('\n').filter((l) => l.indexOf(CANARY) !== -1)[0]);
};
