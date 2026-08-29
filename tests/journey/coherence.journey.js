// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The fresh-install truth, as a journey: what a stranger's machine derives,
// states and admits BEFORE anyone configures anything — and how the shape
// flips the moment a Claude subscription is the only engine (the exact
// install that spelunks state.db with cd/cat because nothing mounted its
// memory). Unit suites prove the rule table; this proves the
// SHIPPED surfaces serve it: the same file runs against the checkout, the
// DMG bundle's core, and the public export in Linux docker.
//
// Determinism rules, learned twice today:
// - Detection is HOME-rooted here (_TROTH_TEST_HOME): the darwin keychain
//   road would read the DEVELOPER's real Claude login inside a "virgin"
//   scenario and make the journey lie on the machine that wrote it.
// - The claude BINARY is stubbed at <home>/.claude/local/claude — a known
//   install location the detector probes — so the sub-only flip is the same
//   fact on a Mac with claude on PATH and inside a docker Linux that never
//   saw it.
module.exports.describe = 'a fresh machine derives its shape, admits what memory cannot do yet, and invents no numbers';

const fs = require('fs');
const path = require('path');

module.exports.run = async (ctx, check) => {
  const proxy = await ctx.proxy({ env: { _TROTH_TEST_HOME: ctx.home } });

  // ── Virgin HOME: nothing configured, and every surface says so honestly.
  const c1 = await proxy.get('/api/config/coherence');
  check('coherence answers on a virgin home', c1.status === 200 && !!(c1.json && c1.json.derived),
    'status=' + c1.status + ' body=' + String(c1.body).slice(0, 160));
  const d1 = (c1.json && c1.json.derived) || {};
  check('nothing configured derives the neutral shape (troth loop, no invented preference)',
    d1.backbone === 'troth' && d1.dispatch_prefer === '',
    JSON.stringify(d1));
  check('the neutral shape names its reason', Array.isArray(d1.reasons) && /nothing configured/.test(d1.reasons.join(' ')),
    JSON.stringify(d1.reasons));

  const r1 = await proxy.get('/api/memory/readiness');
  check('readiness answers', r1.status === 200 && !!(r1.json && r1.json.stage), 'status=' + r1.status);
  check('a fresh home never claims ready memory it does not have',
    r1.json && r1.json.stage !== 'ready' || (r1.json.indexing && r1.json.indexing.recall_missing === 0),
    JSON.stringify(r1.json && { stage: r1.json.stage, reasons: r1.json.reasons }));

  const u1 = await proxy.get('/api/usage/plan-window');
  check('plan usage answers with zeros, families empty, and NO percentage anywhere',
    u1.status === 200 && u1.json && u1.json.total && u1.json.total.tokens_in === 0
      && !/percent|ratio/.test(u1.body),
    'status=' + u1.status + ' body=' + String(u1.body).slice(0, 160));

  // ── The friend install: a Claude subscription becomes the ONLY engine.
  // Binary at a probed install location + a credentials file, both inside
  // the fresh HOME — the flip must follow from DETECTION alone, with no
  // wizard, no app, no stored setting anywhere.
  const stub = path.join(ctx.home, '.claude', 'local', 'claude');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  ctx.writeHomeFile('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'journey-stub' } });

  const c2 = await proxy.get('/api/config/coherence');
  const det = (c2.json && c2.json.detected) || {};
  const d2 = (c2.json && c2.json.derived) || {};
  check('the subscription is DETECTED from disk truth alone', det.claude_sub === true, JSON.stringify(det));
  check('sub-only derives the Claude Code backbone (the switch that mounts memory) + hosted dispatch',
    d2.backbone === 'claude_cli' && d2.dispatch_prefer === 'hosted',
    JSON.stringify(d2));
  check('and says WHY in the core\'s own words', Array.isArray(d2.reasons) && /only engine/.test(d2.reasons.join(' ')),
    JSON.stringify(d2.reasons));
  check('nothing was ever WRITTEN to reach that shape (derived, not stored)',
    !ctx.readConfig() || ctx.readConfig().backbone === undefined,
    JSON.stringify(ctx.readConfig()));
};
