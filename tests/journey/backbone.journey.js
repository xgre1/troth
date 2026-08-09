// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The Claude-Code backbone, executed — not just derived. coherence.journey
// proves the machine DECIDES the right shape; this proves the entity then
// RUNS it: the operator's stored model pick reaches --model, the substrate
// MCP is mounted (strict), the memory rule rides the prompt, the walls are
// provisioned into the faculty home, and the served/usage frames the app
// renders carry the truth back. Every one of these was a reported incident
// on 2026-08-09 ("picked Fable, served Opus"; "no MCP, cd/cat spelunking";
// "no usage on the one lane a subscription user runs").
//
// The trick that makes it testable on any target with zero subscription
// cost: a stub `claude` at <home>/.claude/local/claude — a real install
// location the resolver probes, inside the fresh HOME so docker passes
// identically. The stub RECORDS its argv and answers valid stream-json
// (assistant + success result with cache-column usage), so the whole spawn
// contract is asserted from the outside, the way the incidents happened.
module.exports.describe = 'the backbone serves the picked model, mounts its memory, and wears its walls';

const fs = require('fs');
const path = require('path');

module.exports.run = async (ctx, check) => {
  // The stub: node shebang (node is the product's own runtime on every
  // target), dumps argv, emits one assistant turn + a success result whose
  // usage exercises the cache-column summing the context meter relies on.
  const stubDir = path.join(ctx.home, '.claude', 'local');
  fs.mkdirSync(stubDir, { recursive: true });
  const argvDump = path.join(ctx.home, '.troth', 'claude-argv.json');
  fs.writeFileSync(path.join(stubDir, 'claude'), [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    'fs.writeFileSync(' + JSON.stringify(argvDump) + ', JSON.stringify(process.argv.slice(2)));',
    'const i = process.argv.indexOf("--model");',
    'const model = i > 0 ? process.argv[i + 1] : "claude-default";',
    'process.stdout.write(JSON.stringify({ type: "assistant", message: { model: model, content: [{ type: "text", text: "backbone stub reply" }] } }) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 12, cache_read_input_tokens: 41000, cache_creation_input_tokens: 900, output_tokens: 7 }, modelUsage: { [model]: { contextWindow: 1000000 } } }) + "\\n");',
    ''
  ].join('\n'));
  fs.chmodSync(path.join(stubDir, 'claude'), 0o755);

  // The operator's durable pick, exactly where Settings writes it.
  ctx.writeConfig({ providers: { anthropic: { enabled: true, model: 'claude-fable-5' } } });

  const { events } = await ctx.daemon([ctx.say('Say hello please.', 'jb')], {
    env: {
      // The shape the app/derive hands over (coherence.journey owns HOW it
      // is decided; this journey owns what happens NEXT).
      TROTH_ENTITY_BACKBONE: 'claude_cli',
      // Keep the machine's real claude out of it — but keep NODE reachable:
      // the stub's shebang needs the runtime, and the runtime's home
      // differs per target (homebrew on a dev Mac, /usr/local in docker,
      // the bundle's own dir on the dmg). The dir of the node running THIS
      // journey is correct on all three by construction.
      PATH: stubDir + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin',
    },
    settleMs: 15000, timeoutMs: 90000,
  });

  const kinds = events.map((e) => e.kind);
  check('the daemon came up and answered', kinds.includes('ready') && kinds.includes('response'),
    'kinds=' + kinds.slice(0, 12).join(','));

  const dispatch = events.find((e) => e.kind === 'dispatch');
  check('the turn dispatched to the claude_cli backbone', !!dispatch && dispatch.faculty === 'claude_cli',
    JSON.stringify(dispatch));

  const served = events.find((e) => e.kind === 'served' || e.kind === 'serving');
  check('the served frame names the PICKED model (the Fable-not-Opus incident)',
    !!served && served.model === 'claude-fable-5', JSON.stringify(served));

  const resp = events.find((e) => e.kind === 'response');
  check('the reply text made it back through the harness parser',
    !!resp && /backbone stub reply/.test(String(resp.text || '')), JSON.stringify(resp && { text: resp.text }));
  check('usage rode home with the cache columns summed (the meter\'s truth: 12+41000+900)',
    !!resp && resp.usage && resp.usage.context_used === 41912 && resp.usage.context_window === 1000000,
    JSON.stringify(resp && resp.usage));

  let argv = [];
  try { argv = JSON.parse(fs.readFileSync(argvDump, 'utf8')); } catch (_) {}
  const flat = argv.join(' ');
  check('the spawn carried --model with the stored pick', /--model claude-fable-5/.test(flat), flat.slice(0, 200));
  check('the substrate MCP was mounted, strictly (memory tools exist for real)',
    /--mcp-config/.test(flat) && /troth-substrate/.test(flat) && /--strict-mcp-config/.test(flat),
    flat.slice(0, 300));
  const sys = argv[argv.indexOf('--append-system-prompt') + 1] || '';
  check('the memory rule rode the prompt (troth_recall FIRST, never state.db)',
    /troth_recall/.test(sys) && /state\.db/.test(sys), sys.slice(0, 200));

  // The walls: every claude_cli spawn provisions the faculty home's own
  // PreToolUse gate — the surface both incidents actually ran on.
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(ctx.home, '.troth', 'claude-faculty-home', 'settings.json'), 'utf8')); } catch (_) {}
  check('the faculty home wears the bash gate (the walls exist where the incidents happened)',
    !!settings && JSON.stringify(settings).includes('faculty-bash-gate.mjs'),
    settings ? JSON.stringify(settings).slice(0, 200) : 'no settings.json');
};
