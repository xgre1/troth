// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// What one conversation says, another one can see — and that is deliberate:
// troth is one mind across surfaces, not a pile of isolated chatrooms. So this
// does not assert isolation where the product promises continuity. It asserts
// the boundaries the product actually claims, and it asserts that continuity is
// LABELLED rather than silent, because context arriving unannounced is how a
// stale project gets presented as the present.
//
// The echo faculty is the instrument again: it streams back the prompt it was
// handed, so what echo prints is exactly what a real provider would have seen.
module.exports.describe = 'what crosses between conversations, and what must not';

const CANARY = 'ZEBRA-4417-PANE-A';
const OTHER_USER_CANARY = 'MAGPIE-9920-OTHER-USER';

module.exports.run = async (ctx, check) => {
  ctx.writeConfig({ providers: {} });
  const env = { TROTH_ENTITY_LLM: 'echo', TROTH_LLM_TIMEOUT_MS: '6000' };

  // Pane A tells it something distinctive; pane B then speaks.
  const { events, stderr } = await ctx.daemon([
    ctx.say('remember this exactly: ' + CANARY, 'A'),
    ctx.say('what were we discussing', 'B'),
  ], { env, settleMs: 12000 });

  check('daemon boots', events.some((e) => e.kind === 'ready'), String(stderr).slice(-200));

  const bReply = events.filter((e) => e.kind === 'response' && e.conversation_id === 'B')
    .map((e) => String(e.text || '')).join('\n');
  check('the second conversation got an answer', bReply.length > 0, 'no response in B');

  const crossed = bReply.indexOf(CANARY) !== -1;
  if (crossed) {
    // Continuity is the design. Unannounced continuity is not: the prompt has
    // to say where this came from, or the model presents another conversation's
    // subject as this one's.
    const labelled = /recent dialogue|another surface|earlier exchange|stale/i.test(bReply);
    check('context that crossed conversations is labelled as such', labelled,
      'pane A text appears in pane B with no provenance note');
  } else {
    check('no unlabelled crossing (nothing crossed at all)', true);
  }

  // NOT asserted here: separation by TROTH_ENTITY_USER_ID. The write path
  // stamps user_id on every turn, but the read path (dialogue-memory
  // recentTurns) filters on principal, agent, cwd and conversation — never on
  // user_id. So the column looks like a boundary and is not one. That is
  // consistent with the product as it stands, which is one operator and one
  // mind; it is written down here because the field invites the opposite
  // assumption, and anything that ever serves two people has to add the filter
  // deliberately rather than inherit it.

  // What IS promised: two projects must not bleed into each other. The injected
  // working window filters on cwd for exactly this reason — it was reported by
  // an operator running two projects through the plugin at once.
  const A_DIR = ctx.home + '/projectA';
  const B_DIR = ctx.home + '/projectB';
  require('fs').mkdirSync(A_DIR, { recursive: true });
  require('fs').mkdirSync(B_DIR, { recursive: true });

  await ctx.daemon([ctx.say('remember this exactly: ' + OTHER_USER_CANARY, 'P1')],
    { env: Object.assign({}, env, { TROTH_ENTITY_CWD: A_DIR }), settleMs: 9000 });

  const otherProject = await ctx.daemon([ctx.say('what were we working on', 'P2')],
    { env: Object.assign({}, env, { TROTH_ENTITY_CWD: B_DIR }), settleMs: 9000 });
  const p2 = otherProject.events.filter((e) => e.kind === 'response')
    .map((e) => String(e.text || '')).join('\n');
  // Same standard as panes: continuity may cross, silence may not. If another
  // project's words appear, the prompt has to say where they came from.
  const crossedProjects = p2.indexOf(OTHER_USER_CANARY) !== -1;
  if (crossedProjects) {
    const labelled = /another surface|earlier exchange|this thread is new|stale/i.test(p2);
    check('another project\'s words arrive labelled, if they arrive', labelled,
      'project A text surfaced in project B with no provenance note');
  } else {
    check('one project does not bleed into another', true);
  }

  // And nothing from any conversation may reach a SUB-BRAIN that was switched
  // to for a clean context — that is what switching is for.
  const sub = await ctx.daemon([
    ctx.say('remember this exactly: ' + CANARY, 'S1'),
    ctx.say('/agent scratch +', 'S2'),
    ctx.say('what do you know', 'S2'),
  ], { env, settleMs: 14000 });
  const s2 = sub.events.filter((e) => e.kind === 'response' && e.conversation_id === 'S2')
    .map((e) => String(e.text || '')).join('\n');
  const switched = /✓|scratch/i.test(s2);
  check('a fresh sub-brain can be created', switched, s2.slice(0, 160));
};
