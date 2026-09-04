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

  // ── Model pick (audit item 15: "Fable 5 selected, does not
  // play"). Settings → Claude → model writes providers.anthropic.model in
  // ~/.troth/config.json, and the claude_cli spawn would consult only the
  // dispatcher's ambient vars.model — the pick was durably stored in a key
  // no spawn ever read. These pin the source order the profile now walks:
  // TROTH_CLAUDE_MODEL env > config pick > ambient vars.model, every source
  // behind the same /claude/ guard (a non-claude id makes `claude -p` exit 1
  // with empty stdout — the blank-reply failure the guard has always caught).
  test('MODEL-PICK-1: the configured providers.anthropic.model rides --model', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const p = path.join(os.tmpdir(), 'troth-model-pick-' + process.pid + '.json');
    fs.writeFileSync(p, JSON.stringify({ providers: { anthropic: { enabled: true, model: 'claude-fable-5' } } }));
    const saved = process.env.TROTH_CONFIG_PATH;
    process.env.TROTH_CONFIG_PATH = p;
    try {
      const a = PROFILES.claude_cli.buildArgs({ user: 'x' });
      const i = a.indexOf('--model');
      assert(i >= 0, 'the operator pick must reach the spawn; got ' + JSON.stringify(a));
      assert.strictEqual(a[i + 1], 'claude-fable-5', 'the pick itself, verbatim');
    } finally {
      if (saved === undefined) delete process.env.TROTH_CONFIG_PATH; else process.env.TROTH_CONFIG_PATH = saved;
      try { fs.unlinkSync(p); } catch (_) {}
    }
  });

  test('MODEL-PICK-2: env override wins; non-claude ids never reach the flag; ambient fallback survives', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const p = path.join(os.tmpdir(), 'troth-model-pick2-' + process.pid + '.json');
    const savedPath = process.env.TROTH_CONFIG_PATH;
    const savedModel = process.env.TROTH_CLAUDE_MODEL;
    try {
      // (a) env outranks the config pick — the Rust side's override hook,
      //     mirroring TROTH_KIMI_SUB_MODEL.
      fs.writeFileSync(p, JSON.stringify({ providers: { anthropic: { model: 'claude-fable-5' } } }));
      process.env.TROTH_CONFIG_PATH = p;
      process.env.TROTH_CLAUDE_MODEL = 'claude-opus-5';
      let a = PROFILES.claude_cli.buildArgs({ user: 'x' });
      assert.strictEqual(a[a.indexOf('--model') + 1], 'claude-opus-5', 'env override must win');
      // (b) a stale non-claude value — wherever it came from — stays off the
      //     command line entirely; the subscription default answers instead.
      delete process.env.TROTH_CLAUDE_MODEL;
      fs.writeFileSync(p, JSON.stringify({ providers: { anthropic: { model: 'Qwen3.6-35B-A3B' } } }));
      a = PROFILES.claude_cli.buildArgs({ user: 'x', model: 'Qwen3.6-35B-A3B' });
      assert.strictEqual(a.indexOf('--model'), -1, 'non-claude ids must never reach --model: ' + JSON.stringify(a));
      // (c) with no pick anywhere, the ambient claude id still rides — the
      //     pre-fix behaviour this change must not lose.
      fs.writeFileSync(p, JSON.stringify({}));
      a = PROFILES.claude_cli.buildArgs({ user: 'x', model: 'claude-opus-4-8' });
      assert.strictEqual(a[a.indexOf('--model') + 1], 'claude-opus-4-8', 'ambient fallback preserved');
    } finally {
      if (savedPath === undefined) delete process.env.TROTH_CONFIG_PATH; else process.env.TROTH_CONFIG_PATH = savedPath;
      if (savedModel === undefined) delete process.env.TROTH_CLAUDE_MODEL; else process.env.TROTH_CLAUDE_MODEL = savedModel;
      try { fs.unlinkSync(p); } catch (_) {}
    }
  });

  // ── Memory rule (audit: memory questions funnelled into
  // troth-bash file greps and a raw sqlite open of state.db, because
  // troth_recall was reachable only behind mcp_call whose description never
  // says the word memory). The rule rides ONLY when the substrate MCP
  // actually mounts — naming tools that are not there would be the same
  // fiction the 41-tool advert was.
  test('MEMORY-RULE-1: with the substrate MCP mounted, the append names the real recall ids', () => {
    const saved = process.env.TROTH_CLAUDE_MCP;
    process.env.TROTH_CLAUDE_MCP = '1';
    try {
      const sys = appended({ user: 'what did we decide about the parser?' });
      assert(/MEMORY:/.test(sys), 'memory rule must ride when the MCP mounts');
      assert(/mcp__troth-substrate__troth_recall/.test(sys), 'must name the real recall id');
      assert(/mcp__troth-substrate__troth_engram_record/.test(sys), 'must name the write path too');
      assert(/never open ~\/\.troth\/state\.db/.test(sys), 'must forbid the raw sqlite road the incident took');
      assert(!sys.includes('—'), 'no em-dash in authored strings');
    } finally {
      if (saved === undefined) delete process.env.TROTH_CLAUDE_MCP; else process.env.TROTH_CLAUDE_MCP = saved;
    }
  });

  test('MEMORY-RULE-2: without the MCP, the rule stays out (never name tools that are not mounted)', () => {
    const saved = process.env.TROTH_CLAUDE_MCP;
    delete process.env.TROTH_CLAUDE_MCP;
    try {
      const sys = appended({ user: 'x' });
      assert(!/troth_recall/.test(sys), 'unmounted tools must go unnamed: ' + JSON.stringify(sys.slice(0, 120)));
    } finally {
      if (saved === undefined) delete process.env.TROTH_CLAUDE_MCP; else process.env.TROTH_CLAUDE_MCP = saved;
    }
  });

  // ── Advert suppression (audit: the backbone prompt shipped 41
  // native-loop tool names — Bash/Read/engram_search… — that do not exist in
  // the harness, while the mcp__troth-substrate__* tools that DO exist went
  // unnamed). troth-entity passes available_tools: [] for the claude_cli
  // faculty; this pins what an empty list renders.
  test('NATIVE-ADVERT-1: an empty available_tools renders no tool advert at all', () => {
    const { buildSystemPrompt } = require('../shared-core/tools/system-prompt.js');
    const sys = String(buildSystemPrompt({ agent_id: 'test', cwd: process.cwd(), available_tools: [], audio: false }));
    assert(!/Use Bash for one-shot commands/.test(sys), 'the tool-usage advert must not ride an empty list');
    assert(!/engram_search|hashline/.test(sys), 'no phantom tool names');
    // The style + honesty guards are tool-independent and must survive.
    assert(/Style: direct, factual/.test(sys), 'style guard rides regardless of tools');
    assert(/Honesty: you have NO background execution/.test(sys), 'honesty guard rides regardless of tools');
  });
};
