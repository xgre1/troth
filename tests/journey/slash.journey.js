// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every command /help advertises must answer. Not "return the right thing" —
// that is each command's own business — but ANSWER: a user who types something
// the product told them about must never get silence.
//
// Commands that legitimately require an argument are listed with one, taken
// from the product's own help line, so this suite tests the documented call
// and not a strawman.
module.exports.describe = 'every advertised command answers';

const NEEDS_ARG = {
  goal:     'ship the journey harness',       // "/goal goal statement"
  remember: 'the operator prefers short replies',
  refuse:   'never send mail without asking',
  forget:   'nothing-matches-this-pattern',
};

module.exports.run = async (ctx, check) => {
  ctx.writeConfig({ providers: { local: { enabled: true, host: '127.0.0.1', port: 1234 } } });

  // Ask the product what it offers, then hold it to that list.
  const helpRun = await ctx.daemon([ctx.say('/help', 'H')],
    { env: { TROTH_ENTITY_LLM: 'echo', TROTH_LLM_TIMEOUT_MS: '5000' }, settleMs: 6000 });
  const help = helpRun.events.find((e) => e.kind === 'response' && e.conversation_id === 'H');
  check('/help answers', !!(help && help.text), 'no /help response');
  if (!help || !help.text) return;

  const advertised = [...new Set((help.text.match(/^\s+\/[a-z-]+/gm) || [])
    .map((l) => l.trim().slice(1)))];
  check('/help advertises commands', advertised.length > 0, help.text.slice(0, 120));

  const lines = advertised.map((name, i) =>
    ctx.say('/' + name + (NEEDS_ARG[name] ? ' ' + NEEDS_ARG[name] : ''), 'c' + i));
  const { events } = await ctx.daemon(lines,
    { env: { TROTH_ENTITY_LLM: 'echo', TROTH_LLM_TIMEOUT_MS: '5000' }, settleMs: 14000, timeoutMs: 90000 });

  advertised.forEach((name, i) => {
    const cid = 'c' + i;
    const answered = events.some((e) => e.conversation_id === cid &&
      (e.kind === 'response' || e.kind === 'error' || e.kind === 'slash_unmatched'));
    const silent = !answered;
    check('/' + name + ' answers', !silent, 'no frame at all for /' + name);
    // An advertised command that errors on its own documented form is a
    // separate, louder failure than one that merely disagrees with the caller.
    const errored = events.find((e) => e.conversation_id === cid && e.kind === 'error');
    if (answered) {
      check('/' + name + ' does not error on its documented form', !errored,
        errored ? (errored.error + ': ' + (errored.detail || '')) : '');
    }
  });
};
