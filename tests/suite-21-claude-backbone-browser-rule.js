// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// suite-21: the Claude backbone (subprocess-cli claude_cli profile) must carry
// the governed-browser directive in --append-system-prompt on EVERY turn.
// Live find (18i): a Claude-backbone pane, told nothing, defaulted to writing
// an `npx playwright` script with its own Bash tool instead of the governed
// troth_browser_do path. The stable system prefix is identity+memory only, so
// the rule has to be bound to the profile itself. These tests pin:
//   (1) the directive rides --append-system-prompt even with a caller prefix,
//       and the caller prefix is preserved (prefix-first ordering);
//   (2) it rides even when the caller passes NO system prefix;
//   (3) it names troth_browser_do and forbids playwright/puppeteer/selenium
//       plus npm/npx browser-driver installs;
//   (4) no em-dash in the authored string (repo rule).
const assert = require('assert');
const { PROFILES } = require('../shared-core/transports/subprocess-cli.js');

function appended(vars) {
  const a = PROFILES.claude_cli.buildArgs(vars || {});
  const i = a.indexOf('--append-system-prompt');
  assert(i >= 0 && i + 1 < a.length,
    'claude_cli must pass --append-system-prompt; got ' + JSON.stringify(a));
  return String(a[i + 1]);
}

module.exports = function run({ test }) {
  test('BROWSER-RULE-1: the directive rides --append-system-prompt and preserves the caller prefix', () => {
    const prefix = 'You are Troth. Operator: Alex. [memory snapshot]';
    const sys = appended({ user: 'test my localhost app', system: prefix });
    assert(sys.includes(prefix),
      'caller identity+memory prefix must be preserved; got ' + JSON.stringify(sys.slice(0, 120)));
    assert(/troth_browser_do/.test(sys), 'must name the governed browser tool');
    assert(sys.indexOf(prefix) < sys.indexOf('troth_browser_do'),
      'prefix must come first, rule trails (byte-stable across turns)');
  });

  test('BROWSER-RULE-2: the directive is present even when the caller passes NO system prefix', () => {
    const sys = appended({ user: 'open example.com and read it' });
    assert(/troth_browser_do/.test(sys),
      'the browser rule must ride even with no caller prefix; got ' + JSON.stringify(sys));
  });

  test('BROWSER-RULE-3: the rule forbids scripted browsers and driver installs', () => {
    const sys = appended({ user: 'x' }).toLowerCase();
    for (const banned of ['playwright', 'puppeteer', 'selenium']) {
      assert(sys.includes(banned), 'rule must explicitly forbid ' + banned + '; got ' + JSON.stringify(sys));
    }
    assert(/never write or run/.test(sys), 'rule must be an explicit prohibition');
    assert(/npm|npx/.test(sys), 'rule must forbid installing a browser driver');
  });

  test('BROWSER-RULE-4: no em-dash in the appended system prompt (repo authored-string rule)', () => {
    const sys = appended({ user: 'x', system: 'prefix' });
    assert(!sys.includes('—'), 'no em-dash allowed in authored strings');
  });

  // ── Secrets rule (live find: a pane pasted a fresh secret into
  // the chat and told the operator to place it manually). Both topologies
  // must carry the discipline: the backbone via --append-system-prompt, the
  // native loop via buildSystemPrompt.
  test('SECRETS-RULE-1: the backbone append carries the secrets rule (vault by NAME, place via hands)', () => {
    const sys = appended({ user: 'rotate my supabase service key' });
    assert(/SECRETS:/.test(sys), 'secrets rule must ride the backbone append');
    assert(/never print secret values/i.test(sys), 'must forbid printing secret values');
    assert(/credential NAME/.test(sys), 'must steer to vault credential NAMEs');
    assert(/fill_from_vault/.test(sys) && /capture_to_vault/.test(sys),
      'must name the vault verbs so the model knows the mechanism exists');
  });

  test('SECRETS-RULE-2: the NATIVE system prompt carries the same secrets rule (kimi_sub runs this loop)', () => {
    const { buildSystemPrompt } = require('../shared-core/tools/system-prompt.js');
    const sys = String(buildSystemPrompt({
      agent_id: 'test', cwd: process.cwd(),
      available_tools: ['Read', 'Bash', 'mcp_call'], audio: false
    }));
    assert(/SECRETS:/.test(sys), 'native prompt must carry the secrets rule');
    assert(/never print secret values/i.test(sys), 'must forbid printing secret values');
    assert(/never ask the operator to copy-paste/i.test(sys),
      'must forbid the "here is the secret, you place it" pattern');
    assert(!sys.includes('—'), 'no em-dash in the native prompt');
  });
};
