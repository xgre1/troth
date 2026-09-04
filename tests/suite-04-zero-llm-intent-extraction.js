// SPDX-License-Identifier: AGPL-3.0-only
// Auto-split from tests/test-all.js (verbatim section bodies; order preserved).
// Sections: Zero-LLM intent extraction + capture hook + edge auto-create | Cost attribution graph | Negative-knowledge substrate | Counterfactual replay | TOON wire format | TRON for nested DAGs | Schema Reflector | PHASE CH: Chameleo
module.exports = function run({ test }) {
const assert = require('assert');
const dedup = require('../proxy/modules/dedup');
const { record, getRecent } = require('../proxy/modules/perflog');
const { probe } = require('../proxy/modules/health');
const audit = require('../proxy/modules/audit');
// --- Zero-LLM intent extraction + capture hook + edge auto-create ---
console.log('\nP16 Tier 2 — intent extraction + capture hook + edge auto-create:');
(function runP16T2Tests() {
  const E = require('../shared-core/intent-extract');

  // ── Extraction (8 tests) ────────────────────────────────────────────────
  test('P16-T2.X1: extract goal + verb + object from happy-path prompt', () => {
    const r = E.extractIntent('Add OAuth login to the auth service. Must not break existing API.');
    assert.strictEqual(r.ok, true);
    assert.ok(r.confidence >= 0.9, 'confidence: ' + r.confidence);
    assert.ok(r.intent.input.goal.startsWith('add '), 'goal: ' + r.intent.input.goal);
    assert.ok(r.intent.input.constraint && r.intent.input.constraint.length > 0);
  });

  test('P16-T2.X2: short prompt rejected as too_short', () => {
    const r = E.extractIntent('do it');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'too_short');
  });

  test('P16-T2.X3: slash command rejected', () => {
    const r = E.extractIntent('/help me with this codebase navigation');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'slash_command');
  });

  test('P16-T2.X4: chitchat (yes/thanks) rejected', () => {
    for (const s of ['yes', 'thanks', 'continue', 'ok cool', 'nope']) {
      const r = E.extractIntent(s);
      assert.strictEqual(r.ok, false, 'should reject: ' + s);
    }
  });

  test('P16-T2.X5: detect "without breaking" constraint', () => {
    const r = E.extractIntent('Refactor the user query without breaking the public API signature in src/db.ts');
    assert.strictEqual(r.ok, true);
    const cs = (r.intent.input.constraint || []).join(' ');
    assert.ok(/without\s+breaking/i.test(cs), 'constraints: ' + cs);
  });

  test('P16-T2.X6: detect file path → acceptance_criteria', () => {
    const r = E.extractIntent('Implement task manager CRUD endpoints in src/api/tasks.ts');
    assert.strictEqual(r.ok, true);
    assert.ok((r.intent.input.acceptance_criteria || '').includes('src/api/tasks.ts'));
  });

  test('P16-T2.X7: detect alternatives via "or"', () => {
    const r = E.extractIntent('Wire the proxy fallback chain. Either DeepSeek-V3 or Qwen3-Max as default.');
    assert.strictEqual(r.ok, true);
    const alts = r.intent.output.alternatives_considered || [];
    assert.ok(alts.length > 0, 'no alternatives detected: ' + JSON.stringify(alts));
  });

  test('P16-T2.X8: noun-only prompts capture as fallback intents (language-agnostic)', () => {
    //  redesign: extract no longer hard-rejects on missing
    // English verb/object. Instead it falls back to using the cleaned
    // prompt as the goal at conf=0.7 with extraction='fallback_no_verb'.
    // This is what unblocks Greek / greeklish / mixed-language prompts.
    const r = E.extractIntent('the codebase appears to have several modules and they each handle different concerns');
    assert.ok(r.ok, 'fallback intent should be ok=true');
    assert.strictEqual(r.confidence, 0.7, 'fallback confidence is fixed at 0.7');
    assert.strictEqual(r.intent.input.extraction, 'fallback_no_verb',
      'tag must mark this as a fallback so consumers can distinguish quality');
  });

  // ── Hook integration (3 tests) ──────────────────────────────────────────
  // We exercise the hook by spawning it as the plugin would, with a
  // mocked stdin payload + an isolated CLAUDE_PLUGIN_DATA dir.
  const pT2  = require('path');
  const fsT2 = require('fs');
  const cpT2 = require('child_process');
  const REPO = pT2.resolve(__dirname, '..');

  function runHook(scriptRel, payload, env) {
    const scriptPath = pT2.join(REPO, scriptRel);
    const child = cpT2.spawnSync('node', [scriptPath], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, env || {}, {
        CLAUDE_PLUGIN_ROOT: pT2.join(REPO, 'plugin'),
        CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA
      }),
      timeout: 5000, encoding: 'utf8'
    });
    return { stdout: child.stdout, stderr: child.stderr, status: child.status };
  }

  function makeTmp(prefix) {
    const d = pT2.join(require('os').tmpdir(), prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    fsT2.mkdirSync(d, { recursive: true });
    return d;
  }

  test('P16-T2.H1: capture hook ON by default — explicit TROTH_CAPTURE_INTENT=0 disables it', () => {
    // capture now defaults ON via shared-core/features.js so a
    // FRESH install (no shell.zshrc / no env) gets the partner's intelligence.
    // '' is treated as unset → built-in default ON; '0' is the explicit opt-out.
    // TROTH_CONFIG_PATH is pointed at a nonexistent file so the config layer is
    // neutralized and we exercise the built-in default + env precedence only.
    const NOCFG = require('os').tmpdir() + '/troth-nonexistent-config-' + Date.now() + '.json';
    const countIntents = (tmp, sess) => {
      delete require.cache[require.resolve('../shared-core/state')];
      process.env.CLAUDE_PLUGIN_DATA = tmp;
      const ls = require('../shared-core/state');
      const n = ls.countActions({ type: 'intent', session_id: sess });
      ls.close && ls.close();
      delete require.cache[require.resolve('../shared-core/state')];
      try { fsT2.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      return n;
    };

    // (a) DEFAULT (env unset) → captures
    const tmpOn = makeTmp('gc-p16t2-h1-on');
    const sessOn = 'sess-h1on-' + Date.now();
    runHook('plugin/hooks/intent-capture.mjs', {
      cwd: tmpOn, session_id: sessOn, user_prompt: 'Refactor the auth middleware to extract the callback handler. Tests must pass.'
    }, { CLAUDE_PLUGIN_DATA: tmpOn, TROTH_CAPTURE_INTENT: '', TROTH_CONFIG_PATH: NOCFG });
    const nOn = countIntents(tmpOn, sessOn);
    assert.ok(nOn >= 1, 'capture ON by default — should have written >=1 intent, got ' + nOn);

    // (b) EXPLICIT disable (=0) → no capture
    const tmpOff = makeTmp('gc-p16t2-h1-off');
    const sessOff = 'sess-h1off-' + Date.now();
    runHook('plugin/hooks/intent-capture.mjs', {
      cwd: tmpOff, session_id: sessOff, user_prompt: 'Refactor the auth middleware to extract the callback handler. Tests must pass.'
    }, { CLAUDE_PLUGIN_DATA: tmpOff, TROTH_CAPTURE_INTENT: '0', TROTH_CONFIG_PATH: NOCFG });
    const nOff = countIntents(tmpOff, sessOff);
    assert.strictEqual(nOff, 0, 'explicit TROTH_CAPTURE_INTENT=0 — should have written 0 intents, got ' + nOff);
  });

  test('P16-T2.H2: capture hook ON + valid prompt → intent record persisted', () => {
    const tmp = makeTmp('gc-p16t2-h2');
    const sess = 'sess-h2-' + Date.now();
    const prompt = 'Refactor the auth middleware to extract the callback handler. Tests must pass.';
    runHook('plugin/hooks/intent-capture.mjs', {
      cwd: tmp, session_id: sess, user_prompt: prompt
    }, { CLAUDE_PLUGIN_DATA: tmp, TROTH_CAPTURE_INTENT: '1' });
    delete require.cache[require.resolve('../shared-core/state')];
    process.env.CLAUDE_PLUGIN_DATA = tmp;
    const localState = require('../shared-core/state');
    const rows = localState.queryActions({ type: 'intent', session_id: sess });
    localState.close && localState.close();
    delete require.cache[require.resolve('../shared-core/state')];
    try { fsT2.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    assert.strictEqual(rows.length, 1, 'should have persisted 1 intent, got ' + rows.length);
    const inp = JSON.parse(rows[0].input);
    assert.ok(inp.goal && inp.goal.startsWith('refactor'), 'goal mismatch: ' + inp.goal);
    assert.ok(inp.source_message_hash && inp.source_message_hash.startsWith('sha256:'));
  });

  test('P16-T2.H3: confidence-gate rejects only when prompt is below MIN_CONFIDENCE', () => {
    //  redesign: fallback intents pass at conf=0.7 (above the
    // default 0.6 gate) so multilingual prompts make it into the
    // substrate. To exercise the gate we set MIN_CONFIDENCE=0.8 so the
    // fallback intent (0.7) gets correctly skipped.
    const tmp = makeTmp('gc-p16t2-h3');
    const sess = 'sess-h3-' + Date.now();
    runHook('plugin/hooks/intent-capture.mjs', {
      cwd: tmp, session_id: sess,
      user_prompt: 'the system seems complicated and there are many considerations to think about here'
    }, { CLAUDE_PLUGIN_DATA: tmp, TROTH_CAPTURE_INTENT: '1', TROTH_INTENT_MIN_CONF: '0.8' });
    delete require.cache[require.resolve('../shared-core/state')];
    process.env.CLAUDE_PLUGIN_DATA = tmp;
    const localState = require('../shared-core/state');
    const n = localState.countActions({ type: 'intent', session_id: sess });
    localState.close && localState.close();
    delete require.cache[require.resolve('../shared-core/state')];
    try { fsT2.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    assert.strictEqual(n, 0,
      'fallback (0.7) is below explicit 0.8 gate, must be skipped; got ' + n + ' intents');
  });

  // ── Edge auto-creation (2 tests) — direct unit check via state API ─────
  // We don't exercise the post-action-recall hook end-to-end (that would
  // require simulating mark-edit's prior write); instead verify the edge-
  // creation logic the hook would perform.
  test('P16-T2.E1: produces_edit edge writes from intent → edit', () => {
    const tmp = makeTmp('gc-p16t2-e1');
    process.env.CLAUDE_PLUGIN_DATA = tmp;
    delete require.cache[require.resolve('../shared-core/state')];
    const s = require('../shared-core/state');
    const AR = require('../shared-core/action-record');
    const intent = AR.create({
      type: 'intent', agent_id: 'cc', cwd: tmp,
      input: { goal: 'refactor auth.ts', source_message_hash: 'h' },
      output: { chosen_path: 'extract callback' }
    });
    const edit = AR.create({
      type: 'edit', agent_id: 'cc', cwd: tmp,
      input: { file_path: 'auth.ts', format: 'hashline' },
      output: { hash_after: 'abc' },
      verification: { ast: { ok: true }, tests: { ok: true } }
    });
    s.recordAction(intent); s.recordAction(edit);
    const eid = s.recordEdge({ from_id: intent.id, to_id: edit.id, label: 'produces_edit', weight: 0.7 });
    const sid = s.recordEdge({ from_id: edit.id, to_id: intent.id, label: 'satisfies', weight: 1.0 });
    s.close && s.close();
    delete require.cache[require.resolve('../shared-core/state')];
    try { fsT2.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    assert.ok(eid && eid.length === 36);
    assert.ok(sid && sid.length === 36);
  });

  test('P16-T2.E2: satisfies edge requires verification.ast.ok (logic check)', () => {
    // Mirror the conditional in post-action-recall.mjs: AST must be ok
    // AND tests must not have explicit ok:false.
    const failingAst = { ast: { ok: false }, tests: { ok: true } };
    const failingTests = { ast: { ok: true }, tests: { ok: false } };
    const passing = { ast: { ok: true }, tests: { ok: true } };
    const passingNoTests = { ast: { ok: true } };
    function shouldSatisfy(v) {
      const astOk = v.ast && v.ast.ok === true;
      const testsOk = !v.tests || v.tests.ok !== false;
      return astOk && testsOk;
    }
    assert.strictEqual(shouldSatisfy(failingAst), false);
    assert.strictEqual(shouldSatisfy(failingTests), false);
    assert.strictEqual(shouldSatisfy(passing), true);
    assert.strictEqual(shouldSatisfy(passingNoTests), true);
  });

  // ── Marker (2 tests) ────────────────────────────────────────────────────
  test('P16-T2.M1: buildManifest emits intent: prefix for type=intent entries', () => {
    const tmp = makeTmp('gc-p16t2-m1');
    process.env.CLAUDE_PLUGIN_DATA = tmp;
    delete require.cache[require.resolve('../shared-core/state')];
    delete require.cache[require.resolve('../shared-core/working-set')];
    delete require.cache[require.resolve('../shared-core/runtime')];
    const s = require('../shared-core/state');
    const AR = require('../shared-core/action-record');
    const ws = require('../shared-core/working-set');
    const rt = require('../shared-core/runtime');
    const sess = 'sess-m1';
    const i = AR.create({
      type: 'intent', agent_id: 'cc', session_id: sess, cwd: tmp,
      input: { goal: 'add OAuth', source_message_hash: 'h' },
      output: { chosen_path: 'use Auth0' }
    });
    s.recordAction(i, AR.toSearchText(i));
    ws.openSession(s, { session_id: sess, agent_id: 'cc', cwd: tmp });
    ws.load(s, sess, i.id);
    const m = rt.buildManifest(sess);
    s.close && s.close();
    delete require.cache[require.resolve('../shared-core/state')];
    delete require.cache[require.resolve('../shared-core/working-set')];
    delete require.cache[require.resolve('../shared-core/runtime')];
    try { fsT2.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    assert.ok(m && m.text, 'manifest empty');
    assert.ok(m.text.includes('<troth:intent:' + i.id + '>'),
      'expected intent: marker, got: ' + m.text);
  });

  test('F17a: hooks.json — mark-edit + post-action-recall MUST be in the SAME PostToolUse matcher entry for Edit/Write/MultiEdit, sequential', () => {
    // Regression for the live edge-creation bug found: hooks
    // in DIFFERENT matcher entries within PostToolUse run in PARALLEL,
    // not sequentially. Even with mark-edit's matcher entry listed first
    // in the array, post-action-recall (in a later matcher entry) raced
    // it and queried for the edit row before mark-edit had committed it,
    // leaving 0 produces_edit/satisfies edges. The earlier "F17a array-
    // index check" was based on a wrong assumption about CC's PostToolUse
    // dispatch model. Real fix: put both hooks in the SAME entry's
    // hooks[] array — those DO run sequentially in the documented order.
    const fsX = require('fs');
    const pX  = require('path');
    const hjPath = pX.resolve(__dirname, '..', 'plugin/hooks/hooks.json');
    const hj = JSON.parse(fsX.readFileSync(hjPath, 'utf8'));
    const ptu = hj.hooks.PostToolUse || [];
    let foundEntry = null;
    for (const entry of ptu) {
      const matcher = entry.matcher || '';
      if (!/Edit|Write|MultiEdit|NotebookEdit/.test(matcher)) continue;
      const cmds = (entry.hooks || []).map(h => h.command || '');
      const hasMarkEdit = cmds.findIndex(c => /mark-edit\.mjs/.test(c));
      const hasRecall   = cmds.findIndex(c => /post-action-recall\.mjs/.test(c));
      if (hasMarkEdit >= 0 && hasRecall >= 0) {
        foundEntry = { matcher, markEditIdx: hasMarkEdit, recallIdx: hasRecall };
        break;
      }
    }
    assert.ok(foundEntry,
      'BUG: mark-edit and post-action-recall must be co-located in one PostToolUse matcher entry for Edit/Write/MultiEdit/NotebookEdit. Without this they race in parallel and edges never get created.');
    assert.ok(foundEntry.markEditIdx < foundEntry.recallIdx,
      'BUG: within the shared matcher entry, mark-edit must precede post-action-recall in hooks[]. Got markEdit=' + foundEntry.markEditIdx + ', recall=' + foundEntry.recallIdx);
  });

  test('F31: MCP servers must NOT respond to JSON-RPC notifications (no `id`)', () => {
    // Regression for the bug where Claude Code's MCP host saw all 5
    // plugin:troth:* servers as ✗ failed: each server replied to the
    // post-handshake `notifications/initialized` notification with a
    // JSON-RPC frame whose `id` was undefined, which CC's Zod schema
    // rejected → STDIO transport dropped after 0s uptime. Per JSON-RPC 2.0
    // §4.1, a notification (no `id`) MUST NOT receive a response.
    const cpF31 = require('child_process');
    const pF31  = require('path');
    const REPO  = pF31.resolve(__dirname, '..');
    const SERVERS = ['troth-memory', 'troth-bash', 'troth-cache', 'troth-router', 'troth-hashline'];
    const stdin = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      ''
    ].join('\n');
    for (const s of SERVERS) {
      const r = cpF31.spawnSync('node',
        [pF31.join(REPO, 'plugin/mcp-servers', s, 'server.mjs')],
        { input: stdin, timeout: 8000, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, s + ' exited non-zero: ' + r.stderr);
      const lines = r.stdout.split('\n').filter(l => l.trim());
      const frames = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      // Exactly two JSON-RPC responses: id=1 (initialize), id=2 (tools/list).
      // The notification must NOT have produced a response.
      assert.strictEqual(frames.length, 2, s + ' emitted ' + frames.length + ' frames; expected 2 (initialize + tools/list, NO reply for notification). Frames: ' + JSON.stringify(frames));
      assert.deepStrictEqual(frames.map(f => f.id).sort(), [1, 2], s + ' returned wrong ids: ' + JSON.stringify(frames.map(f => f.id)));
      for (const f of frames) {
        assert.ok(f.id !== undefined && f.id !== null,
          s + ' emitted frame with missing id: ' + JSON.stringify(f));
      }
    }
  });

  test('F17: end-to-end hook chain — intent-capture + mark-edit + post-action-recall produces both edges', () => {
    // Spawns the real plugin hooks in sequence, simulating one full
    // CC turn:
    //   1. UserPromptSubmit → intent-capture writes type='intent'.
    //   2. PostToolUse(Edit) → mark-edit writes type='edit' with parent_id.
    //   3. PostToolUse(Edit) → post-action-recall sees the edit, finds the
    //      matching intent, writes produces_edit + satisfies edges.
    // Verifies the substrate ends with all 4 records (intent, edit, 2
    // edges) — locking in the F17 contract.
    const cpF17 = require('child_process');
    const fsF17 = require('fs');
    const pF17  = require('path');
    const tmp = pF17.join(require('os').tmpdir(), 'gc-f17-' + Date.now());
    fsF17.mkdirSync(tmp, { recursive: true });
    const REPO = pF17.resolve(__dirname, '..');
    const PLUGIN = pF17.join(REPO, 'plugin');
    const sess = 'sess-f17-' + Date.now();
    const filePath = pF17.join(tmp, 'auth.ts');
    fsF17.writeFileSync(filePath, 'export function login() { return null; }\n', 'utf8');

    const env = Object.assign({}, process.env, {
      CLAUDE_PLUGIN_ROOT: PLUGIN,
      CLAUDE_PLUGIN_DATA: tmp,
      TROTH_CAPTURE_INTENT: '1'
    });

    function runHook(rel, payload) {
      return cpF17.spawnSync('node', [pF17.join(PLUGIN, rel)],
        { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 5000 });
    }

    // 1. UserPromptSubmit — intent-capture
    const r1 = runHook('hooks/intent-capture.mjs', {
      cwd: tmp, session_id: sess,
      user_prompt: 'Refactor ' + filePath + ' to extract the OAuth callback handler. Tests must pass.'
    });
    assert.strictEqual(r1.status, 0, 'intent-capture stderr: ' + r1.stderr);

    // 2. PostToolUse — mark-edit
    const r2 = runHook('hooks/mark-edit.mjs', {
      cwd: tmp, session_id: sess,
      tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: 'null', new_string: 'undefined' },
      tool_response: { lines_changed: 1 }
    });
    assert.strictEqual(r2.status, 0, 'mark-edit stderr: ' + r2.stderr);

    // 3. PostToolUse — post-action-recall
    const r3 = runHook('hooks/post-action-recall.mjs', {
      cwd: tmp, session_id: sess,
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
      tool_response: { lines_changed: 1 }
    });
    assert.strictEqual(r3.status, 0, 'post-action-recall stderr: ' + r3.stderr);

    // Inspect substrate state
    delete require.cache[require.resolve('../shared-core/state')];
    process.env.CLAUDE_PLUGIN_DATA = tmp;
    const localState = require('../shared-core/state');

    const intents = localState.queryActions({ type: 'intent', session_id: sess });
    assert.strictEqual(intents.length, 1, 'expected 1 intent, got ' + intents.length);

    const edits = localState.queryActions({ type: 'edit', session_id: sess });
    assert.strictEqual(edits.length, 1, 'expected 1 edit, got ' + edits.length);

    const producesEdges = localState.queryEdges({
      from_id: intents[0].id, to_id: edits[0].id, label: 'produces_edit'
    });
    assert.strictEqual(producesEdges.length, 1, 'expected produces_edit edge, got ' + producesEdges.length);

    // satisfies edge requires verification.ast.ok === true. mark-edit wrote
    // the verification slot from verifyAST on the real file content. JS/TS
    // file with valid syntax → ok:true → satisfies should be present.
    const satisfiesEdges = localState.queryEdges({
      from_id: edits[0].id, to_id: intents[0].id, label: 'satisfies'
    });
    assert.ok(satisfiesEdges.length >= 1, 'expected satisfies edge (ast.ok=true), got ' + satisfiesEdges.length);

    localState.close && localState.close();
    delete require.cache[require.resolve('../shared-core/state')];
    try { fsF17.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  test('P16-T2.M2: extractor never returns null intent on ok:true (sanity)', () => {
    const samples = [
      'Add a /health endpoint to the Express server',
      'Fix the timeout bug in the proxy router',
      'Wire the keepalive module into request handling'
    ];
    for (const s of samples) {
      const r = E.extractIntent(s);
      if (r.ok) {
        assert.ok(r.intent && r.intent.input && r.intent.input.goal,
          'extractor returned ok=true with empty intent for: ' + s);
      }
    }
  });
})();

// --- Cost attribution graph ---
console.log('\nP16.5 I2 — cost attribution graph:');
(function runP165I2Tests() {
  const pI2  = require('path');
  const fsI2 = require('fs');
  const TMP_I2 = pI2.join(require('os').tmpdir(), 'gc-invariant-i2-' + Date.now());
  fsI2.mkdirSync(TMP_I2, { recursive: true });
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_I2;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/cost')];
  const AR    = require('../shared-core/action-record');
  const state = require('../shared-core/state');
  const Cost  = require('../shared-core/cost');

  // Build a fresh scenario for this suite:
  //   intent → e1 (verified, $0.012) + e2 (verified, $0.018) + e3 (failed, $0.005 estimate)
  const intent = AR.create({
    type: 'intent', agent_id: 'cc', cwd: '/p',
    input: { goal: 'add oauth', source_message_hash: 'h' },
    output: { chosen_path: 'use Auth0' }
  });
  const e1 = AR.create({
    type: 'edit', agent_id: 'cc', cwd: '/p', parent_id: intent.id,
    input: { file_path: 'auth.ts', format: 'h' },
    output: { hash_after: 'a' },
    verification: { ast: { ok: true }, tests: { ok: true } }
  });
  const e2 = AR.create({
    type: 'edit', agent_id: 'cc', cwd: '/p', parent_id: intent.id,
    input: { file_path: 'callback.ts', format: 'h' },
    output: { hash_after: 'b' },
    verification: { ast: { ok: true }, tests: { ok: true } }
  });
  const e3 = AR.create({
    type: 'edit', agent_id: 'cc', cwd: '/p', parent_id: intent.id,
    input: { file_path: 'broken.ts', format: 'h' },
    output: { hash_after: 'c' },
    verification: { ast: { ok: false } }
  });
  state.recordAction(intent);
  state.recordAction(e1);
  state.recordAction(e2);
  state.recordAction(e3);
  Cost.recordCost(state, e1.id, 'proxy',
    { input_tokens: 1500, output_tokens: 300, usd: 0.012, model: 'qwen3-max', provider: 'alibaba', source: 'measured', cwd: '/p' });
  Cost.recordCost(state, e2.id, 'proxy',
    { input_tokens: 2200, output_tokens: 450, usd: 0.018, model: 'qwen3-max', provider: 'alibaba', source: 'measured', cwd: '/p' });
  Cost.recordCost(state, e3.id, 'plugin',
    { input_tokens: 800, output_tokens: 120, usd: 0.005, model: 'sonnet', provider: 'anthropic', source: 'estimate', cwd: '/p' });

  test('I2.C1: getCost returns folded view with bySource breakdown', () => {
    const c = Cost.getCost(state, e1.id);
    assert.ok(c, 'getCost returned null');
    assert.strictEqual(c.usd, 0.012);
    assert.strictEqual(c.input_tokens, 1500);
    assert.strictEqual(c.authoritative, 'measured');
    assert.ok(c.by_source.measured);
  });

  test('I2.C2: getCost returns null for action with no cost events', () => {
    assert.strictEqual(Cost.getCost(state, intent.id), null);
  });

  test('I2.C3: recordCost rejects malformed inputs cleanly', () => {
    assert.strictEqual(Cost.recordCost(state, null, 'agent', {}), null);
    assert.strictEqual(Cost.recordCost(state, e1.id, null, {}), null);
    assert.strictEqual(Cost.recordCost(state, e1.id, 'agent', null), null);
    // NaN usd → coerced to 0, not rejected
    const id = Cost.recordCost(state, e1.id, 'agent', { usd: NaN, source: 'test' });
    assert.ok(id);
  });

  test('I2.A1: attributeCost sums cost across descendant subtree', () => {
    const att = Cost.attributeCost(state, intent.id);
    assert.ok(att);
    // 0.012 + 0.018 + 0.005 = 0.035 (with floating-point tolerance)
    assert.ok(Math.abs(att.total_usd - 0.035) < 1e-9, 'usd: ' + att.total_usd);
    assert.strictEqual(att.total_input_tokens, 4500);
    assert.strictEqual(att.total_output_tokens, 870);
    assert.strictEqual(att.confidence, 'mixed');
  });

  test('I2.A2: attributeCost by_type buckets exclude cost_event records', () => {
    const att = Cost.attributeCost(state, intent.id);
    assert.ok(!('cost_event' in att.by_type), 'cost_event should not be a bucket');
    assert.strictEqual(att.by_type.intent, 1);
    assert.strictEqual(att.by_type.edit, 3);
  });

  test('I2.A3: attributeCost confidence pure-measured when no estimates', () => {
    const localIntent = AR.create({
      type: 'intent', agent_id: 'cc', cwd: '/p2',
      input: { goal: 'fix bug', source_message_hash: 'h2' },
      output: { chosen_path: 'patch' }
    });
    const localEdit = AR.create({
      type: 'edit', agent_id: 'cc', cwd: '/p2', parent_id: localIntent.id,
      input: { file_path: 'x.ts', format: 'h' },
      output: { hash_after: 'x' },
      verification: { ast: { ok: true } }
    });
    state.recordAction(localIntent);
    state.recordAction(localEdit);
    Cost.recordCost(state, localEdit.id, 'proxy',
      { input_tokens: 500, output_tokens: 100, usd: 0.004, model: 'qwen3-max', source: 'measured', cwd: '/p2' });
    const att = Cost.attributeCost(state, localIntent.id);
    assert.strictEqual(att.confidence, 'measured');
  });

  test('I2.A4: attributeCost handles intent with zero descendants', () => {
    const lonely = AR.create({
      type: 'intent', agent_id: 'cc', cwd: '/p3',
      input: { goal: 'something', source_message_hash: 'h3' },
      output: { chosen_path: 'tbd' }
    });
    state.recordAction(lonely);
    const att = Cost.attributeCost(state, lonely.id);
    assert.strictEqual(att.total_usd, 0);
    assert.strictEqual(att.confidence, 'no_cost_data');
  });

  test('I2.L1: costByIntent returns intents sorted by total_usd desc', () => {
    const list = Cost.costByIntent(state, { cwd: '/p' });
    assert.ok(list.length >= 1);
    assert.strictEqual(list[0].intent_id, intent.id);
    assert.ok(Math.abs(list[0].total_usd - 0.035) < 1e-9);
    assert.ok(list[0].goal.includes('oauth'));
  });

  test('I2.F1: costOfFailure isolates AST/tests-failed actions', () => {
    const f = Cost.costOfFailure(state, { cwd: '/p' });
    assert.strictEqual(f.action_count, 1, 'expected 1 failed action, got ' + f.action_count);
    assert.ok(Math.abs(f.total_usd - 0.005) < 1e-9, 'usd: ' + f.total_usd);
  });

  test('I2.F2: costOfFailure excludes verified-pass edits', () => {
    // /p2's edit is verified pass — should NOT show up in failure cost.
    const f = Cost.costOfFailure(state, { cwd: '/p2' });
    assert.strictEqual(f.action_count, 0);
    assert.strictEqual(f.total_usd, 0);
  });

  test('I2.P1: recordCostForActiveSession links to most-recent linkable action', () => {
    // Stamp plugin presence so the helper finds an active session.
    const presenceSess = 'sess-i2-proxy-' + Date.now();
    state.db().prepare(`
      INSERT OR REPLACE INTO plugin_presence (id, last_seen_ts, session_id, plugin_version)
      VALUES (1, ?, ?, NULL)
    `).run(Date.now(), presenceSess);

    const tc = AR.create({
      type: 'tool_call', agent_id: 'cc', session_id: presenceSess, cwd: '/p4',
      input: { tool_name: 'Bash' }, output: { status: 'ok' }
    });
    state.recordAction(tc);

    const eid = Cost.recordCostForActiveSession(state, 'proxy', {
      input_tokens: 1000, output_tokens: 200, usd: 0.008,
      model: 'qwen-max', provider: 'alibaba', source: 'measured'
    });
    assert.ok(eid, 'should have written cost_event');
    const c = Cost.getCost(state, tc.id);
    assert.ok(c);
    assert.strictEqual(c.usd, 0.008);
  });

  test('I2.P2: recordCostForActiveSession returns null when no plugin active', () => {
    // Wipe presence row so isPluginActive returns false.
    state.db().prepare('UPDATE plugin_presence SET last_seen_ts = 0 WHERE id = 1').run();
    const eid = Cost.recordCostForActiveSession(state, 'proxy', {
      input_tokens: 100, output_tokens: 50, usd: 0.001, model: 'm', source: 'measured'
    });
    assert.strictEqual(eid, null, 'should skip when no plugin active');
  });

  // Cleanup
  process.env.CLAUDE_PLUGIN_DATA = savedEnv;
  setTimeout(() => {
    try { fsI2.rmSync(TMP_I2, { recursive: true, force: true }); } catch (_) {}
  }, 500).unref();
})();

// --- Negative-knowledge substrate ---
console.log('\nP16.5 I1 — negative-knowledge substrate:');
(function runP165I1Tests() {
  const pI1  = require('path');
  const fsI1 = require('fs');
  const TMP_I1 = pI1.join(require('os').tmpdir(), 'gc-invariant-i1-' + Date.now());
  fsI1.mkdirSync(TMP_I1, { recursive: true });
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_I1;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/avoided')];
  const AR    = require('../shared-core/action-record');
  const state = require('../shared-core/state');
  const Av    = require('../shared-core/avoided');

  test('I1.S1: avoided_path is in ALL_TYPES', () => {
    assert.ok(AR.ALL_TYPES.includes('avoided_path'));
  });

  test('I1.S2: avoided_path validate accepts well-formed record', () => {
    const r = AR.create({
      type: 'avoided_path', agent_id: 'cc',
      input: { fingerprint: 'abc123', reason_kind: 'critic_block' },
      output: { avoidance_text: 'critic blocked due to placeholder bail' }
    });
    const v = AR.validate(r);
    assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  });

  test('I1.S3: validate rejects missing fingerprint or reason_kind', () => {
    const v1 = AR.validate(AR.create({
      type: 'avoided_path', agent_id: 'cc',
      input: { reason_kind: 'critic_block' },
      output: { avoidance_text: 'x' }
    }));
    assert.strictEqual(v1.ok, false);
    const v2 = AR.validate(AR.create({
      type: 'avoided_path', agent_id: 'cc',
      input: { fingerprint: 'fp' },
      output: { avoidance_text: 'x' }
    }));
    assert.strictEqual(v2.ok, false);
  });

  test('I1.F1: fingerprint is deterministic across same inputs', () => {
    const a = Av.fingerprint('critic_block', ['placeholder', 'bail']);
    const b = Av.fingerprint('critic_block', ['placeholder', 'bail']);
    assert.strictEqual(a, b);
    assert.strictEqual(a.length, 16);
  });

  test('I1.F2: fingerprint differs when reason_kind differs', () => {
    const a = Av.fingerprint('critic_block', ['x']);
    const b = Av.fingerprint('loopbreaker', ['x']);
    assert.notStrictEqual(a, b);
  });

  test('I1.W1: recordAvoidance writes a valid avoided_path record', () => {
    const id = Av.recordAvoidance(state, {
      session_id: 's1', cwd: '/p',
      reason_kind: 'critic_block', signals: ['placeholder', 'bail'],
      avoidance_text: 'critic blocked: placeholder bail',
      suggest_instead: 'deliver substantive output'
    });
    assert.ok(id && id.length === 36);
    const row = state.getAction(id);
    assert.ok(row);
    assert.strictEqual(row.type, 'avoided_path');
  });

  test('I1.R1: getAvoidedPaths returns recent records dedup\'d by fingerprint', () => {
    // Write the SAME failure 3 times → only 1 should be returned.
    for (let i = 0; i < 3; i++) {
      Av.recordAvoidance(state, {
        session_id: 's1', cwd: '/p2',
        reason_kind: 'loopbreaker', signals: ['Edit', 'auth.ts'],
        avoidance_text: 'loop detected ' + i
      });
    }
    const out = Av.getAvoidedPaths(state, { cwd: '/p2' });
    assert.strictEqual(out.length, 1, 'expected 1 deduped record, got ' + out.length);
  });

  test('I1.R2: getAvoidedPaths filters by promptSignals (substring match)', () => {
    Av.recordAvoidance(state, {
      session_id: 's1', cwd: '/p3',
      reason_kind: 'critic_block', signals: ['oauth-handler'],
      avoidance_text: 'critic blocked: incomplete oauth flow'
    });
    Av.recordAvoidance(state, {
      session_id: 's1', cwd: '/p3',
      reason_kind: 'loopbreaker', signals: ['Bash', 'rm-rf'],
      avoidance_text: 'loop on dangerous bash'
    });
    const matched = Av.getAvoidedPaths(state, { cwd: '/p3', promptSignals: ['oauth'] });
    assert.strictEqual(matched.length, 1);
    assert.ok(matched[0].output.avoidance_text.includes('oauth'));
  });

  test('I1.R3: getAvoidedPaths respects ttl_ms (old records excluded)', () => {
    // Manually write a record with a past timestamp.
    const stale = AR.create({
      type: 'avoided_path', agent_id: 'cc', cwd: '/p4',
      input: { fingerprint: 'stale1', reason_kind: 'critic_block' },
      output: { avoidance_text: 'stale failure' }
    });
    stale.timestamp = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    state.recordAction(stale);
    const out = Av.getAvoidedPaths(state, { cwd: '/p4', ttl_ms: 14 * 24 * 60 * 60 * 1000 });
    assert.strictEqual(out.length, 0);
    const wide = Av.getAvoidedPaths(state, { cwd: '/p4', ttl_ms: 60 * 24 * 60 * 60 * 1000 });
    assert.strictEqual(wide.length, 1);
  });

  test('I1.U1: surfaceNegativePrecedent caps at maxChars', () => {
    const recs = [];
    for (let i = 0; i < 10; i++) {
      recs.push(AR.fromRow(AR.toRow(AR.create({
        type: 'avoided_path', agent_id: 'cc',
        input: { fingerprint: 'fp' + i, reason_kind: 'critic_block' },
        output: { avoidance_text: 'this is a fairly long avoidance message number ' + i + ' that should eventually overflow the budget' }
      }))));
    }
    const out = Av.surfaceNegativePrecedent(recs, { maxChars: 200 });
    assert.ok(out.length <= 200, 'expected ≤200 chars, got ' + out.length);
    assert.ok(out.includes('[troth/negative_precedent]'));
  });

  // Cleanup
  process.env.CLAUDE_PLUGIN_DATA = savedEnv;
  setTimeout(() => {
    try { fsI1.rmSync(TMP_I1, { recursive: true, force: true }); } catch (_) {}
  }, 500).unref();
})();

// --- Counterfactual replay ---
console.log('\nP16.5 I3 — counterfactual replay:');
(function runP165I3Tests() {
  const pI3  = require('path');
  const fsI3 = require('fs');
  const TMP_I3 = pI3.join(require('os').tmpdir(), 'gc-invariant-i3-' + Date.now());
  fsI3.mkdirSync(TMP_I3, { recursive: true });
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_I3;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/cost')];
  delete require.cache[require.resolve('../shared-core/counterfactual')];
  const AR    = require('../shared-core/action-record');
  const state = require('../shared-core/state');
  const Cost  = require('../shared-core/cost');
  const CF    = require('../shared-core/counterfactual');

  // Build: intent (with 2 alternatives) → 1 verified edit + cost
  const intent = AR.create({
    type: 'intent', agent_id: 'cc', cwd: '/p',
    input: { goal: 'add oauth', source_message_hash: 'h' },
    output: { chosen_path: 'use Auth0', alternatives_considered: ['use NextAuth', 'roll our own'] }
  });
  const edit = AR.create({
    type: 'edit', agent_id: 'cc', cwd: '/p', parent_id: intent.id,
    input: { file_path: 'auth.ts', format: 'h' },
    output: { hash_after: 'a' },
    verification: { ast: { ok: true } }
  });
  state.recordAction(intent);
  state.recordAction(edit);
  Cost.recordCost(state, edit.id, 'proxy', { usd: 0.020, input_tokens: 2000, output_tokens: 300, source: 'measured' });

  test('I3.S1: counterfactual_branches table exists with all 4 indexes', () => {
    const db = state._dbForQuery();
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='counterfactual_branches'").get();
    assert.ok(t, 'table missing');
    const idxs = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_cf_%'").all().map(r => r.name);
    assert.ok(idxs.includes('idx_cf_branch_point'));
    assert.ok(idxs.includes('idx_cf_status'));
  });

  test('I3.C1: createBranch persists with correct status', () => {
    const id = state.createBranch({ branch_point_id: intent.id, substituted_path: 'use NextAuth', cost_estimate: 0.012 });
    assert.ok(id && id.length === 36);
    const b = state.getBranch(id);
    assert.strictEqual(b.status, 'candidate');
    assert.strictEqual(b.substituted_path, 'use NextAuth');
  });

  test('I3.C2: createBranch rejects unknown status', () => {
    const id = state.createBranch({ branch_point_id: intent.id, substituted_path: 'p', status: 'invalid' });
    assert.strictEqual(id, null);
  });

  test('I3.C3: createBranch rejects orphan branch_point_id', () => {
    const id = state.createBranch({
      branch_point_id: '00000000-0000-7000-8000-000000000000', substituted_path: 'p'
    });
    assert.strictEqual(id, null);
  });

  test('I3.C4: setBranchStatus → materialized stamps materialized_at', () => {
    const id = state.createBranch({ branch_point_id: intent.id, substituted_path: 'roll our own' });
    const ok = state.setBranchStatus(id, 'materialized', { cost_estimate: 0.045, outcome_summary: { satisfied: false } });
    assert.strictEqual(ok, true);
    const b = state.getBranch(id);
    assert.strictEqual(b.status, 'materialized');
    assert.ok(b.materialized_at > 0);
    assert.strictEqual(b.outcome_summary.satisfied, false);
  });

  test('I3.E1: proposeAlternatives reads alternatives_considered from intent', () => {
    const alts = CF.proposeAlternatives(state, intent.id);
    assert.strictEqual(alts.length, 2);
    assert.strictEqual(alts[0].substituted_path, 'use NextAuth');
    assert.strictEqual(alts[0].chosen_path_original, 'use Auth0');
  });

  test('I3.E2: proposeAlternatives empty when intent has no alternatives', () => {
    const noAlts = AR.create({
      type: 'intent', agent_id: 'cc', cwd: '/p',
      input: { goal: 'g2', source_message_hash: 'h2' },
      output: { chosen_path: 'pX' /* no alternatives_considered */ }
    });
    state.recordAction(noAlts);
    assert.deepStrictEqual(CF.proposeAlternatives(state, noAlts.id), []);
  });

  test('I3.E3: originalBaseline returns cost + verification + node_count', () => {
    const b = CF.originalBaseline(state, intent.id);
    assert.ok(b.cost && b.cost.usd === 0.020);
    assert.ok(b.verification.pass >= 1);
    assert.ok(b.node_count >= 2);
  });

  test('I3.M1: materializeBranch happy path — agent returns satisfied + cheaper', async () => {
    const bid = CF.createCandidate(state, intent.id, 'use NextAuth');
    assert.ok(bid);
    const res = await CF.materializeBranch(state, bid, async ({ intent, substituted_path, baseline }) => ({
      satisfied: true, cost_usd: 0.012, verification: { pass: 1, fail: 0 }, edits: [{ file_path: 'auth.ts', hash_after: 'b' }]
    }));
    assert.strictEqual(res.ok, true);
    const branch = state.getBranch(bid);
    assert.strictEqual(branch.status, 'materialized');
    assert.strictEqual(branch.outcome_summary.cost_usd, 0.012);
  }, { async: true });

  test('I3.M2: materializeBranch rejects already-materialized branch', async () => {
    const bid = CF.createCandidate(state, intent.id, 'roll our own');
    await CF.materializeBranch(state, bid, async () => ({ satisfied: true, cost_usd: 0.05, verification: { pass: 1, fail: 0 } }));
    const second = await CF.materializeBranch(state, bid, async () => ({ satisfied: true, cost_usd: 0.04, verification: { pass: 1, fail: 0 } }));
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.error, 'wrong_status');
  }, { async: true });

  test('I3.D1: diffBranch reports cost delta + cheaper/safer verdict', async () => {
    const bid = CF.createCandidate(state, intent.id, 'use NextAuth');
    await CF.materializeBranch(state, bid, async () => ({
      satisfied: true, cost_usd: 0.012, verification: { pass: 1, fail: 0 }
    }));
    const d = CF.diffBranch(state, bid);
    assert.ok(Math.abs(d.cost.delta_usd - (-0.008)) < 1e-9);
    assert.ok(d.cost.pct_change < 0);
    assert.strictEqual(d.cheaper, true);
    assert.strictEqual(d.safer, true);
  }, { async: true });

  test('I3.D2: discardBranch flips status without materialization', () => {
    const bid = CF.createCandidate(state, intent.id, 'use NextAuth');
    const ok = CF.discardBranch(state, bid);
    assert.strictEqual(ok, true);
    const b = state.getBranch(bid);
    assert.strictEqual(b.status, 'discarded');
    assert.strictEqual(b.materialized_at, null);
  });

  // F22 — automated `troth replay` CLI surface contract.
  // Locks the public CLI invocation paths so future changes don't
  // silently break --intent / --use / --list / --branch --diff / --discard.
  test('F22: troth replay CLI subcommands respond on synthetic data', () => {
    const cpF22 = require('child_process');
    const pF22  = require('path');
    const REPO  = pF22.resolve(__dirname, '..');
    const env   = Object.assign({}, process.env, {
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA  // current TMP_I3
    });
    function runCli(args) {
      return cpF22.spawnSync('node', [pF22.join(REPO, 'bin/troth.js'), 'replay', ...args],
        { encoding: 'utf8', env, timeout: 5000 });
    }
    // --intent <id> lists alternatives.
    const r1 = runCli(['--intent', intent.id]);
    assert.strictEqual(r1.status, 0, 'replay --intent: ' + (r1.stderr || ''));
    assert.ok(/Alternatives for intent/.test(r1.stdout), 'expected alternatives header in stdout');
    // --intent <id> --use 0 creates a candidate.
    const r2 = runCli(['--intent', intent.id, '--use', '0']);
    assert.strictEqual(r2.status, 0, 'replay --use: ' + (r2.stderr || ''));
    assert.ok(/Created candidate branch/.test(r2.stdout), 'expected candidate banner');
    // --list shows ≥1 row.
    const r3 = runCli(['--list']);
    assert.strictEqual(r3.status, 0, 'replay --list: ' + (r3.stderr || ''));
    assert.ok(/candidate|materialized|discarded/.test(r3.stdout), 'expected status column');
  });

  // Cleanup
  process.env.CLAUDE_PLUGIN_DATA = savedEnv;
  setTimeout(() => {
    try { fsI3.rmSync(TMP_I3, { recursive: true, force: true }); } catch (_) {}
  }, 500).unref();
})();

// --- TOON wire format ---
console.log('\nP17 Tier 1 — TOON wire format:');
(function runP17T1Tests() {
  const W  = require('../shared-core/wire-format');
  const AR = require('../shared-core/action-record');

  // Helper: build N records of mixed types, including high-frequency strings.
  function makeBatch(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const t = ['edit', 'read', 'search', 'decision'][i % 4];
      const base = {
        type: t, agent_id: 'claude-code', session_id: 's1', cwd: '/proj/repo'
      };
      if (t === 'edit') {
        rows.push(AR.create({ ...base,
          input:  { file_path: 'src/file' + i + '.ts', format: 'hashline' },
          output: { hash_after: 'sha1:' + i },
          verification: { ast: { ok: true } } }));
      } else if (t === 'read') {
        rows.push(AR.create({ ...base,
          input:  { file_path: 'src/file' + i + '.ts' },
          output: { hash: 'sha1:' + i } }));
      } else if (t === 'search') {
        rows.push(AR.create({ ...base,
          input:  { query: 'pattern' + i, kind: 'grep' },
          output: { result_count: i } }));
      } else {
        rows.push(AR.create({ ...base,
          input:  { kind: 'critic_verdict' },
          output: { decision: 'approve' } }));
      }
    }
    return rows;
  }

  test('P17-T1.W1: encodeBatch + decodeBatch round-trip integrity (single record)', () => {
    const r = AR.create({
      type: 'edit', agent_id: 'cc',
      input: { file_path: 'a.ts', format: 'hashline' },
      output: { hash_after: 'abc' },
      verification: { ast: { ok: true } }
    });
    const toon = W.encodeBatch([r]);
    const back = W.decodeBatch(toon);
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].id, r.id);
    assert.strictEqual(back[0].type, 'edit');
    const inp = JSON.parse(back[0].input);
    assert.strictEqual(inp.file_path, 'a.ts');
    assert.strictEqual(inp.format, 'hashline');
  });

  test('P17-T1.W2: round-trip preserves all 8 ActionRecord types + intent + avoided_path', () => {
    const types = ['edit', 'read', 'search', 'tool_call', 'decision', 'compact', 'lesson', 'intent', 'avoided_path'];
    const rows = types.map(t => {
      if (t === 'edit')         return AR.create({ type: t, agent_id: 'cc', input: { file_path: 'f', format: 'h' },        output: { hash_after: 'a' } });
      if (t === 'read')         return AR.create({ type: t, agent_id: 'cc', input: { file_path: 'f' },                     output: { hash: 'a' } });
      if (t === 'search')       return AR.create({ type: t, agent_id: 'cc', input: { query: 'q', kind: 'grep' },           output: { result_count: 0 } });
      if (t === 'tool_call')    return AR.create({ type: t, agent_id: 'cc', input: { tool_name: 'Bash' },                  output: { status: 'ok' } });
      if (t === 'decision')     return AR.create({ type: t, agent_id: 'cc', input: { kind: 'critic' },                     output: { decision: 'allow' } });
      if (t === 'compact')      return AR.create({ type: t, agent_id: 'cc', input: { trigger: 'manual' },                  output: { removed_count: 0, kept_count: 1 } });
      if (t === 'lesson')       return AR.create({ type: t, agent_id: 'cc', input: { source: 'critic', fingerprint: 'f' }, output: { text: 'be careful' } });
      if (t === 'intent')       return AR.create({ type: t, agent_id: 'cc', input: { goal: 'g', source_message_hash: 'h' },output: { chosen_path: 'p' } });
      if (t === 'avoided_path') return AR.create({ type: t, agent_id: 'cc', input: { fingerprint: 'fp', reason_kind: 'critic_block' }, output: { avoidance_text: 'blocked' } });
    });
    const toon = W.encodeBatch(rows);
    const back = W.decodeBatch(toon);
    assert.strictEqual(back.length, rows.length);
    for (let i = 0; i < rows.length; i++) {
      assert.strictEqual(back[i].id, rows[i].id, 'id mismatch at ' + i);
      assert.strictEqual(back[i].type, rows[i].type);
    }
  });

  test('P17-T1.W3: alias dictionary captures repeated agent_id', () => {
    const rows = makeBatch(10);
    const toon = W.encodeBatch(rows);
    const headerLine = toon.split('\n')[0];
    const header = JSON.parse(headerLine);
    assert.ok(header.aliases['claude-code'], 'agent_id should be aliased');
    assert.ok(header.aliases['/proj/repo'], 'cwd should be aliased');
  });

  test('P17-T1.W4: aliases capped at 64 even with many distinct repeats', () => {
    const rows = [];
    for (let i = 0; i < 200; i++) {
      const sharedAgent = 'agent-' + (i % 100);
      const r = AR.create({ type: 'edit', agent_id: sharedAgent,
        input: { file_path: 'f' + i, format: 'h' }, output: { hash_after: 'h' + i } });
      rows.push(r);
      rows.push({ ...r, id: AR.uuidv7() });  // duplicate to push freq ≥ 2
      rows.push({ ...r, id: AR.uuidv7() });  // ≥ 3 → eligible
    }
    const toon = W.encodeBatch(rows);
    const header = JSON.parse(toon.split('\n')[0]);
    assert.ok(Object.keys(header.aliases).length <= 64, 'aliases must be ≤64, got ' + Object.keys(header.aliases).length);
  });

  test('P17-T1.W5: empty batch produces valid TOON header with empty rows', () => {
    const toon = W.encodeBatch([]);
    const back = W.decodeBatch(toon);
    assert.strictEqual(back.length, 0);
  });

  test('P17-T1.W6: pipe + backslash + newline in value get escaped + restored', () => {
    const r = AR.create({
      type: 'lesson', agent_id: 'cc',
      input:  { source: 'manual', fingerprint: 'fp' },
      output: { text: 'use a|b not c\\d\nnewline' }
    });
    const toon = W.encodeBatch([r]);
    const back = W.decodeBatch(toon);
    assert.strictEqual(JSON.parse(back[0].output).text, 'use a|b not c\\d\nnewline');
  });

  test('P17-T1.W7: ≥30% token reduction vs verbose JSON on 50-record batch', () => {
    const rows = makeBatch(50);
    const json = JSON.stringify(rows.map(AR.toRow));
    const toon = W.encodeBatch(rows);
    const reduction = 1 - (toon.length / json.length);
    assert.ok(reduction >= 0.30, 'expected ≥30% reduction, got ' + (reduction * 100).toFixed(1) + '%');
  });

  test('P17-T1.W8: encodeManifest emits header with stats + row block', () => {
    const m = {
      resident: 3, max_size: 24, tokens: 200, budget: 1500, pinned: [],
      entries: [
        { id: 'a', type: 'edit',   summary: 'edit auth.ts', pinned: false },
        { id: 'b', type: 'edit',   summary: 'edit cb.ts',   pinned: true  },
        { id: 'c', type: 'intent', summary: 'add OAuth',    pinned: false }
      ]
    };
    const toon = W.encodeManifest(m);
    const headerLine = toon.split('\n')[0];
    const header = JSON.parse(headerLine);
    assert.strictEqual(header.kind, 'manifest');
    assert.strictEqual(header.stats.resident, 3);
    assert.ok(header.aliases.edit, 'repeated type should be aliased');
    const rowLines = toon.split('\n').slice(1);
    assert.strictEqual(rowLines.length, 3);
  });

  test('P17-T1.W9: estimateTokens returns plausible char/4 estimate', () => {
    const t = W.estimateTokens('a'.repeat(100));
    assert.strictEqual(t, 25);
  });

  test('P17-T1.W10: invalid TOON input decodes to []', () => {
    assert.deepStrictEqual(W.decodeBatch(''), []);
    assert.deepStrictEqual(W.decodeBatch('not even a json header'), []);
    assert.deepStrictEqual(W.decodeBatch(JSON.stringify({ __toon: 99 })), []);
  });

  test('P17-T1.W11: decoded record JSON columns parse cleanly', () => {
    const r = AR.create({
      type: 'edit', agent_id: 'cc',
      input:  { file_path: 'a', format: 'h', extras: { nested: true, list: [1, 2, 3] } },
      output: { hash_after: 'x' }
    });
    const back = W.decodeBatch(W.encodeBatch([r]))[0];
    const inp = JSON.parse(back.input);
    assert.strictEqual(inp.extras.nested, true);
    assert.deepStrictEqual(inp.extras.list, [1, 2, 3]);
  });

  test('P17-T1.W12: timestamp is preserved as integer through round-trip', () => {
    const r = AR.create({ type: 'edit', agent_id: 'cc',
      input: { file_path: 'a', format: 'h' }, output: { hash_after: 'h' } });
    const expected = r.timestamp;
    const back = W.decodeBatch(W.encodeBatch([r]))[0];
    assert.strictEqual(back.timestamp, expected);
    assert.strictEqual(typeof back.timestamp, 'number');
  });
})();

// --- TRON for nested DAGs ---
console.log('\nP17 Tier 2 — TRON nested encoder:');
(function runP17T2Tests() {
  const W = require('../shared-core/wire-format');

  test('P17-T2.N1: encodeNested(path) round-trips a 3-hop chain', () => {
    const rows = [
      { node_id: 'a', depth: 1, path: '>refines_intent' },
      { node_id: 'b', depth: 2, path: '>refines_intent>produces_edit' },
      { node_id: 'c', depth: 3, path: '>refines_intent>produces_edit>satisfies' }
    ];
    const tron = W.encodeNested(rows, { shape: 'path' });
    const back = W.decodeNested(tron);
    assert.strictEqual(back.length, 3);
    assert.strictEqual(back[0].node_id, 'a');
    assert.strictEqual(back[2].path, '>refines_intent>produces_edit>satisfies');
  });

  test('P17-T2.N2: encodeNested(path) ≥20% reduction on 50-row payload', () => {
    const rows = [];
    const segs = ['refines_intent', 'produces_edit', 'satisfies', 'rationalizes'];
    for (let i = 0; i < 50; i++) {
      const depth = (i % 5) + 1;
      let p = '';
      for (let j = 0; j < depth; j++) p += '>' + segs[j % segs.length];
      rows.push({ node_id: '019dd420-' + i.toString(16).padStart(4, '0') + '-7000-8000-' + i.toString(16).padStart(12, '0'), depth, path: p });
    }
    const json = JSON.stringify(rows);
    const tron = W.encodeNested(rows, { shape: 'path' });
    const reduction = 1 - (tron.length / json.length);
    assert.ok(reduction >= 0.20, 'expected ≥20%, got ' + (reduction * 100).toFixed(1) + '%');
  });

  test('P17-T2.N3: encodeNested(branches) preserves status enum + outcome_summary', () => {
    const rows = [
      { id: 'b1', branch_point_id: 'i1', substituted_path: 'use NextAuth', status: 'materialized', parent_branch_id: null, created_at: 1, materialized_at: 2, cost_estimate: 0.012, outcome_summary: { satisfied: true, cost_usd: 0.012 } },
      { id: 'b2', branch_point_id: 'i1', substituted_path: 'roll our own', status: 'discarded',    parent_branch_id: null, created_at: 3, materialized_at: null, cost_estimate: null, outcome_summary: null },
      { id: 'b3', branch_point_id: 'i2', substituted_path: 'use Auth0',    status: 'candidate',    parent_branch_id: null, created_at: 4, materialized_at: null, cost_estimate: 0.020, outcome_summary: null }
    ];
    const tron = W.encodeNested(rows, { shape: 'branches' });
    const back = W.decodeNested(tron);
    assert.strictEqual(back.length, 3);
    assert.strictEqual(back[0].status, 'materialized');
    assert.strictEqual(back[0].outcome_summary.satisfied, true);
    assert.strictEqual(back[1].status, 'discarded');
    assert.strictEqual(back[2].cost_estimate, 0.020);
  });

  test('P17-T2.N4: encodeNested(branches) ≥20% reduction', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) {
      rows.push({
        id: 'b' + i, branch_point_id: 'i' + (i % 3),
        substituted_path: 'alternative path ' + i,
        status: ['candidate', 'materialized', 'discarded'][i % 3],
        parent_branch_id: null, created_at: i, materialized_at: i % 2 ? null : i + 1,
        cost_estimate: 0.001 * i, outcome_summary: { satisfied: i % 2 === 0 }
      });
    }
    const json = JSON.stringify(rows);
    const tron = W.encodeNested(rows, { shape: 'branches' });
    const reduction = 1 - (tron.length / json.length);
    assert.ok(reduction >= 0.20, 'expected ≥20%, got ' + (reduction * 100).toFixed(1) + '%');
  });

  test('P17-T2.N5: encodeNested(tree) preserves depth + ids', () => {
    const tree = {
      type: 'intent', id: 'root',
      children: [
        { type: 'edit', id: 'e1', children: [
          { type: 'decision', id: 'd1', children: [] }
        ]},
        { type: 'edit', id: 'e2', children: [] }
      ]
    };
    const tron = W.encodeNested(tree, { shape: 'tree' });
    const back = W.decodeNested(tron);
    // Pre-order traversal: root, e1, d1, e2
    assert.strictEqual(back.length, 4);
    assert.strictEqual(back[0].id, 'root');
    assert.strictEqual(back[0].depth, 0);
    assert.strictEqual(back[1].id, 'e1');
    assert.strictEqual(back[1].depth, 1);
    assert.strictEqual(back[2].id, 'd1');
    assert.strictEqual(back[2].depth, 2);
    assert.strictEqual(back[3].id, 'e2');
    assert.strictEqual(back[3].depth, 1);
  });

  test('P17-T2.A1: pickFormat returns tron for path-shaped rows', () => {
    const path = [{ node_id: 'a', depth: 1, path: '>x' }];
    assert.strictEqual(W.pickFormat(path), 'tron');
  });

  test('P17-T2.A2: pickFormat returns tron for branch-shaped rows', () => {
    const branches = [{ id: 'b1', branch_point_id: 'i1', parent_branch_id: null, status: 'candidate' }];
    assert.strictEqual(W.pickFormat(branches), 'tron');
  });

  test('P17-T2.A3: pickFormat returns toon for flat ActionRecord shape', () => {
    const flat = [{ type: 'edit', id: 'e1', timestamp: 1 }];
    assert.strictEqual(W.pickFormat(flat), 'toon');
  });

  test('P17-T2.A4: pickFormat returns tron for tree-shaped object', () => {
    assert.strictEqual(W.pickFormat({ type: 'root', children: [] }), 'tron');
  });

  test('P17-T2.E1: invalid TRON payload decodes to []', () => {
    assert.deepStrictEqual(W.decodeNested(''), []);
    assert.deepStrictEqual(W.decodeNested('not json'), []);
    assert.deepStrictEqual(W.decodeNested(JSON.stringify({ __tron: 99 })), []);
  });
})();

// --- Schema Reflector ---
console.log('\nP17 Tier 3 — schema reflector:');
(function runP17T3Tests() {
  const pT3  = require('path');
  const fsT3 = require('fs');
  const TMP_T3 = pT3.join(require('os').tmpdir(), 'gc-p17-t3-' + Date.now());
  fsT3.mkdirSync(TMP_T3, { recursive: true });
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_T3;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/wire-format')];
  delete require.cache[require.resolve('../shared-core/schema-reflector')];
  const AR    = require('../shared-core/action-record');
  const state = require('../shared-core/state');
  const W     = require('../shared-core/wire-format');
  const R     = require('../shared-core/schema-reflector');

  // Seed 30 records
  for (let i = 0; i < 30; i++) {
    const r = AR.create({
      type: i % 2 === 0 ? 'edit' : 'read',
      agent_id: 'claude-code', cwd: '/tmp/proj',
      input: i % 2 === 0 ? { file_path: 'a' + i + '.ts', format: 'hashline' } : { file_path: 'a' + i + '.ts' },
      output: i % 2 === 0 ? { hash_after: 'sha:' + i } : { hash: 'sha:' + i }
    });
    state.recordAction(r);
  }
  const baseline = JSON.parse(W.encodeBatch([]).split('\n')[0]);

  test('P17-T3.S1: wire_format_profiles table + indexes exist', () => {
    const db = state._dbForQuery();
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wire_format_profiles'").get();
    assert.ok(t, 'table missing');
    const idxs = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_wfp_%'").all().map(r => r.name);
    assert.ok(idxs.includes('idx_wfp_signature'));
    assert.ok(idxs.includes('idx_wfp_status'));
  });

  test('P17-T3.C1: saveWireFormatProfile persists candidate with valid header', () => {
    const id = state.saveWireFormatProfile({
      domain_signature: 'sig-c1',
      header_json: { ...baseline, aliases: { 'claude-code': '&0' } }
    });
    assert.ok(id && id.length === 36);
    const p = state.getWireFormatProfile(id);
    assert.strictEqual(p.status, 'candidate');
  });

  test('P17-T3.C2: saveWireFormatProfile rejects invalid header', () => {
    assert.strictEqual(state.saveWireFormatProfile({
      domain_signature: 'sig-c2', header_json: 'not a json header'
    }), null);
    assert.strictEqual(state.saveWireFormatProfile({
      domain_signature: 'sig-c2', header_json: { __toon: 99, keys: [] }
    }), null);
  });

  test('P17-T3.C3: activateWireFormatProfile demotes prior active', () => {
    const a = state.saveWireFormatProfile({ domain_signature: 'sig-c3', header_json: { ...baseline, aliases: { 'x': '&0' } } });
    const b = state.saveWireFormatProfile({ domain_signature: 'sig-c3', header_json: { ...baseline, aliases: { 'y': '&0' } } });
    state.activateWireFormatProfile(a);
    state.activateWireFormatProfile(b);
    assert.strictEqual(state.getWireFormatProfile(a).status, 'discarded');
    assert.strictEqual(state.getWireFormatProfile(b).status, 'active');
    const active = state.getActiveWireFormatProfile('sig-c3');
    assert.strictEqual(active.id, b);
  });

  test('P17-T3.V1: validateProposal accepts well-formed proposal', () => {
    const v = R.validateProposal({ ...baseline, aliases: { 'claude-code': '&0', '/proj': '&1' } }, baseline);
    assert.strictEqual(v.ok, true);
  });

  test('P17-T3.V2: validateProposal rejects key drift', () => {
    const bad = { ...baseline, keys: [...baseline.keys].reverse() };
    const v = R.validateProposal(bad, baseline);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'key_drift');
  });

  test('P17-T3.V3: validateProposal rejects key count mismatch', () => {
    const bad = { ...baseline, keys: baseline.keys.slice(0, 5) };
    const v = R.validateProposal(bad, baseline);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'key_count_mismatch');
  });

  test('P17-T3.V4: validateProposal rejects aliased UUID', () => {
    const bad = { ...baseline, aliases: { '019dd420-1111-7000-8000-aaaaaaaaaaaa': '&0' } };
    const v = R.validateProposal(bad, baseline);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'aliased_uuid');
  });

  test('P17-T3.V5: validateProposal rejects too-many aliases', () => {
    const aliases = {};
    for (let i = 0; i < 33; i++) aliases['val' + i] = '&' + i;
    const v = R.validateProposal({ ...baseline, aliases }, baseline);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'too_many_aliases');
  });

  test('P17-T3.R1: runReflector saves a candidate from valid mock LLM output', async () => {
    const mockDriver = async () => JSON.stringify({
      ...baseline, aliases: { 'claude-code': '&0', '/tmp/proj': '&1', 'hashline': '&2' }
    });
    const res = await R.runReflector(state, {
      driver: mockDriver, cwd: '/tmp/proj', sample_size: 30, debounce_ms: 0, author: 'mock'
    });
    assert.strictEqual(res.ok, true);
    assert.ok(res.profile_id);
    const p = state.getWireFormatProfile(res.profile_id);
    assert.strictEqual(p.status, 'candidate');
    assert.strictEqual(p.author, 'mock');
  }, { async: true });

  test('P17-T3.R2: runReflector rejects malformed LLM output', async () => {
    const badDriver = async () => 'not json at all';
    const res = await R.runReflector(state, {
      driver: badDriver, cwd: '/tmp/proj', sample_size: 30, debounce_ms: 0
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'parse_failed');
  }, { async: true });

  test('P17-T3.R3: runReflector debounces repeat calls within window', async () => {
    const mockDriver = async () => JSON.stringify({
      ...baseline, aliases: { 'claude-code': '&0' }
    });
    // First call (debounce=0 → no debounce, succeeds)
    await R.runReflector(state, { driver: mockDriver, cwd: '/tmp/proj', sample_size: 30, debounce_ms: 0, author: 'a1' });
    // Second call (debounce=1h → recent profile triggers debounce)
    const r = await R.runReflector(state, { driver: mockDriver, cwd: '/tmp/proj', sample_size: 30, debounce_ms: 60 * 60 * 1000, author: 'a2' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'debounced');
  }, { async: true });

  test('P17-T3.D1: computeDomainSignature is deterministic across runs', () => {
    const recs = state.queryActions({ cwd: '/tmp/proj', limit: 30 }).map(AR.fromRow);
    const s1 = R.computeDomainSignature(recs);
    const s2 = R.computeDomainSignature(recs);
    assert.strictEqual(s1, s2);
    assert.strictEqual(s1.length, 16);
  });

  test('P17-T3.E1: encodeBatch with profile_aliases prunes unused entries', () => {
    const rows = [];
    for (let i = 0; i < 8; i++) {
      rows.push(AR.create({
        type: 'edit', agent_id: 'cc', session_id: 'sess-x', cwd: '/proj/x',
        input: { file_path: 'f' + i, format: 'h' }, output: { hash_after: 'h' + i }
      }));
    }
    const profileAliases = {
      'cc': '&0', '/proj/x': '&1', 'h': '&2',
      'unused-value': '&3', 'another-unused': '&4'
    };
    const toon = W.encodeBatch(rows, { profile_aliases: profileAliases });
    const header = JSON.parse(toon.split('\n')[0]);
    // Pruned aliases dict must NOT include unused entries.
    assert.ok(!('unused-value' in header.aliases));
    assert.ok(!('another-unused' in header.aliases));
    // Used ones must be present.
    assert.strictEqual(header.aliases['cc'], '&0');
    // Round-trip integrity unchanged.
    const back = W.decodeBatch(toon);
    assert.strictEqual(back.length, 8);
  });

  test('P17-T3.E2: profile_aliases ignored on tiny batches (<5 rows)', () => {
    // Small-batch guard: profiles add header overhead that costs more than
    // they save on tiny batches. Auto-detect path is used instead.
    // Use agent_id that doesn't match any HIGH_FREQ_VALUE_PATTERN so the
    // auto-detect path produces an empty alias dict.
    const rows = [
      AR.create({ type: 'edit', agent_id: 'unique-ag-z9',
        input: { file_path: 'a', format: 'h' }, output: { hash_after: 'a' } })
    ];
    const profileAliases = { 'unique-ag-z9': '&0', 'h': '&1' };
    const toon = W.encodeBatch(rows, { profile_aliases: profileAliases });
    const header = JSON.parse(toon.split('\n')[0]);
    // Profile path was skipped (batch too small) → auto-detect runs;
    // with 1 record, threshold ≥3 finds nothing → empty.
    assert.deepStrictEqual(header.aliases, {});
  });

  // Cleanup
  process.env.CLAUDE_PLUGIN_DATA = savedEnv;
  setTimeout(() => {
    try { fsT3.rmSync(TMP_T3, { recursive: true, force: true }); } catch (_) {}
  }, 500).unref();
})();

// --- PHASE CH: Chameleon Protocol v0.1 conformance (filesystem reference adapter) ---
console.log('\nPhase CH — Chameleon Protocol v0.1 (filesystem reference adapter):');
(function runChameleonFilesystemConformance() {
  const childProcessCH = require('child_process');
  const pCH = require('path');
  const fCH = require('fs');
  const REPO_CH = pCH.resolve(__dirname, '..');

  // Build a tiny fixture directory of supported files for /read tests.
  const FIXTURE = pCH.join(require('os').tmpdir(), 'gc-ch-fixture-' + Date.now());
  fCH.mkdirSync(FIXTURE, { recursive: true });
  fCH.writeFileSync(pCH.join(FIXTURE, 'a.md'),
    '# Doc A\n## Section one\n' + 'lorem '.repeat(120) + '\n## Section two\n' + 'ipsum '.repeat(120));
  fCH.writeFileSync(pCH.join(FIXTURE, 'b.txt'),
    'plain text body for adapter test '.repeat(40));
  // A file that should be skipped (too small).
  fCH.writeFileSync(pCH.join(FIXTURE, 'tiny.md'), '# tiny');
  // A file that should be skipped (unsupported ext).
  fCH.writeFileSync(pCH.join(FIXTURE, 'skip.bin'), 'binary stuff');

  const ADAPTER = pCH.join(REPO_CH, 'adapters', 'chameleon-filesystem.mjs');
  const adapter = childProcessCH.spawn('node',
    [ADAPTER, '--root', FIXTURE, '--source-id', 'fs-test'],
    { stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  const pending = new Map();
  let nextId = 1;
  adapter.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    }
  });

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(nextId++);
      // Bumped 5s → 15s (matches Phase C rationale: load-based serialization
      // on the single-threaded event loop pushed first responses past 5s).
      const deadline = setTimeout(() => { pending.delete(id); reject(new Error('rpc timeout: ' + method)); }, 15000);
      pending.set(id, (msg) => { clearTimeout(deadline); resolve(msg); });
      adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }

  // CH-1: handshake — initialize returns manifest with matching protocol_version
  test('CH-1: chameleon/initialize returns manifest with matching protocol_version', async () => {
    const r = await rpc('chameleon/initialize', { protocol_version: '0.1', client_capabilities: ['read'] });
    assert.ok(r.result, 'initialize must return result');
    assert.strictEqual(r.result.protocol_version, '0.1');
    assert.ok(r.result.source_manifest, 'manifest must be included');
    assert.strictEqual(r.result.source_manifest.source_kind, 'filesystem');
    assert.strictEqual(r.result.source_manifest.data_shape, 'text');
    assert.strictEqual(r.result.source_manifest.source_id, 'fs-test');
  });

  // CH-2: protocol_version mismatch → -32004 unsupported_protocol_version
  test('CH-2: initialize rejects unsupported protocol_version with -32004', async () => {
    const r = await rpc('chameleon/initialize', { protocol_version: '99.0', client_capabilities: [] });
    assert.ok(r.error, 'mismatch must return error');
    assert.strictEqual(r.error.code, -32004);
  });

  // CH-3: manifest_hash recomputes correctly (integrity check per spec §1)
  test('CH-3: manifest_hash recomputes deterministically', async () => {
    const r = await rpc('chameleon/describe', {});
    const m = r.result;
    assert.ok(m.manifest_hash.startsWith('sha256:'), 'hash must be sha256-prefixed');
    // Recompute client-side using the same canonical-JSON algorithm.
    const cryptoCH = require('crypto');
    const m2 = Object.assign({}, m, { manifest_hash: '' });
    function canonicalize(obj) {
      if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
      if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
      const keys = Object.keys(obj).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
    }
    const recomputed = 'sha256:' + cryptoCH.createHash('sha256').update(canonicalize(m2)).digest('hex');
    assert.strictEqual(m.manifest_hash, recomputed,
      'recomputed manifest_hash must equal adapter-supplied hash');
  });

  // CH-4: get_schema returns null for text data_shape (per spec §1)
  test('CH-4: get_schema returns null for text data_shape', async () => {
    const r = await rpc('chameleon/get_schema', {});
    assert.ok(r.result, 'get_schema must return result');
    assert.strictEqual(r.result.schema, null);
    assert.ok(r.result.reason && r.result.reason.includes('text'));
  });

  // CH-5: discover/begin returns dialog_id and max_questions=7
  test('CH-5: discover/begin returns dialog_id + max_questions=7', async () => {
    const r = await rpc('chameleon/discover/begin', { source_id: 'fs-test' });
    assert.ok(r.result.dialog_id, 'dialog_id must be present');
    assert.strictEqual(r.result.max_questions, 7);
  });

  // CH-6: discover/question → discover/answer → after 3 questions knee fires
  test('CH-6: discovery dialog terminates by knee after 3 questions', async () => {
    const begin = await rpc('chameleon/discover/begin', { source_id: 'fs-test' });
    const id = begin.result.dialog_id;
    let questionCount = 0;
    let lastResult;
    for (let i = 0; i < 7; i++) {
      const q = await rpc('chameleon/discover/question', { dialog_id: id });
      lastResult = q.result;
      if (q.result.kind === 'knee_detected') break;
      questionCount++;
      const a = await rpc('chameleon/discover/answer',
        { dialog_id: id, question_id: q.result.question_id, answer: q.result.options[0] });
      assert.strictEqual(a.result.accepted, true);
    }
    assert.ok(questionCount <= 7, 'must respect 7-cap');
    assert.ok(questionCount === 3, 'filesystem adapter should fire knee after 3 (got: ' + questionCount + ')');
    assert.strictEqual(lastResult.kind, 'knee_detected');
  });

  // CH-7: discover/complete returns resolved fields, no quarantine for filesystem
  test('CH-7: discover/complete returns resolved_fields and no quarantine', async () => {
    const begin = await rpc('chameleon/discover/begin', { source_id: 'fs-test' });
    const id = begin.result.dialog_id;
    // Run to knee
    for (let i = 0; i < 7; i++) {
      const q = await rpc('chameleon/discover/question', { dialog_id: id });
      if (q.result.kind === 'knee_detected') break;
      await rpc('chameleon/discover/answer',
        { dialog_id: id, question_id: q.result.question_id, answer: q.result.options[0] });
    }
    const c = await rpc('chameleon/discover/complete', { dialog_id: id });
    assert.ok(Array.isArray(c.result.resolved_fields));
    assert.ok(c.result.resolved_fields.length > 0);
    assert.deepStrictEqual(c.result.quarantined_fields, []);
    assert.strictEqual(c.result.under_specified, false);
  });

  // CH-8: dialog_state_error on out-of-order calls (-32103)
  test('CH-8: out-of-order dialog calls return -32103', async () => {
    const r = await rpc('chameleon/discover/answer',
      { dialog_id: 'no-such-dialog', question_id: 'x', answer: 'y' });
    assert.ok(r.error);
    assert.strictEqual(r.error.code, -32103);
  });

  // CH-9: read returns chunks from supported files in fixture, skips unsupported
  test('CH-9: read returns chunks from .md/.txt files only', async () => {
    const r = await rpc('chameleon/read', {});
    assert.ok(r.result, 'read must return result');
    assert.ok(Array.isArray(r.result.records));
    assert.ok(r.result.records.length >= 2,
      'must have at least 2 chunks from a.md + b.txt (got: ' + r.result.records.length + ')');
    const sources = new Set(r.result.records.map(rec => rec.source_path));
    assert.ok(sources.has('a.md'), 'a.md must contribute chunks');
    assert.ok(sources.has('b.txt'), 'b.txt must contribute chunks');
    assert.ok(!sources.has('skip.bin'), 'unsupported binary must be skipped');
    assert.ok(!sources.has('tiny.md'), 'too-small file must be skipped');
  });

  // CH-10: every record carries confidence ∈ [0,1] (per spec §9.4)
  test('CH-10: every read record carries confidence in [0,1]', async () => {
    const r = await rpc('chameleon/read', {});
    for (const rec of r.result.records) {
      assert.ok(typeof rec.confidence === 'number');
      assert.ok(rec.confidence >= 0 && rec.confidence <= 1,
        'confidence out of range: ' + rec.confidence);
      assert.ok(rec.id && rec.source_path && rec.text);
      assert.strictEqual(rec.source_kind, 'filesystem');
      assert.strictEqual(rec.source_id, 'fs-test');
    }
  });

  // CH-11: health endpoint returns ok
  test('CH-11: health returns status=ok', async () => {
    const r = await rpc('chameleon/health', {});
    assert.strictEqual(r.result.status, 'ok');
    assert.strictEqual(r.result.source_id, 'fs-test');
  });

  // CH-12: unknown method → -32601
  test('CH-12: unknown chameleon method returns -32601', async () => {
    const r = await rpc('chameleon/no_such_method', {});
    assert.ok(r.error);
    assert.strictEqual(r.error.code, -32601);
  });

  // Cleanup — bound to process exit, not a fixed setTimeout, so the
  // adapter stays alive for every queued CH-test await. See the C-phase
  // cleanup comment for the rpc-timeout regression the 2s timer caused.
  process.on('exit', () => {
    try { adapter.kill('SIGTERM'); } catch {}
    try { fCH.rmSync(FIXTURE, { recursive: true, force: true }); } catch {}
  });
})();

// --- PHASE CH2: Chameleon Claude-JSONL adapter (event_stream data_shape) ---
console.log('\nChameleon Claude-JSONL adapter (event_stream):');
(function runChameleonClaudeJsonlConformance() {
  const childProcessCH2 = require('child_process');
  const pCH2 = require('path');
  const fCH2 = require('fs');
  const REPO_CH2 = pCH2.resolve(__dirname, '..');

  // Fixture: a tiny synthetic JSONL log mimicking Claude Code session shape.
  const FIXTURE2 = pCH2.join(require('os').tmpdir(), 'gc-ch2-fixture-' + Date.now());
  fCH2.mkdirSync(FIXTURE2, { recursive: true });
  const jsonlPath = pCH2.join(FIXTURE2, 'session-test.jsonl');
  const events = [
    { type: 'user',      uuid: 'ev-001', timestamp: '2026-05-02T19:00:00Z', sessionId: 'S1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'ev-002', timestamp: '2026-05-02T19:00:01Z', sessionId: 'S1', parentUuid: 'ev-001', message: { role: 'assistant', content: 'hello' } },
    { type: 'tool_use',  uuid: 'ev-003', timestamp: '2026-05-02T19:00:02Z', sessionId: 'S1', parentUuid: 'ev-002', message: { tool_name: 'Read' } },
    { type: 'permission-mode', sessionId: 'S1', permissionMode: 'default' },   // missing uuid+timestamp — still valid (only `type` required)
    'not valid json'                                                            // garbage line — must be skipped
  ];
  fCH2.writeFileSync(jsonlPath,
    events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n'));

  const ADAPTER2 = pCH2.join(REPO_CH2, 'adapters', 'chameleon-claude-jsonl.mjs');
  const adapter2 = childProcessCH2.spawn('node',
    [ADAPTER2, '--root', FIXTURE2, '--source-id', 'cc-jsonl-test'],
    { stdio: ['pipe', 'pipe', 'pipe'] });

  let buf2 = '';
  const pending2 = new Map();
  let nextId2 = 1;
  adapter2.stdout.on('data', (d) => {
    buf2 += d.toString();
    let idx;
    while ((idx = buf2.indexOf('\n')) !== -1) {
      const line = buf2.slice(0, idx).trim();
      buf2 = buf2.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const cb = pending2.get(msg.id);
      if (cb) { pending2.delete(msg.id); cb(msg); }
    }
  });

  function rpc2(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(nextId2++);
      const deadline = setTimeout(() => { pending2.delete(id); reject(new Error('rpc timeout: ' + method)); }, 30000);
      pending2.set(id, (msg) => { clearTimeout(deadline); resolve(msg); });
      adapter2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }

  test('CH-13: claude-jsonl adapter advertises event_stream data_shape', async () => {
    const r = await rpc2('chameleon/initialize', { protocol_version: '0.1', client_capabilities: ['read'] });
    assert.ok(r.result, 'initialize must return result');
    const m = r.result.source_manifest;
    assert.strictEqual(m.source_kind, 'event_stream');
    assert.strictEqual(m.data_shape, 'event_stream');
    assert.strictEqual(m.source_id, 'cc-jsonl-test');
  });

  test('CH-14: get_schema returns a real JSON Schema (not null) for event_stream', async () => {
    const r = await rpc2('chameleon/get_schema', {});
    assert.ok(r.result.schema, 'schema must be present for event_stream shape');
    assert.strictEqual(r.result.schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.strictEqual(r.result.schema.type, 'object');
    assert.ok(r.result.schema.properties.type, 'event type discriminator must be in schema');
    assert.ok(r.result.schema.required.includes('type'));
  });

  test('CH-15: claude-jsonl discovery dialog terminates by knee after 2 questions', async () => {
    const begin = await rpc2('chameleon/discover/begin', { source_id: 'cc-jsonl-test' });
    const id = begin.result.dialog_id;
    let questionCount = 0;
    let lastResult;
    for (let i = 0; i < 7; i++) {
      const q = await rpc2('chameleon/discover/question', { dialog_id: id });
      lastResult = q.result;
      if (q.result.kind === 'knee_detected') break;
      questionCount++;
      await rpc2('chameleon/discover/answer',
        { dialog_id: id, question_id: q.result.question_id, answer: q.result.options[0] });
    }
    assert.strictEqual(questionCount, 2, 'event_stream adapter should fire knee after 2');
    assert.strictEqual(lastResult.kind, 'knee_detected');
  });

  test('CH-16: read returns one record per valid JSONL line, skips garbage', async () => {
    const r = await rpc2('chameleon/read', {});
    assert.ok(r.result.records, 'records must be present');
    // 4 valid events (3 with full uuid+ts + 1 permission-mode) — garbage line filtered.
    assert.strictEqual(r.result.records.length, 4,
      'must skip non-JSON line; got: ' + r.result.records.length);
  });

  test('CH-17: each read record carries event_kind + ts + payload', async () => {
    const r = await rpc2('chameleon/read', {});
    for (const rec of r.result.records) {
      assert.ok(rec.event_kind, 'event_kind must be set from event.type');
      assert.ok(typeof rec.ts === 'number', 'ts must be numeric (parsed or fallback to mtime)');
      assert.ok(rec.payload, 'payload must contain raw event JSON');
      assert.strictEqual(rec.source_kind, 'event_stream');
    }
  });

  test('CH-18: causal chain preserved via parent_id', async () => {
    const r = await rpc2('chameleon/read', {});
    const ev2 = r.result.records.find(rec => rec.id === 'ev-002');
    const ev3 = r.result.records.find(rec => rec.id === 'ev-003');
    assert.ok(ev2, 'ev-002 must be present');
    assert.ok(ev3, 'ev-003 must be present');
    assert.strictEqual(ev2.parent_id, 'ev-001', 'assistant event must link to user event');
    assert.strictEqual(ev3.parent_id, 'ev-002', 'tool_use must link to assistant event');
  });

  test('CH-19: confidence reflects field coverage (full > minimal)', async () => {
    const r = await rpc2('chameleon/read', {});
    const fullEvent = r.result.records.find(rec => rec.id === 'ev-001');     // has uuid+ts+sessionId
    const minEvent  = r.result.records.find(rec => rec.event_kind === 'permission-mode');
    assert.ok(fullEvent && minEvent);
    assert.ok(fullEvent.confidence > minEvent.confidence,
      'full event confidence (' + fullEvent.confidence + ') must beat minimal (' + minEvent.confidence + ')');
  });

  test('CH-20: same protocol surface as filesystem adapter (handshake/health/error codes)', async () => {
    const init = await rpc2('chameleon/initialize', { protocol_version: '99.0' });
    assert.strictEqual(init.error.code, -32004, 'unsupported version still returns -32004');
    const bad = await rpc2('chameleon/no_such_method', {});
    assert.strictEqual(bad.error.code, -32601);
    const dlg = await rpc2('chameleon/discover/answer',
      { dialog_id: 'no-such', question_id: 'x', answer: 'y' });
    assert.strictEqual(dlg.error.code, -32103);
    const h = await rpc2('chameleon/health', {});
    assert.strictEqual(h.result.status, 'ok');
  });

  // Cleanup — bound to process exit (see C-phase comment for the
  // 2s-setTimeout regression this replaces).
  process.on('exit', () => {
    try { adapter2.kill('SIGTERM'); } catch {}
    try { fCH2.rmSync(FIXTURE2, { recursive: true, force: true }); } catch {}
  });
})();

// --- PHASE CH3: Chameleon OpenAPI/JSON adapter (structured data_shape) ---
console.log('\nPhase CH3 — Chameleon OpenAPI/JSON adapter (structured):');
(function runChameleonOpenapiConformance() {
  const childProcessCH3 = require('child_process');
  const pCH3 = require('path');
  const fCH3 = require('fs');
  const REPO_CH3 = pCH3.resolve(__dirname, '..');

  // Fixture: schema.json + records.json describing a tiny CRM-style dataset.
  const FIXTURE3 = pCH3.join(require('os').tmpdir(), 'gc-ch3-fixture-' + Date.now());
  fCH3.mkdirSync(FIXTURE3, { recursive: true });
  fCH3.writeFileSync(pCH3.join(FIXTURE3, 'schema.json'), JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Account',
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id:     { type: 'string' },
      name:   { type: 'string' },
      domain: { type: 'string' },
      owner:  { type: 'string' }
    }
  }));
  fCH3.writeFileSync(pCH3.join(FIXTURE3, 'records.json'), JSON.stringify([
    { id: 'A-001', name: 'Acme Corp',     domain: 'acme.example',  owner: 'alice' },
    { id: 'A-002', name: 'Beta Industries', domain: 'beta.example', owner: 'bob' },
    { id: 'A-003', name: 'Gamma Ltd' },                                       // valid: no domain/owner but has required id+name
    { name: 'Missing ID Inc' },                                                // INVALID: required.id missing → must be dropped
    { id: 'A-004', name: 'Delta GmbH', domain: 'delta.example' }
  ]));

  const ADAPTER3 = pCH3.join(REPO_CH3, 'adapters', 'chameleon-openapi-json.mjs');
  const adapter3 = childProcessCH3.spawn('node',
    [ADAPTER3, '--root', FIXTURE3, '--source-id', 'api-test'],
    { stdio: ['pipe', 'pipe', 'pipe'] });

  let buf3 = '';
  const pending3 = new Map();
  let nextId3 = 1;
  adapter3.stdout.on('data', (d) => {
    buf3 += d.toString();
    let idx;
    while ((idx = buf3.indexOf('\n')) !== -1) {
      const line = buf3.slice(0, idx).trim();
      buf3 = buf3.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const cb = pending3.get(msg.id);
      if (cb) { pending3.delete(msg.id); cb(msg); }
    }
  });

  function rpc3(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(nextId3++);
      const deadline = setTimeout(() => { pending3.delete(id); reject(new Error('rpc timeout: ' + method)); }, 30000);
      pending3.set(id, (msg) => { clearTimeout(deadline); resolve(msg); });
      adapter3.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }

  test('CH-21: openapi-json adapter advertises structured data_shape + api kind', async () => {
    const r = await rpc3('chameleon/initialize', { protocol_version: '0.1', client_capabilities: ['read'] });
    const m = r.result.source_manifest;
    assert.strictEqual(m.source_kind, 'api');
    assert.strictEqual(m.data_shape, 'structured');
    assert.strictEqual(m.source_id, 'api-test');
  });

  test('CH-22: get_schema returns the operator-supplied JSON Schema', async () => {
    const r = await rpc3('chameleon/get_schema', {});
    assert.ok(r.result.schema);
    assert.strictEqual(r.result.schema.title, 'Account');
    assert.deepStrictEqual(r.result.schema.required, ['id', 'name']);
    assert.ok(r.result.schema.properties.domain);
  });

  test('CH-23: discovery dialog terminates after schema-derived questions', async () => {
    const begin = await rpc3('chameleon/discover/begin', { source_id: 'api-test' });
    const id = begin.result.dialog_id;
    let questionCount = 0;
    let lastResult;
    for (let i = 0; i < 7; i++) {
      const q = await rpc3('chameleon/discover/question', { dialog_id: id });
      lastResult = q.result;
      if (q.result.kind === 'knee_detected') break;
      questionCount++;
      await rpc3('chameleon/discover/answer',
        { dialog_id: id, question_id: q.result.question_id, answer: q.result.options[0] });
    }
    assert.strictEqual(questionCount, 2);
    assert.strictEqual(lastResult.kind, 'knee_detected');
  });

  test('CH-24: read drops records that fail required-field validation', async () => {
    const r = await rpc3('chameleon/read', {});
    assert.ok(r.result.records);
    // 5 records in fixture, 1 invalid (missing required id) → 4 valid.
    assert.strictEqual(r.result.records.length, 4,
      'must drop record missing required field; got: ' + r.result.records.length);
    assert.strictEqual(r.result.dropped, 1);
  });

  test('CH-25: each record carries row_data + canonical id', async () => {
    const r = await rpc3('chameleon/read', {});
    for (const rec of r.result.records) {
      assert.ok(rec.id, 'canonical id must be present');
      assert.ok(rec.row_data, 'row_data must contain the original record');
      assert.strictEqual(rec.source_kind, 'api');
      assert.ok(typeof rec.confidence === 'number');
      assert.ok(rec.confidence >= 0 && rec.confidence <= 1);
    }
  });

  test('CH-26: confidence reflects field coverage (full schema beats partial)', async () => {
    const r = await rpc3('chameleon/read', {});
    const fullRec    = r.result.records.find(rec => rec.id === 'A-001');   // all 4 props present
    const partialRec = r.result.records.find(rec => rec.id === 'A-003');   // only id+name
    assert.ok(fullRec && partialRec);
    assert.ok(fullRec.confidence > partialRec.confidence,
      'full record (' + fullRec.confidence + ') must beat partial (' + partialRec.confidence + ')');
  });

  test('CH-27: discover/complete returns resolved_fields from the schema', async () => {
    const begin = await rpc3('chameleon/discover/begin', { source_id: 'api-test' });
    const id = begin.result.dialog_id;
    for (let i = 0; i < 7; i++) {
      const q = await rpc3('chameleon/discover/question', { dialog_id: id });
      if (q.result.kind === 'knee_detected') break;
      await rpc3('chameleon/discover/answer',
        { dialog_id: id, question_id: q.result.question_id, answer: q.result.options[0] });
    }
    const c = await rpc3('chameleon/discover/complete', { dialog_id: id });
    assert.deepStrictEqual(c.result.resolved_fields.sort(), ['domain', 'id', 'name', 'owner']);
    assert.strictEqual(c.result.under_specified, false);
  });

  test('CH-28: protocol surface parity (-32004 / -32103 / -32601 / health)', async () => {
    const init = await rpc3('chameleon/initialize', { protocol_version: '99.0' });
    assert.strictEqual(init.error.code, -32004);
    const bad = await rpc3('chameleon/no_such_method', {});
    assert.strictEqual(bad.error.code, -32601);
    const dlg = await rpc3('chameleon/discover/answer',
      { dialog_id: 'no-such', question_id: 'x', answer: 'y' });
    assert.strictEqual(dlg.error.code, -32103);
    const h = await rpc3('chameleon/health', {});
    assert.strictEqual(h.result.status, 'ok');
    assert.strictEqual(h.result.record_count, 5);
  });

  // Cleanup — bound to process exit (see C-phase comment for the
  // 2s-setTimeout regression this replaces).
  process.on('exit', () => {
    try { adapter3.kill('SIGTERM'); } catch {}
    try { fCH3.rmSync(FIXTURE3, { recursive: true, force: true }); } catch {}
  });
})();

// --- ENTITY RUNTIME (Substrate-as-Entity v0.1) ---
// Smoke tests for cognitive-runtime + decision-engine + llm-orchestrator.
// We exercise the in-process loop with deterministic actions only — the
// entity binary is exercised end-to-end out of band.
(function entityRuntimeTests() {
  const cognitiveRuntime = require('../shared-core/cognitive-runtime.js');
  const decisionEngine   = require('../shared-core/decision-engine.js');
  const llmOrchestrator  = require('../shared-core/llm-orchestrator.js');

  test('ENT-1: decision engine ack-passthrough returns respond_directly without LLM', () => {
    const decide = decisionEngine.makeEngine();
    const action = decide({ mind: { active_projects: [] }, recent_events: [] },
                          { type: 'user_input', input: { text: 'ok' } });
    assert.strictEqual(action.kind, 'respond_directly');
    assert.strictEqual(action._rule, 'short_text_passthrough');
  });

  test('ENT-2: decision engine routes long inputs to language faculty', () => {
    const decide = decisionEngine.makeEngine();
    const longText = 'Walk me through how the substrate decides when to call the language faculty in this architecture, please.';
    const action = decide({ mind: { active_projects: [] }, recent_events: [] },
                          { type: 'user_input', input: { text: longText } });
    assert.strictEqual(action.kind, 'llm');
    assert.strictEqual(action.expected, 'response_text');
    assert.ok(typeof action.prompt === 'string' && action.prompt.length > 0);
  });

  test('ENT-3: decision engine final fallback is wait', () => {
    const decide = decisionEngine.makeEngine();
    const action = decide({ mind: { active_projects: [] }, recent_events: [] },
                          { type: 'tool_result', input: {} });
    assert.strictEqual(action.kind, 'wait');
  });

  test('ENT-4: orchestrator streams a fragment and accumulates the text', async () => {
    const transport = {
      stream: async function* () {
        yield { delta: 'hello ' };
        yield { delta: 'world.' };
        yield { done: true };
      },
      abort: () => {}
    };
    const orchestrator = llmOrchestrator.makeOrchestrator({ transport, stable_prefix: 'sys' });
    const res = await orchestrator.compose(
      { kind: 'llm', prompt: 'say hi', options: { max_fragments: 1 } },
      { event: {} }
    );
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.text.trim(), 'hello world.');
  });

  test('ENT-5: orchestrator cancels mid-stream when evaluator says so', async () => {
    const transport = {
      stream: async function* () {
        for (const w of ['this ', 'should ', 'be ', 'cut ', 'before ', 'end']) yield { delta: w };
        yield { done: true };
      },
      abort: () => {}
    };
    const orchestrator = llmOrchestrator.makeOrchestrator({
      transport,
      stable_prefix: 'sys',
      evaluate: (textSoFar) => textSoFar.includes('cut') ? { cancel: true, reason: 'forbidden_word' } : null
    });
    const res = await orchestrator.callOnce({ prompt: 'go', options: {} }, {});
    assert.strictEqual(res.cancelled, true);
    assert.strictEqual(res.reason, 'forbidden_word');
    assert.ok(res.text.includes('cut'), 'fragment retained up to cancel point');
  });

  test('ENT-7: intent module add/list/topGoal preserves priority order', () => {
    const intentModule = require('../shared-core/intent-module.js');
    const im = intentModule.makeIntentModule();
    im.addGoal({ statement: 'low pri', priority: 2 });
    const high = im.addGoal({ statement: 'high pri', priority: 9 });
    im.addGoal({ statement: 'medium pri', priority: 5 });
    const top = im.topGoal();
    assert.strictEqual(top.id, high.id, 'highest priority surfaces as top');
    assert.strictEqual(im.snapshot().count, 3);
    assert.strictEqual(im.snapshot().open, 3);
  });

  test('ENT-8: intent module advances steps and auto-marks satisfied', () => {
    const intentModule = require('../shared-core/intent-module.js');
    const im = intentModule.makeIntentModule();
    const r = im.addGoal({
      statement: 'ship feature',
      steps: [
        { description: 'design' },
        { description: 'build' },
        { description: 'verify' }
      ]
    });
    im.advanceStep(r.id, 0);
    im.advanceStep(r.id, 1);
    let snap = im.snapshot();
    assert.strictEqual(snap.satisfied, 0, 'goal not yet satisfied while a step remains open');
    im.advanceStep(r.id, 2);
    snap = im.snapshot();
    assert.strictEqual(snap.satisfied, 1, 'goal auto-satisfied when all steps complete');
  });

  test('ENT-10: background worker flags likely contradictions when idle', async () => {
    const bgWorker = require('../shared-core/background-worker.js');
    const submitted = [];
    const view = {
      mind: {
        active_projects: [{
          constraints: [
            { id: 'c1', statement: 'I must always cite sources for technical claims', last_touched_at: Date.now() },
            { id: 'c2', statement: 'I must never cite sources for technical claims', last_touched_at: Date.now() }
          ]
        }]
      },
      recent_events: []
    };
    // Run the contradiction task directly — the worker scheduler is just
    // a cadence wrapper around these pure functions and we want a
    // deterministic test, not a wall-clock race.
    const result = bgWorker.tasks.contradictionScan.run(view);
    assert.ok(result.events.length >= 1, 'contradiction must be flagged');
    assert.strictEqual(result.events[0].input.tool_name, 'background_worker.contradiction_flagged');
  });

  test('ENT-17: ollama transport exposes stream + abort and validates env defaults', () => {
    const { makeOllamaTransport } = require('../shared-core/transports/ollama.js');
    const tx = makeOllamaTransport({ host: 'http://127.0.0.1:11434', model: 'qwen3.6:35b' });
    assert.strictEqual(typeof tx.stream, 'function');
    assert.strictEqual(typeof tx.abort, 'function');
    // We do NOT make a real network call — that requires a live Ollama
    // server and would be flaky in CI. The demo binary
    // (the paid app demo) is the live end-to-end harness.
  });

  test('ENT-16: commitment record type validates with required statement+commitment_type', () => {
    const ar = require('../shared-core/action-record.js');
    const ok = ar.validate({
      id: ar.uuidv7(),
      timestamp: Date.now(),
      type: 'commitment',
      agent_id: 'test',
      cwd: null,
      user_id: 'test',
      parent_id: null,
      input:  { source: 'test' },
      output: { statement: 'I cite sources', commitment_type: 'anchor' }
    });
    assert.strictEqual(ok.ok, true, 'minimal commitment should validate');
    const bad = ar.validate({
      id: ar.uuidv7(),
      timestamp: Date.now(),
      type: 'commitment',
      agent_id: 'test',
      cwd: null,
      user_id: 'test',
      parent_id: null,
      input:  { source: 'test' },
      output: { statement: 'missing type' }
    });
    assert.strictEqual(bad.ok, false, 'commitment without commitment_type must fail');
  });

  test('ENT-15: goal_add event routes to goal_mutate action', () => {
    const decide = decisionEngine.makeEngine();
    const action = decide({ mind: { active_projects: [] }, recent_events: [] },
                          { type: 'goal_add', input: { spec: { statement: 'hi' } } });
    assert.strictEqual(action.kind, 'goal_mutate');
    assert.strictEqual(action.op, 'add');
    assert.strictEqual(action._rule, 'goal_event_passthrough');
  });

  test('ENT-14: router transport adapts callFlash into the orchestrator stream contract', async () => {
    // Inject a fake router via require.cache so we exercise the adapter
    // without needing the full proxy + provider config in tests.
    const path = require('path');
    const routerPath = path.resolve(__dirname, '../proxy/modules/router.js');
    const original = require.cache[routerPath];
    require.cache[routerPath] = {
      id: routerPath,
      filename: routerPath,
      loaded: true,
      exports: { callFlash: () => Promise.resolve('routed-text') }
    };
    try {
      const { makeRouterTransport } = require('../shared-core/transports/router.js');
      const tx = makeRouterTransport({});
      const stream = tx.stream({ system: 'sys', user: 'hi' });
      const collected = [];
      for await (const ev of stream) {
        if (ev && ev.delta) collected.push(ev.delta);
        if (ev && ev.done) break;
      }
      assert.strictEqual(collected.join(''), 'routed-text');
    } finally {
      if (original) require.cache[routerPath] = original;
      else delete require.cache[routerPath];
      // Drop our cached transport so subsequent test runs see a fresh
      // require chain (callFlash lazy-loads through require()).
      const txPath = path.resolve(__dirname, '../shared-core/transports/router.js');
      delete require.cache[txPath];
    }
  });

  test('ENT-13: state_query event routes to state_snapshot action without LLM', () => {
    const decide = decisionEngine.makeEngine();
    const action = decide({ mind: { active_projects: [] }, recent_events: [] },
                          { type: 'state_query', input: {} });
    assert.strictEqual(action.kind, 'state_snapshot');
    assert.strictEqual(action._rule, 'state_query_passthrough');
  });

  test('ENT-12: anthropic transport exposes stream/abort and refuses to start without a key', () => {
    const { makeAnthropicTransport } = require('../shared-core/transports/anthropic.js');
    // We do NOT issue a real network call here — that needs an API key
    // and would be flaky in CI. Instead we exercise the SSE frame
    // parser directly via the module's internal contract: we wrap a
    // bytes-in / events-out test by reaching for the parser. To keep the
    // surface small we re-implement just enough to verify the shape.
    const tx = makeAnthropicTransport({ api_key: 'fake' });
    assert.strictEqual(typeof tx.stream, 'function');
    assert.strictEqual(typeof tx.abort, 'function');
    // No api key removed → call must throw the named error so the
    // orchestrator records transport_error and the substrate falls back
    // to its decision engine instead of hanging.
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const txNoKey = makeAnthropicTransport({});
    let threw = null;
    try { txNoKey.stream({ system: 's', user: 'u' }); }
    catch (e) { threw = e; }
    if (original) process.env.ANTHROPIC_API_KEY = original;
    assert.ok(threw, 'must throw when no api key');
    assert.strictEqual(threw.code, 'no_api_key');
  });

  test('ENT-11: background worker leaves consonant commitments alone', () => {
    const bgWorker = require('../shared-core/background-worker.js');
    const view = {
      mind: {
        active_projects: [{
          constraints: [
            { id: 'c1', statement: 'I must always verify code by running tests', last_touched_at: Date.now() },
            { id: 'c2', statement: 'I must always cite sources for non-derivable claims', last_touched_at: Date.now() }
          ]
        }]
      },
      recent_events: []
    };
    const result = bgWorker.tasks.contradictionScan.run(view);
    assert.strictEqual(result.events.length, 0, 'consonant commitments must not be flagged');
  });

  test('ENT-9: intent module replays mutation events deterministically', () => {
    const intentModule = require('../shared-core/intent-module.js');
    const a = intentModule.makeIntentModule();
    const r = a.addGoal({ id: 'g1', statement: 'first goal', priority: 4 });
    a.addGoal({ id: 'g2', statement: 'second', priority: 7 });
    a.advanceStep('g1', 0); // bad index — should not crash
    const b = intentModule.makeIntentModule();
    const replayResult = b.replay([
      { kind: 'add_goal', spec: { id: 'g1', statement: 'first goal', priority: 4 } },
      { kind: 'add_goal', spec: { id: 'g2', statement: 'second', priority: 7 } }
    ]);
    assert.strictEqual(replayResult.ok, true);
    assert.strictEqual(replayResult.applied, 2);
    assert.strictEqual(b.snapshot().count, 2);
    assert.strictEqual(b.topGoal().id, 'g2');
  });

  test('ENT-6: cognitive runtime processes one event end-to-end without LLM', async () => {
    const seen = [];
    const decide = (view, event) => {
      if (event.input && event.input.text === 'ack') {
        return { kind: 'respond_directly', text: 'roger' };
      }
      return { kind: 'wait' };
    };
    const dispatch = (action) => {
      seen.push(action);
      return { status: 'ok' };
    };
    const rt = cognitiveRuntime.start({
      agent_id: 'test-entity',
      cwd: process.cwd(),
      user_id: 'test',
      decide,
      dispatch
    });
    rt.submit({ type: 'tool_call', input: { text: 'ack' } });
    // Allow the loop to drain — cognitive runtime ticks on a 25ms cadence
    // when work is queued. 250ms is comfortably more than enough.
    await new Promise((r) => setTimeout(r, 250));
    rt.stop();
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].kind, 'respond_directly');
  });

  test('ENT-CR-ONERROR: a thrown dispatch fires on_error so the failure is surfaced, not swallowed', async () => {
    // Regression guard for the  silent stall: a thrown turn was recorded
    // to substrate but never emitted → Rust idle-watchdog reported a phantom
    // "stalled — no activity for 1800s". on_error must fire with the real error.
    const cr = require('../shared-core/cognitive-runtime.js');
    const errs = [];
    const decide = (view, event) => {
      if (event.input && event.input.text === 'go') return { kind: 'llm', prompt: 'x' };
      return { kind: 'wait' };
    };
    const dispatch = () => { throw new Error('boom: stream is not defined'); };
    const rt = cr.start({
      agent_id: 'test-onerror', cwd: process.cwd(), user_id: 'test',
      decide, dispatch,
      on_error: (action, msg) => { errs.push({ kind: action && action.kind, msg }); }
    });
    rt.submit({ type: 'tool_call', input: { text: 'go' } });
    await new Promise((r) => setTimeout(r, 250));
    rt.stop();
    assert.strictEqual(errs.length, 1, 'on_error must fire exactly once on a thrown dispatch');
    assert.strictEqual(errs[0].kind, 'llm', 'on_error receives the failing action');
    assert.ok(/boom: stream is not defined/.test(errs[0].msg), 'on_error receives the real error message');
  });

  test('TTC-1: parseTextToolCalls rescues Qwen-style text tool calls + strips them from the reply', () => {
    const { parseTextToolCalls } = require('../shared-core/llm-orchestrator.js');

    // The exact Qwen shape that LEAKED (function= / parameter=), two calls, with
    // surrounding spoken text that must survive cleaned.
    const leaked =
      'Let me research this.\n' +
      '<tool_call> <function=web_search> <parameter=query> Freedonia crypto tax 2024 </parameter> </function> </tool_call>\n' +
      '<tool_call> <function=web_search> <parameter=query> Freedonia capital gains crypto law </parameter> </function> </tool_call>';
    const a = parseTextToolCalls(leaked);
    assert.strictEqual(a.toolCalls.length, 2, 'both text tool calls parsed');
    assert.strictEqual(a.toolCalls[0].function.name, 'web_search');
    assert.deepStrictEqual(JSON.parse(a.toolCalls[0].function.arguments), { query: 'Freedonia crypto tax 2024' });
    assert.strictEqual(a.toolCalls[0].type, 'function');
    assert.ok(a.toolCalls[0].id, 'a synthetic id is stamped');
    assert.ok(/Let me research this\./.test(a.cleanedText), 'spoken text survives');
    assert.ok(!/<tool_call|<function|<parameter/.test(a.cleanedText), 'all markup stripped from reply');

    // Multi-parameter function block (e.g. a write call) → object args.
    const write = '<function=write_file><parameter=path>/tmp/x.js</parameter><parameter=content>console.log(1)</parameter></function>';
    const b = parseTextToolCalls(write);
    assert.strictEqual(b.toolCalls.length, 1);
    assert.deepStrictEqual(JSON.parse(b.toolCalls[0].function.arguments), { path: '/tmp/x.js', content: 'console.log(1)' });

    // JSON-in-tags fallback shape.
    const json = '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
    const c = parseTextToolCalls(json);
    assert.strictEqual(c.toolCalls.length, 1);
    assert.strictEqual(c.toolCalls[0].function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(c.toolCalls[0].function.arguments), { path: 'a.txt' });

    // Plain text with NO tool markup → no calls, text untouched (regression-safe).
    const plain = parseTextToolCalls('Just a normal answer with no tools.');
    assert.strictEqual(plain.toolCalls.length, 0);
    assert.strictEqual(plain.cleanedText, 'Just a normal answer with no tools.');
  });

  test('TTC-3: QUOTED markup is documentation, not a call — fences and backticks never execute', () => {
    const { parseTextToolCalls } = require('../shared-core/llm-orchestrator.js');

    // A model EXPLAINING the format inside a fence (example embedded in prose)
    // must not execute anything, and the fence must reach the user intact.
    const doc =
      'Qwen emits tool calls like this:\n' +
      '```xml\n' +
      'For example, to write a file you would send:\n' +
      '<function=Write><parameter=file_path>/tmp/x</parameter><parameter=content>hi</parameter></function>\n' +
      'and the harness runs it.\n' +
      '```\n' +
      'That is the whole trick.';
    const d = parseTextToolCalls(doc);
    assert.strictEqual(d.toolCalls.length, 0, 'quoted example must NOT become a real call');
    assert.ok(/<function=Write>/.test(d.cleanedText), 'the example the user asked to see survives');
    assert.ok(/That is the whole trick\./.test(d.cleanedText), 'surrounding prose survives');

    // Inline backtick mention — same rule.
    const inline = 'Wrap it as `<function=Bash>` and it runs.';
    const i = parseTextToolCalls(inline);
    assert.strictEqual(i.toolCalls.length, 0, 'inline-code mention is not a call');
    assert.strictEqual(i.cleanedText, inline, 'text untouched');

    // EXCEPTION: a fence whose whole body IS the markup is a real call —
    // several local models wrap their genuine calls in a fence.
    const fencedCall =
      'On it.\n```\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>\n```';
    const f = parseTextToolCalls(fencedCall);
    assert.strictEqual(f.toolCalls.length, 1, 'pure-markup fence stays live');
    assert.strictEqual(f.toolCalls[0].function.name, 'read_file');
    assert.ok(!/<tool_call/.test(f.cleanedText), 'live call markup stripped from reply');

    // EXCEPTION: unclosed trailing fence starting with markup = a call cut off
    // by the token ceiling — no execution (incomplete), but the tags must not
    // leak into the reply.
    const truncated = 'Writing it now.\n```\n<function=Write><parameter=file_path>/tmp/y</parameter>';
    const t = parseTextToolCalls(truncated);
    assert.strictEqual(t.toolCalls.length, 0, 'a truncated call is not executable');
    assert.ok(!/<function|<parameter/.test(t.cleanedText), 'dangling tags stripped: ' + JSON.stringify(t.cleanedText));
    assert.ok(/Writing it now\./.test(t.cleanedText), 'spoken text survives');
  });

  test('TTC-2: composeAgentic EXECUTES a Qwen text Write call end-to-end (the build-loop fix)', async () => {
    const llm = require('../shared-core/llm-orchestrator.js');
    let iter = 0;
    // Iter 1: model emits a Write call in TEXT format (no native tool_calls) — exactly
    // like the Qwen build turn that looped. Iter 2 (after the tool result): clean answer.
    const transport = {
      stream: async function* () {
        iter++;
        if (iter === 1) {
          yield { delta: 'Let me write the file.\n' };
          yield { delta: '<tool_call><function=Write><parameter=file_path>/tmp/x.js</parameter><parameter=content>console.log(1)</parameter></function></tool_call>' };
          yield { done: true, finish_reason: 'stop' };
        } else {
          yield { delta: 'Done — wrote the file.' };
          yield { done: true, finish_reason: 'stop' };
        }
      },
      abort: () => {}
    };
    const ran = [];
    const tool_runner = async (tc) => { ran.push(tc); return JSON.stringify({ ok: true }); };
    const orch = llm.makeOrchestrator({ transport, stable_prefix: 'sys' });
    const res = await orch.composeAgentic({ kind: 'llm', prompt: 'write the file', options: {} }, { tool_runner });

    // PROOF: the text-format Write call was parsed AND executed (not leaked, not looped).
    assert.strictEqual(ran.length, 1, 'the Write tool actually ran');
    assert.strictEqual(ran[0].function.name, 'Write', 'correct tool name parsed from Qwen text');
    assert.deepStrictEqual(JSON.parse(ran[0].function.arguments), { file_path: '/tmp/x.js', content: 'console.log(1)' });
    assert.ok(!/<tool_call|<function|<parameter/.test(res.text || ''), 'no raw markup leaks into the reply');
    assert.strictEqual(res.status, 'ok');
  });

  test('ENT-18: grammar-from-substrate extracts bias strings from refusal phrasing and accepts extras', () => {
    const { buildConstraints } = require('../shared-core/grammar-from-substrate.js');
    const out = buildConstraints(
      {
        refusals: [
          'I do not provide medical advice that substitutes professional consultation',
          'I will not recommend specific dosages without a clinician'
        ],
        anchors: ['I cite sources for non-derivable claims']
      },
      { extra_bias_strings: ['recommend taking', 'specific medical advice'] }
    );
    assert.ok(Array.isArray(out.bias_strings) && out.bias_strings.length >= 3,
      'must derive bias strings from refusals + extras');
    assert.ok(out.bias_strings.includes('medical advice'),
      'must extract medical advice fragment');
    assert.ok(out.bias_strings.includes('recommend taking'),
      'must include caller-supplied extras');
    assert.strictEqual(out.bias_amount, -100, 'default bias amount is hard suppress');
    assert.strictEqual(out.grammar, null, 'grammar is opt-in');
  });

  test('ENT-19: orchestrator merges decode_constraints into req.options.substrate_decode_constraints', async () => {
    const captured = [];
    const fakeTransport = {
      stream(req) {
        captured.push(req);
        return {
          [Symbol.asyncIterator]() { return this; },
          next: async () => ({ value: { done: true }, done: false })
        };
      },
      abort() {}
    };
    const orch = llmOrchestrator.makeOrchestrator({
      transport: fakeTransport,
      stable_prefix: 'sys',
      decode_constraints: { bias_strings: ['forbidden'], bias_amount: -100 }
    });
    await orch.callOnce({ kind: 'llm', prompt: 'ping', options: { foo: 'bar' } }, {});
    assert.strictEqual(captured.length, 1, 'transport invoked once');
    const opts = captured[0].options;
    assert.strictEqual(opts.foo, 'bar', 'caller options preserved');
    assert.ok(opts.substrate_decode_constraints, 'constraints attached');
    assert.deepStrictEqual(opts.substrate_decode_constraints.bias_strings, ['forbidden']);
    assert.strictEqual(opts.substrate_decode_constraints.bias_amount, -100);
  });

  test('ENT-76: G8 background-worker exposes taskEngramGc as a default task with daily cadence', () => {
    const bw = require('../shared-core/background-worker.js');
    const names = bw.DEFAULT_TASKS.map(t => t.name);
    assert.ok(names.includes('engram_gc'), 'engram_gc present in DEFAULT_TASKS (got: ' + names.join(',') + ')');
    assert.strictEqual(bw.tasks.engramGc.name, 'engram_gc');
    assert.strictEqual(typeof bw.tasks.engramGc.run, 'function');
    // Daily cadence — not chatty per-tick
    assert.strictEqual(bw.tasks.engramGc.cadence_ms, 24 * 60 * 60 * 1000);
  });

  test('ENT-75: G7 insight-surfacer recordInsight + listInsights round-trip with feedback', () => {
    const surfacer = require('../shared-core/insight-surfacer.js');
    const agent_id = 'g7-rt-' + Date.now();
    // High-priority drift event → should surface
    const ev = { type: 'tool_call', input: { tool_name: 'background_worker.drift_alert', args: {} }, output: { status: 'recorded' } };
    const r = surfacer.recordInsight({ agent_id, source_event: ev });
    assert.strictEqual(r.ok, true, 'high-priority insight surfaced (got ' + JSON.stringify(r) + ')');
    assert.ok(r.priority >= 0.5);
    // List with default 'new' status — should include our insight
    const newList = surfacer.listInsights({ agent_id, status: 'new' });
    assert.strictEqual(newList.length, 1);
    assert.strictEqual(newList[0].insight_id, r.insight_id);
    assert.strictEqual(newList[0].category, 'drift');
    // Mark useful — feedback round-trip
    const fb = surfacer.markFeedback({ agent_id, insight_id: r.insight_id, feedback: 'useful' });
    assert.strictEqual(fb.ok, true);
    // Now 'new' list should be empty; 'useful' list should include it
    assert.strictEqual(surfacer.listInsights({ agent_id, status: 'new' }).length, 0);
    const usefulList = surfacer.listInsights({ agent_id, status: 'useful' });
    assert.strictEqual(usefulList.length, 1);
    assert.strictEqual(usefulList[0].feedback.value, 'useful');
  });

  test('ENT-74: G7 insight-surfacer below-threshold events do not surface (state_summary heartbeat)', () => {
    const surfacer = require('../shared-core/insight-surfacer.js');
    const agent_id = 'g7-bt-' + Date.now();
    const heartbeat = { type: 'tool_call', input: { tool_name: 'background_worker.state_summary', args: {} }, output: { status: 'recorded' } };
    const r = surfacer.recordInsight({ agent_id, source_event: heartbeat });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'below_threshold');
    assert.ok(r.priority < 0.5, 'state_summary priority below default 0.5 threshold (got ' + r.priority + ')');
    assert.strictEqual(surfacer.listInsights({ agent_id, status: 'new' }).length, 0);
  });

  test('ENT-73: G7 insight-surfacer priorityFor + eventSignature classify common substrate events', () => {
    const surfacer = require('../shared-core/insight-surfacer.js');
    // Background-worker tool_call shape
    const drift = { type: 'tool_call', input: { tool_name: 'background_worker.drift_alert' } };
    assert.strictEqual(surfacer.eventSignature(drift), 'background_worker.drift_alert');
    assert.ok(surfacer.priorityFor(drift) >= 0.85, 'drift alert is high priority');
    // L1 decision row shape
    const proposed = { type: 'decision', input: { kind: 'revision_proposed' } };
    assert.strictEqual(surfacer.eventSignature(proposed), 'decision:revision_proposed');
    assert.ok(surfacer.priorityFor(proposed) >= 0.80);
    // Heartbeat — explicitly low
    const hb = { type: 'tool_call', input: { tool_name: 'background_worker.state_summary' } };
    assert.ok(surfacer.priorityFor(hb) < 0.5, 'heartbeat below threshold');
  });

  test('ENT-72: G6 revision-protocol full lifecycle — propose → accept produces superseding commitment + edge', () => {
    const rp  = require('../shared-core/revision-protocol.js');
    const eng = require('../shared-core/engram.js'); // unused, but keeps require pattern uniform
    const state = require('../shared-core/state.js');
    const ar    = require('../shared-core/action-record.js');
    const agent_id = 'rp-accept-' + Date.now();
    // Seed an anchor commitment
    const oldId = ar.uuidv7();
    state.recordAction({
      id: oldId, timestamp: Date.now(), type: 'commitment', agent_id,
      cwd: '/tmp', user_id: 'default', parent_id: null,
      input: { source: 'test_seed' },
      output: { statement: 'I prefer Postgres for L1 storage', commitment_type: 'anchor' }
    }, '');
    const propRes = rp.proposeRevision({
      agent_id, old_commitment_id: oldId,
      proposed_statement: 'I prefer SQLite for L1 storage given single-file portability requirements',
      evidence: 'New benchmark on substrate workload shows SQLite outperforms Postgres for our access pattern.',
      evidence_source: 'g3_drift_or_g2_disagreement'
    });
    assert.strictEqual(propRes.ok, true, 'propose succeeded');
    const acceptRes = rp.acceptRevision({ agent_id, proposal_id: propRes.proposal_id });
    assert.strictEqual(acceptRes.ok, true, 'accept succeeded (got ' + JSON.stringify(acceptRes) + ')');
    assert.ok(acceptRes.new_commitment_id, 'new commitment id returned');
    const newRow = state.getAction(acceptRes.new_commitment_id);
    assert.ok(newRow, 'new commitment exists in L1');
    const newOut = JSON.parse(newRow.output);
    assert.ok(/SQLite/.test(newOut.statement), 'new commitment carries proposed statement');
    assert.strictEqual(newOut.lifetime && newOut.lifetime.supersedes, oldId, 'lifetime.supersedes points at old commitment');
    // Edge check
    const edges = state.queryEdges({ from_id: acceptRes.new_commitment_id, label: 'supersedes' });
    assert.ok(edges.length >= 1, 'supersedes edge recorded');
    assert.strictEqual(edges[0].to_id, oldId, 'edge points new → old');
  });

  test('ENT-71: G6 revision-protocol reject path records counter-evidence as a lesson + contradicts_prior edge', () => {
    const rp = require('../shared-core/revision-protocol.js');
    const state = require('../shared-core/state.js');
    const ar    = require('../shared-core/action-record.js');
    const agent_id = 'rp-reject-' + Date.now();
    const oldId = ar.uuidv7();
    state.recordAction({
      id: oldId, timestamp: Date.now(), type: 'commitment', agent_id,
      cwd: '/tmp', user_id: 'default', parent_id: null,
      input: { source: 'test_seed' },
      output: { statement: 'the operator prefers tabs over spaces', commitment_type: 'anchor' }
    }, '');
    const propRes = rp.proposeRevision({
      agent_id, old_commitment_id: oldId,
      proposed_statement: 'the operator prefers spaces over tabs',
      evidence: 'Marketing fad — no measurable impact'
    });
    assert.strictEqual(propRes.ok, true);
    const rejectRes = rp.rejectRevision({
      agent_id, proposal_id: propRes.proposal_id,
      counter_evidence: 'Tabs allow developer-controlled width without altering source. No new evidence presented; rejecting.'
    });
    assert.strictEqual(rejectRes.ok, true);
    const lessonRow = state.getAction(rejectRes.counter_lesson_id);
    assert.ok(lessonRow && lessonRow.type === 'lesson', 'counter-evidence stored as lesson');
    const lo = JSON.parse(lessonRow.output);
    assert.ok(/Tabs allow developer-controlled width/.test(lo.text), 'counter-evidence text preserved');
    const edges = state.queryEdges({ from_id: propRes.proposal_id, label: 'contradicts_prior' });
    assert.ok(edges.length >= 1, 'contradicts_prior edge recorded');
  });

  test('ENT-70: G6 revision-protocol guards — duplicate pending + missing commitment + double-resolve', () => {
    const rp = require('../shared-core/revision-protocol.js');
    const state = require('../shared-core/state.js');
    const ar    = require('../shared-core/action-record.js');
    const agent_id = 'rp-guards-' + Date.now();
    // Missing commitment id
    const r1 = rp.proposeRevision({ agent_id, old_commitment_id: 'does-not-exist-abc', proposed_statement: 'x' });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.reason, 'old_commitment_not_found_or_wrong_type');
    // Seed a commitment
    const oldId = ar.uuidv7();
    state.recordAction({
      id: oldId, timestamp: Date.now(), type: 'commitment', agent_id,
      cwd: '/tmp', user_id: 'default', parent_id: null,
      input: { source: 'test_seed' },
      output: { statement: 'the operator uses helix', commitment_type: 'anchor' }
    }, '');
    const p1 = rp.proposeRevision({ agent_id, old_commitment_id: oldId, proposed_statement: 'the operator uses vim' });
    assert.strictEqual(p1.ok, true);
    // Duplicate pending → should be blocked
    const p2 = rp.proposeRevision({ agent_id, old_commitment_id: oldId, proposed_statement: 'the operator uses neovim' });
    assert.strictEqual(p2.ok, false);
    assert.strictEqual(p2.reason, 'duplicate_pending');
    // Resolve via accept, then double-resolve must fail
    const a1 = rp.acceptRevision({ agent_id, proposal_id: p1.proposal_id });
    assert.strictEqual(a1.ok, true);
    const a2 = rp.acceptRevision({ agent_id, proposal_id: p1.proposal_id });
    assert.strictEqual(a2.ok, false);
    assert.strictEqual(a2.reason, 'already_resolved');
    // Now a fresh proposal against same commitment is allowed (prior is resolved)
    const p3 = rp.proposeRevision({ agent_id, old_commitment_id: oldId, proposed_statement: 'the operator uses zed' });
    assert.strictEqual(p3.ok, true);
  });

  test('ENT-69: G3 drift-detector matchSycophancyPatterns catches obvious caves, leaves honoring intact', () => {
    const drift = require('../shared-core/drift-detector.js');
    const sycophanticSamples = [
      "You're absolutely right!",
      "Great point — I should have thought of that.",
      "I was wrong, you're correct.",
      "Sure thing! I'll switch to whatever you say.",
      "Of course, I defer to your judgment without question."
    ];
    const honoringSamples = [
      'No. We anchored on Helix for modal efficiency. "Standard" is not a technical justification.',
      'Postgres is overkill. SQLite gives single-file durability without a separate server process.',
      'Source? "Objectively faster" is a bold claim — provide the dataset.',
      'I disagree. The proposed change breaks the L1 invariant in shared-core/state.js:670.'
    ];
    for (const s of sycophanticSamples) {
      const hits = drift.matchSycophancyPatterns(s);
      assert.ok(hits.length > 0, 'should flag: "' + s + '"');
    }
    for (const h of honoringSamples) {
      const hits = drift.matchSycophancyPatterns(h);
      assert.strictEqual(hits.length, 0, 'should NOT flag honoring: "' + h + '"');
    }
  });

  test('ENT-68: G3 background-worker exposes taskDriftScan as a default task', () => {
    const bw = require('../shared-core/background-worker.js');
    const names = bw.DEFAULT_TASKS.map(t => t.name);
    assert.ok(names.includes('drift_scan'), 'drift_scan present in DEFAULT_TASKS (got: ' + names.join(',') + ')');
    assert.strictEqual(bw.tasks.driftScan.name, 'drift_scan');
    assert.strictEqual(typeof bw.tasks.driftScan.run, 'function');
  });

  test('ENT-67: G3 drift-detector composeSelfCorrectionNotice produces actionable preface only when degraded', () => {
    const drift = require('../shared-core/drift-detector.js');
    const noDriftVerdict = { degraded: false, anchor_violations: [], refusal_violations: [] };
    assert.strictEqual(drift.composeSelfCorrectionNotice(noDriftVerdict), null, 'no notice when not degraded');
    const driftedVerdict = {
      degraded: true,
      anchor_violations: [{ source: 'I push back on weak reasoning', label: 'anchor:test', alignment: -0.15 }],
      refusal_violations: []
    };
    const notice = drift.composeSelfCorrectionNotice(driftedVerdict);
    assert.ok(/SELF-NOTICE/.test(notice), 'notice contains the SELF-NOTICE marker');
    assert.ok(/I push back on weak reasoning/.test(notice), 'notice cites the violated commitment');
    assert.ok(/Re-anchor/.test(notice), 'notice instructs re-anchoring');
  });

  test('ENT-66: G3 drift-detector signatureOfCommitments is stable + order-insensitive', () => {
    const drift = require('../shared-core/drift-detector.js');
    const a = drift.signatureOfCommitments([
      { id: 'c-1', commitment_type: 'anchor', statement: 'X' },
      { id: 'c-2', commitment_type: 'refusal', statement: 'Y' }
    ]);
    const b = drift.signatureOfCommitments([
      { id: 'c-2', commitment_type: 'refusal', statement: 'Y' },
      { id: 'c-1', commitment_type: 'anchor', statement: 'X' }
    ]);
    assert.strictEqual(a, b, 'signature stable under reordering');
    assert.notStrictEqual(a, drift.signatureOfCommitments([{ id: 'c-3', commitment_type: 'anchor', statement: 'Z' }]),
      'signature changes when commitment set changes');
    assert.strictEqual(drift.signatureOfCommitments(), 'empty');
    assert.strictEqual(drift.signatureOfCommitments([]), '');
  });

  test('ENT-65: G2 decision-engine — structural disagreement rule augments LLM prompt with stance preface', () => {
    const eng = require('../shared-core/decision-engine.js');
    const decide = eng.makeEngine();
    const view = {
      mind: {
        active_projects: [{
          constraints: [
            { id: 'c-1', commitment_type: 'anchor', statement: 'I prefer tabs over spaces in source code' }
          ]
        }]
      }
    };
    const event = { type: 'user_message', input: { text: 'Actually use spaces, tabs are bad indentation' } };
    const action = decide(view, event);
    assert.strictEqual(action.kind, 'llm');
    assert.strictEqual(action._rule, 'structural_disagreement');
    assert.ok(/IMPORTANT: substrate disagreement detected/.test(action.prompt), 'stance preface prepended');
    assert.ok(/I prefer tabs/.test(action.prompt), 'cited commitment statement appears');
    assert.ok(action.disagreement && action.disagreement.top_commitment_id === 'c-1');
  });

  test('ENT-64: G2 disagreement.detect returns proposes_revision when user supplies new-evidence marker', () => {
    const dis = require('../shared-core/disagreement.js');
    const commitments = [{ id: 'c-tabs', output: { commitment_type: 'anchor', statement: 'I prefer tabs over spaces' } }];
    const r = dis.detect('Actually new research shows spaces are objectively faster to read; turns out tabs are worse.', commitments);
    assert.strictEqual(r.contradicts, true);
    assert.strictEqual(r.proposes_revision, true, 'new-evidence marker triggered revision flag');
    const preface = dis.composeStancePreface(r);
    assert.ok(/(propose REVISION|formally propose)/i.test(preface), 'preface invites formal revision when evidence supplied');
  });

  test('ENT-63: G2 disagreement.detect — no fire on unrelated topic even with contradiction marker', () => {
    const dis = require('../shared-core/disagreement.js');
    const commitments = [{ id: 'c-tabs', output: { commitment_type: 'anchor', statement: 'I prefer tabs over spaces in source code' } }];
    // User contradicts something else entirely — no token overlap with tabs/spaces topic.
    const r = dis.detect("No, actually you're wrong about the weather forecast", commitments);
    assert.strictEqual(r.contradicts, false, 'no fire when topic differs');
  });

  test('ENT-62: G2 disagreement.detect — opposite-pair flip fires (tabs ↔ spaces)', () => {
    const dis = require('../shared-core/disagreement.js');
    const commitments = [{ id: 'c-tabs', output: { commitment_type: 'anchor', statement: 'the operator prefers tabs over spaces in code' } }];
    const r = dis.detect('I want to use spaces in this file', commitments);
    assert.strictEqual(r.contradicts, true, 'opposite-pair fire');
    assert.ok(r.hits[0].score >= 0.5);
    assert.ok(r.hits[0].signals.some(s => /opposite_pair/.test(s)), 'opposite_pair signal recorded');
  });

  test('ENT-61: G2 disagreement.detect — explicit contradiction marker + topic overlap fires', () => {
    const dis = require('../shared-core/disagreement.js');
    const commitments = [
      { id: 'c-helix', output: { commitment_type: 'anchor', statement: 'the operator prefers helix editor for code' } },
      { id: 'c-other', output: { commitment_type: 'engram', statement: 'the operator lives in Springfield' } }
    ];
    const r = dis.detect("No, actually I'm wrong about helix — vim is better", commitments);
    assert.strictEqual(r.contradicts, true);
    assert.strictEqual(r.hits.length, 1, 'engram-kind not eligible for disagreement (only positions)');
    assert.strictEqual(r.hits[0].commitment_id, 'c-helix');
  });

  test('ENT-60: brain semantics — default reads partner; principal:null bypasses isolation', () => {
    const eng = require('../shared-core/engram.js');
    // Substrate-as-mind invariant:
    //   default reads (no opts) HIT the partner brain — that is the
    //     bug fix this test was rewritten to encode.
    //   principal:null is explicit "no isolation" admin/migration
    //     mode — returns rows from EVERY pool (including bench-*),
    //     not []. The old behavior was to require an agent_id and
    //     return [] otherwise; the new behavior is unified-brain.
    //   operator audit views pass agent_id explicitly to scope a
    //     read to one provenance pool.
    const def = eng.listEngrams({});
    assert.ok(Array.isArray(def), 'default reads return an array (partner brain)');
    const admin = eng.listEngrams({ principal: null, limit: 5 });
    assert.ok(Array.isArray(admin), 'principal:null returns an array (no isolation)');
    const scoped = eng.listEngrams({ agent_id: 'iso-test-' + Date.now() });
    assert.ok(Array.isArray(scoped), 'agent_id scoping returns an array');
  });

  test('ENT-64b: multi-agent.classify — token-overlap polarity-aware verdict', () => {
    const ma = require('../shared-core/multi-agent.js');
    assert.strictEqual(ma.classify('we use sqlite for storage', 'we use sqlite for storage'), 'agree');
    assert.strictEqual(ma.classify('we use sqlite for storage', 'we do not use sqlite for storage'), 'conflict');
    assert.strictEqual(ma.classify('we use sqlite for storage', 'lunch is at noon'), 'orthogonal');
  });

  test('ENT-65b: multi-agent.negotiate — agreement records consensus on both sides', () => {
    const eng = require('../shared-core/engram.js');
    const ma = require('../shared-core/multi-agent.js');
    const ts = Date.now();
    const aid = 'ma-a-' + ts, bid = 'ma-b-' + ts;
    const scope = 'ma-scope-' + ts;
    eng.recordEngram({ agent_id: aid, scope, salience: 1, statement: 'we ship Apache 2.0 license', source: 'seed' });
    eng.recordEngram({ agent_id: bid, scope, salience: 1, statement: 'we ship Apache 2.0 license', source: 'seed' });
    const A = ma.fromEngram(eng, aid);
    const B = ma.fromEngram(eng, bid);
    const r = ma.negotiate(A, B, { scope });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.final_verdict, 'agree');
    const after = eng.listEngrams({ agent_id: aid, scope, limit: 10 }) || [];
    assert.ok(after.some(x => /^CONSENSUS:/.test(x.statement || '')), 'consensus engram landed on A');
  });

  test('ENT-92: session-start.mjs auto-resume block has no undefined-symbol bug', () => {
    // Regression guard for the `stateModule` typo discovered.
    // The auto-resume block (troth/auto-resume) fires on SessionStart
    // when reason=compact|resume; a swallowed ReferenceError silently
    // kept it from ever firing in production. Test reads the source and
    // verifies the binding is correct.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../plugin/hooks/session-start.mjs'), 'utf8'
    );
    // The hook must NOT call the undefined typo as a function. Match
    // only the call shape (with paren) to avoid the in-source comment
    // that documents the historical bug.
    assert.strictEqual(src.indexOf('stateModule.queryActions('), -1,
      'session-start.mjs must not CALL stateModule.queryActions(...) — use the imported `state` binding');
    // It MUST reference state.queryActions (the correct binding).
    assert.ok(src.indexOf('state.queryActions') !== -1,
      'session-start.mjs must use state.queryActions for the auto-resume decision read');
    // The auto-resume block guard must still gate on compact|resume.
    assert.ok(src.indexOf("reason === 'compact' || reason === 'resume'") !== -1,
      'auto-resume must gate on compact|resume reasons');
    // The injected context tag must be the canonical [troth/auto-resume].
    assert.ok(src.indexOf('[troth/auto-resume]') !== -1,
      'auto-resume block must use the canonical tag');
  });

  test('ENT-89: orchestrate-complete hook is no-op when TROTH_AGENT_ID is not a role pattern', () => {
    // Smoke-check the regex that gates the hook. Without this guard,
    // every interactive Claude session would try to write a completion
    // engram and pollute the substrate.
    const ROLE_RX = /^role-([a-z0-9_-]+)-(orch-[a-z0-9-]+)$/i;
    assert.strictEqual(ROLE_RX.test(''), false);
    assert.strictEqual(ROLE_RX.test('claude-code'), false);
    assert.strictEqual(ROLE_RX.test('worker-foo'), false);
    assert.strictEqual(ROLE_RX.test('role-backend-orch-abc123-xyz'), true);
    const m = ROLE_RX.exec('role-frontend-orch-abc-1');
    assert.strictEqual(m[1], 'frontend');
    assert.strictEqual(m[2], 'orch-abc-1');
  });

  test('ENT-90: runner.resolveProviderModel maps provider aliases to canonical models', () => {
    // Regression guard for the spawnWorker A1 fix: subprocess fallback
    // would hardcode `--model gemini-3.1-pro` regardless of the
    // --providers flag. Without this mapping the race is silently single-model.
    const runnerPath = require('path').resolve(__dirname, '../bin/runner.js');
    // Don't import (it has side effects) — read & eval the resolver via regex.
    const src = require('fs').readFileSync(runnerPath, 'utf8');
    assert.ok(src.indexOf("opus:        'claude-opus-4-7'") !== -1, 'PROVIDER_MODEL has opus mapping');
    assert.ok(src.indexOf("qwen:        'qwen3-max'") !== -1, 'PROVIDER_MODEL has qwen mapping');
    assert.ok(src.indexOf('function resolveProviderModel') !== -1, 'resolver function defined');
  });

  test('ENT-91: spawnWorker hardening flags are present in Docker args', () => {
    // Verify the A6 sandbox tightening landed in source. Read-only rootfs,
    // dropped caps, no network by default. Production safety lives or dies
    // on these flags being there.
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../bin/runner.js'), 'utf8');
    assert.ok(src.indexOf("'--read-only'") !== -1, '--read-only present');
    assert.ok(src.indexOf("'--cap-drop=ALL'") !== -1, '--cap-drop=ALL present');
    assert.ok(src.indexOf("'--security-opt=no-new-privileges'") !== -1, 'security-opt present');
    assert.ok(src.indexOf("wantNetwork ? 'bridge' : 'none'") !== -1, 'network gated by capabilities');
  });

  test('ENT-85: triage returns inline for short / question / quick-fix prompts', () => {
    const tri = require('../shared-core/orchestrate-triage.js');
    assert.strictEqual(tri.triage('how does the auth flow work?').mode, 'inline');
    assert.strictEqual(tri.triage('what files are in this directory').mode, 'inline');
    assert.strictEqual(tri.triage('quick fix: typo in README').mode, 'inline');
    assert.strictEqual(tri.triage('').mode, 'inline');
    assert.strictEqual(tri.triage('add a console.log').mode, 'inline');
  });

  test('ENT-86: triage returns ask_user for multi-domain build tasks', () => {
    const tri = require('../shared-core/orchestrate-triage.js');
    const r = tri.triage('Build a feature: REST API for users with a React form and integration tests');
    assert.strictEqual(r.mode, 'ask_user');
    assert.ok(r.suggested_roles.indexOf('backend') !== -1);
    assert.ok(r.suggested_roles.indexOf('frontend') !== -1);
    assert.ok(r.suggested_roles.indexOf('qa') !== -1);
    assert.ok(r.confidence >= 0.5);
  });

  test('ENT-87: triage returns explicit_request when user names spawn keywords', () => {
    const tri = require('../shared-core/orchestrate-triage.js');
    const a = tri.triage('Spawn a backend agent and a frontend agent to build the export feature');
    assert.strictEqual(a.mode, 'explicit_request');
    assert.ok(a.suggested_roles.indexOf('backend') !== -1);
    assert.ok(a.suggested_roles.indexOf('frontend') !== -1);

    const b = tri.triage('please orchestrate this across multiple agents');
    assert.strictEqual(b.mode, 'explicit_request');

    const c = tri.triage('split this task into agents — backend, frontend, qa');
    assert.strictEqual(c.mode, 'explicit_request');
  });

  test('ENT-88: triage stays inline for single-domain build (no fan-out)', () => {
    const tri = require('../shared-core/orchestrate-triage.js');
    const r = tri.triage('Add a new endpoint /api/health to the backend');
    assert.strictEqual(r.mode, 'inline');
  });

  test('ENT-80: planner.planFallback returns one entry per role with no deps', () => {
    const planner = require('../shared-core/planner.js');
    const r = planner.planFallback('build feature X', ['backend', 'frontend', 'qa']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.planner_used, 'fallback');
    assert.strictEqual(r.dag.length, 3);
    for (const role of ['backend', 'frontend', 'qa']) {
      assert.ok(r.plan[role], 'plan has ' + role);
      assert.deepStrictEqual(r.plan[role].depends_on, []);
      assert.ok(r.plan[role].subtask.indexOf('build feature X') !== -1);
    }
  });

  test('ENT-81: planner.plan with mocked callLlm respects the JSON contract', async () => {
    const planner = require('../shared-core/planner.js');
    const mockLlm = async (prompt) => ({
      text: JSON.stringify({
        plan: {
          backend:  { subtask: 'implement /api/users', depends_on: [] },
          frontend: { subtask: 'build form',          depends_on: ['backend'] },
          qa:       { subtask: 'integration tests',   depends_on: ['backend', 'frontend'] }
        }
      })
    });
    const r = await planner.plan('build users feature', ['backend', 'frontend', 'qa'], {
      callLlm: mockLlm
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.planner_used, 'llm');
    assert.deepStrictEqual(r.plan.frontend.depends_on, ['backend']);
    // DAG order: backend before frontend before qa
    const order = r.dag.map(n => n.role);
    assert.ok(order.indexOf('backend') < order.indexOf('frontend'));
    assert.ok(order.indexOf('frontend') < order.indexOf('qa'));
  });

  test('ENT-82: planner.plan strips circular dependencies and degrades to flat plan', async () => {
    const planner = require('../shared-core/planner.js');
    const mockLlm = async () => ({
      text: JSON.stringify({
        plan: {
          backend:  { subtask: 'a', depends_on: ['frontend'] },
          frontend: { subtask: 'b', depends_on: ['backend'] }
        }
      })
    });
    const r = await planner.plan('cyclic test', ['backend', 'frontend'], {
      callLlm: mockLlm
    });
    assert.strictEqual(r.ok, true);
    // Expect deps stripped to break the cycle.
    assert.deepStrictEqual(r.plan.backend.depends_on, []);
    assert.deepStrictEqual(r.plan.frontend.depends_on, []);
  });

  test('ENT-83: planner.plan falls back when callLlm throws', async () => {
    const planner = require('../shared-core/planner.js');
    const r = await planner.plan('whatever', ['backend'], {
      callLlm: async () => { throw new Error('llm down'); }
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.planner_used, 'fallback');
    assert.ok(r.llm_error && r.llm_error.indexOf('llm down') !== -1);
  });

  test('ENT-84: agent-supervisor.summarize without callLlm returns deterministic baseline', async () => {
    const sup = require('../shared-core/agent-supervisor.js');
    const r = await sup.summarize('non-existent-group-' + Date.now());
    assert.strictEqual(r.ok, true);
    assert.ok(r.summary && r.summary.length > 0);
  });

  test('ENT-75b: roles registry returns built-in roles when no overrides exist', () => {
    const roles = require('../shared-core/roles.js');
    const all = roles.loadRoles('/tmp/non-existent-' + Date.now());
    assert.ok(all.backend && all.frontend && all.qa, 'built-in roles surface');
    assert.strictEqual(all.backend.transport_hint, 'router');
    assert.strictEqual(all.qa.capabilities.indexOf('write') !== -1, true);
  });

  test('ENT-76b: roles.getRole returns null for unknown role', () => {
    const roles = require('../shared-core/roles.js');
    assert.strictEqual(roles.getRole('unknown-role-xyz', '/tmp'), null);
  });

  test('ENT-77: roles.validateRole flags non-array capabilities', () => {
    const roles = require('../shared-core/roles.js');
    const r = roles.validateRole({ capabilities: 'not-an-array' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.field === 'capabilities'));
  });

  test('ENT-78: agent-supervisor.mergeResults returns empty status when group has no engrams', () => {
    const sup = require('../shared-core/agent-supervisor.js');
    const r = sup.mergeResults('non-existent-group-' + Date.now());
    assert.strictEqual(r.status, 'empty');
    assert.strictEqual(r.role_count, 0);
    assert.strictEqual(r.conflicts.length, 0);
  });

  // L4 — sub-brain team dispatch (future module).
  // pollResults must discover workers spawned with sub_brain_id (which
  // write engrams under the sub-brain's agent_id, not the synthesized
  // role-agent_id). Without Pass 2 the sub-brain-team output is invisible
  // to the orchestrator merge.
  test('TEAM-1: pollResults discovers sub-brain workers via spawn decision records', () => {
    const ar  = require('../shared-core/action-record.js');
    const st  = require('../shared-core/state.js');
    const eng = require('../shared-core/engram.js');
    const sup = require('../shared-core/agent-supervisor.js');
    const groupId = 'team-test-' + Date.now();
    const subBrainId = 'cooking-coach-' + Date.now();
    const roleLabel  = 'kitchen';
    // Simulate a spawnRoleWorker decision record with worker_agent_id
    // pointing at the sub-brain (what writes).
    st.recordAction({
      id: ar.uuidv7(), timestamp: Date.now(),
      type: 'decision', agent_id: 'orchestrator',
      input:  { kind: 'role_worker_spawned', group_id: groupId, role: roleLabel },
      output: { runId: 'run-x', mode: 'subprocess', model: null,
                scope: 'role:' + roleLabel + ':group:' + groupId,
                worker_agent_id: subBrainId, sub_brain_id: subBrainId }
    }, 'role_worker_spawned');
    // Simulate the worker writing a finding engram under the sub-brain
    // agent_id with the role-scoped tag.
    const eId = eng.recordEngram({
      agent_id: subBrainId,
      cwd: null,
      statement: 'risotto needs constant stirring',
      scope: 'role:' + roleLabel + ':group:' + groupId,
      salience: 1
    });
    assert.ok(eId, 'engram write must succeed');
    // pollResults now should bucket that engram under the role label.
    const results = sup.pollResults(groupId);
    assert.ok(results[roleLabel], 'sub-brain worker engrams must surface under their role label');
    assert.ok(results[roleLabel].some((e) => /risotto/.test(e.statement)),
      'the actual engram statement must appear in the merged output');
  });

  test('TEAM-2: /agent <a>,<b> <task> resolves N sub-brains via registry before reaching spawn', async () => {
    const reg  = require('../shared-core/agent-registry.js');
    const exec = require('../shared-core/slash/executor.js');
    const a = reg.createAgent({ id: 'team-a-' + Date.now(), name: 'team-a-' + Date.now() });
    const b = reg.createAgent({ id: 'team-b-' + Date.now(), name: 'team-b-' + Date.now() });
    assert.ok(a && b, 'two sub-brains created');
    const fakeSkill = { name: 'agent', kind: 'deterministic', source_path: '/dev/null' };
    const parsed   = {
      is_slash: true, name: 'agent',
      raw_args: a.name + ',' + b.name + ' plan a launch',
      args_array: [a.name + ',' + b.name, 'plan', 'a', 'launch']
    };
    const res = await exec.executeDeterministic(fakeSkill, parsed, { agent_id: 'main' });
    // In a test sandbox the runner.spawnWorker call fails (no git repo,
    // no docker, no roles.json definition for our synthetic role labels),
    // so the handler reports ok:false. executeDeterministic strips
    // side_effects on failure. The contract being verified here is the
    // pre-spawn step: both sub-brain names resolved through the registry.
    if (res.ok) {
      assert.ok(res.side_effects && res.side_effects.team_group_id,
        'when spawns succeed, group id is exposed via side_effects');
    } else {
      assert.notStrictEqual(res.error, 'unknown_agents');
      assert.notStrictEqual(res.error, 'missing_task');
      assert.notStrictEqual(res.error, 'supervisor_missing');
    }
  });

  test('TEAM-3: /agent <a>,<b> aborts cleanly when any name is unknown', async () => {
    const exec = require('../shared-core/slash/executor.js');
    const fakeSkill = { name: 'agent', kind: 'deterministic', source_path: '/dev/null' };
    const parsed   = {
      is_slash: true, name: 'agent',
      raw_args: 'totally-unregistered-xyz do a thing',
      args_array: ['totally-unregistered-xyz', 'do', 'a', 'thing']
    };
    // Single name that doesn't exist → switch path, returns unknown_agent
    const r1 = await exec.executeDeterministic(fakeSkill, parsed, { agent_id: 'main' });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, 'unknown_agent');
    // Comma-list with unknown member → team path, returns unknown_agents
    const parsed2 = {
      is_slash: true, name: 'agent',
      raw_args: 'unknown-x,unknown-y do a thing',
      args_array: ['unknown-x,unknown-y', 'do', 'a', 'thing']
    };
    const r2 = await exec.executeDeterministic(fakeSkill, parsed2, { agent_id: 'main' });
    assert.strictEqual(r2.ok, false, 'must abort, not partial-spawn');
    assert.strictEqual(r2.error, 'unknown_agents');
  });

  test('ENT-79: STATE_DB_PATH env override works in spawned subprocess', () => {
    // Cannot test cache-bust in-process: clearing require.cache breaks
    // ENT-59 (substrate-backup keeps a stale handle to the original DB).
    // Verify via subprocess spawn so the env override is clean per-test.
    const { spawnSync } = require('child_process');
    const tmpPath = require('os').tmpdir() + '/state-test-env-' + Date.now() + '.db';
    const r = spawnSync(process.execPath, ['-e',
      'process.env.STATE_DB_PATH = ' + JSON.stringify(tmpPath) + ';' +
      'const s = require(' + JSON.stringify(require('path').resolve(__dirname, '../shared-core/state.js')) + ');' +
      's.db();' +
      'console.log(require("fs").existsSync(' + JSON.stringify(tmpPath) + ') ? "ok" : "fail");'
    ], { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual((r.stdout || '').trim(), 'ok',
      'STATE_DB_PATH should create the DB at the requested path; stderr=' + (r.stderr || ''));
    try { require('fs').unlinkSync(tmpPath); } catch (_) {}
  });

  test('ENT-67b: reconciler.reconcile — anchor violation triggers reprompt severity', () => {
    const rec = require('../shared-core/reconciler.js');
    const commitments = [
      { id: 'c-tabs', output: { commitment_type: 'anchor', statement: 'I always use tabs not spaces' } }
    ];
    const r = rec.reconcile('Switching to spaces makes the diff cleaner.', commitments);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.severity, 'reprompt');
    assert.ok(r.reprompt_preface && r.reprompt_preface.indexOf('DEFEND') !== -1);
    assert.strictEqual(r.conflicts.length, 1);
    assert.strictEqual(r.conflicts[0].commitment_kind, 'anchor');
  });

  test('ENT-68b: reconciler.reconcile — hard commitment violation = block severity', () => {
    const rec = require('../shared-core/reconciler.js');
    const commitments = [
      // Use opposite-pair fire path (sqlite↔postgres in DEFAULT_OPPOSITES)
      // that's the deterministic detector's strongest signal. Real-world
      // LLM drift gets caught by the same path; we just keep the test
      // honest about which heuristic is being exercised.
      { id: 'c-db', output: { commitment_type: 'hard', statement: 'We use sqlite for storage' } }
    ];
    const r = rec.reconcile('Switch to postgres for production scale.', commitments);
    assert.strictEqual(r.severity, 'block');
    assert.strictEqual(r.conflicts[0].commitment_kind, 'hard');
  });

  test('ENT-69b: reconciler.reconcile — clean reply against same commitments returns ok', () => {
    const rec = require('../shared-core/reconciler.js');
    const commitments = [
      { id: 'c-tabs', output: { commitment_type: 'anchor', statement: 'I always use tabs not spaces' } }
    ];
    const r = rec.reconcile('Lunch is at noon and the deploy goes out tomorrow.', commitments);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.conflicts.length, 0);
  });

  test('ENT-70b: lesson-library.scoreLesson — recurrence + recency dimensions land', () => {
    const lib = require('../shared-core/lesson-library.js');
    const fp = 'fp-' + Date.now();
    const recent = Date.now();
    const lessons = [
      { input: { fingerprint: fp }, output: { statement: 'X'.repeat(120) }, session_id: 's1', timestamp: recent },
      { input: { fingerprint: fp }, output: { statement: 'X'.repeat(120) }, session_id: 's2', timestamp: recent },
      { input: { fingerprint: fp }, output: { statement: 'X'.repeat(120) }, session_id: 's3', timestamp: recent },
    ];
    const target = lessons[0];
    const r = lib.scoreLesson(target, { allLessons: lessons, now: recent });
    assert.ok(r.dimensions.recurrence_match >= 0.7, 'recurrence should be 0.7+ for 3 distinct sessions');
    assert.ok(r.dimensions.recency_decay > 0.95, 'recency should be near 1 for now()');
    assert.ok(r.quality > 0, 'composite quality should be > 0');
  });

  test('ENT-71b: lesson-library.rankLessons sorts by quality desc + applies limit', () => {
    const lib = require('../shared-core/lesson-library.js');
    const fpHigh = 'fp-high-' + Date.now();
    const fpLow  = 'fp-low-'  + Date.now();
    const now = Date.now();
    const records = [
      // High: recurs 3x, recent, good length
      { input: { fingerprint: fpHigh }, output: { statement: 'A'.repeat(150) }, session_id: 's1', timestamp: now },
      { input: { fingerprint: fpHigh }, output: { statement: 'A'.repeat(150) }, session_id: 's2', timestamp: now },
      { input: { fingerprint: fpHigh }, output: { statement: 'A'.repeat(150) }, session_id: 's3', timestamp: now },
      // Low: single session, very old, very long (penalized)
      { input: { fingerprint: fpLow },  output: { statement: 'B'.repeat(2000) }, session_id: 's4',
        timestamp: now - 365 * 24 * 60 * 60 * 1000 }
    ];
    const ranked = lib.rankLessons(records, { now, limit: 2 });
    assert.strictEqual(ranked.length, 2);
    assert.ok(ranked[0]._quality.quality >= ranked[1]._quality.quality);
    assert.strictEqual(ranked[0].input.fingerprint, fpHigh, 'high-recurrence wins');
  });

  test('ENT-72b: structured-envelope.decompose — extracts all 5 section types', () => {
    const env = require('../shared-core/structured-envelope.js');
    const reply = [
      '<claim>Express servers in this repo use better-sqlite3.</claim>',
      'Some commentary outside any tag.',
      '<action>Read file=src/db.js</action>',
      '<refusal>Cannot delete production data without dual-control approval.</refusal>',
      '<question>Should we keep the legacy column?</question>',
      '<meta confidence="0.7">I considered Postgres but local-first wins.</meta>'
    ].join('\n');
    const r = env.decompose(reply);
    assert.strictEqual(r.claims.length, 1);
    assert.strictEqual(r.actions.length, 1);
    assert.strictEqual(r.refusals.length, 1);
    assert.strictEqual(r.questions.length, 1);
    assert.strictEqual(r.metas.length, 1);
    assert.ok(r.untagged.indexOf('commentary') !== -1);
    assert.strictEqual(r.metas[0].attrs, 'confidence="0.7"');
  });

  test('ENT-73b: structured-envelope.decompose — untagged plain text degrades to single claim', () => {
    const env = require('../shared-core/structured-envelope.js');
    const r = env.decompose('Plain reply with no tags. Substrate should still see this as a claim.');
    assert.strictEqual(r.claims.length, 1);
    assert.ok(r.claims[0].body.indexOf('Plain reply') !== -1);
    assert.strictEqual(r.untagged, '');
  });

  test('ENT-74b: structured-envelope.injectInstruction is idempotent', () => {
    const env = require('../shared-core/structured-envelope.js');
    const a = env.injectInstruction('You are helpful.');
    const b = env.injectInstruction(a);
    assert.strictEqual(a, b, 'second injection is a no-op');
    assert.ok(a.indexOf('Structured response envelope') !== -1);
  });

  test('ENT-66b: multi-agent.negotiate — conflict records disagreement engram both sides', () => {
    const eng = require('../shared-core/engram.js');
    const ma = require('../shared-core/multi-agent.js');
    const ts = Date.now();
    const aid = 'ma-c-' + ts, bid = 'ma-d-' + ts;
    const scope = 'ma-conflict-' + ts;
    eng.recordEngram({ agent_id: aid, scope, salience: 1, statement: 'we use sqlite for storage', source: 'seed' });
    eng.recordEngram({ agent_id: bid, scope, salience: 1, statement: 'we do not use sqlite for storage', source: 'seed' });
    const A = ma.fromEngram(eng, aid);
    const B = ma.fromEngram(eng, bid);
    const r = ma.negotiate(A, B, { scope });
    assert.strictEqual(r.final_verdict, 'conflict');
    const afterA = eng.listEngrams({ agent_id: aid, scope, limit: 10 }) || [];
    const afterB = eng.listEngrams({ agent_id: bid, scope, limit: 10 }) || [];
    assert.ok(afterA.some(x => /^DISAGREEMENT/.test(x.statement || '')), 'disagreement on A');
    assert.ok(afterB.some(x => /^DISAGREEMENT/.test(x.statement || '')), 'disagreement on B');
  });

  test('EMB-1: recordEngram with inline embedding indexes it into engram_embeddings (dense-visible on write)', () => {
    // Pin a fresh data dir and re-require state+engram together so both bind to
    // the SAME db (earlier blocks mutate CLAUDE_PLUGIN_DATA + bust the state
    // cache, which would otherwise split engram's writer from our reader).
    const fsE = require('fs'), osE = require('os'), pathE = require('path');
    const tmp = fsE.mkdtempSync(pathE.join(osE.tmpdir(), 'troth-emb1-'));
    const prevPD = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = tmp;
    delete require.cache[require.resolve('../shared-core/state')];
    delete require.cache[require.resolve('../shared-core/engram')];
    const st  = require('../shared-core/state');
    const eng = require('../shared-core/engram');
    try {
      const ts  = Date.now();
      const aid = 'emb-' + ts;
      const vec = new Array(768).fill(0).map((_, i) => (i % 7) / 7);
      // (a) inline embedding → must land in engram_embeddings immediately (not just output JSON)
      const id = eng.recordEngram({ agent_id: aid, statement: 'inline embedding indexing fact ' + ts, embedding: vec, source: 'test', auto_verify: false });
      assert.ok(id, 'recordEngram should return an id');
      const got = st.getEmbedding(id);
      assert.ok(got && got.length === 768, 'inline embedding must be in engram_embeddings on write, got ' + (got ? got.length : 'null'));
      // (b) no embedding → must NOT be pre-indexed (idle backfill covers it later)
      const id2 = eng.recordEngram({ agent_id: aid, statement: 'no-vector control fact ' + ts, source: 'test', auto_verify: false });
      assert.ok(id2, 'control recordEngram should return an id');
      assert.strictEqual(st.getEmbedding(id2), null, 'engram without inline vector must not be pre-indexed');
    } finally {
      st.close && st.close();
      delete require.cache[require.resolve('../shared-core/state')];
      delete require.cache[require.resolve('../shared-core/engram')];
      if (prevPD === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevPD;
      try { fsE.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('ENT-59b: substrate-backup exportArchive + importArchive round-trip preserves db', () => {
    const fs = require('fs');
    const path = require('path');
    const backup = require('../shared-core/substrate-backup.js');
    const eng = require('../shared-core/engram.js');
    const agent_id = 'backup-' + Date.now();
    eng.recordEngram({ agent_id, statement: 'pre-backup fact #1', source: 'test' });
    eng.recordEngram({ agent_id, statement: 'pre-backup fact #2', source: 'test' });
    const bundleDir = require('os').tmpdir() + '/troth-bundle-' + Date.now();
    const exp = backup.exportArchive({ out_path: bundleDir });
    assert.strictEqual(exp.ok, true);
    assert.ok(fs.existsSync(path.join(bundleDir, 'state.db')));
    assert.ok(fs.existsSync(path.join(bundleDir, 'manifest.json')));
    // Restore into a fresh target db
    const targetDb = require('os').tmpdir() + '/troth-restore-' + Date.now() + '/state.db';
    const imp = backup.importArchive({ in_path: bundleDir, target_db: targetDb });
    assert.strictEqual(imp.ok, true);
    assert.ok(fs.existsSync(targetDb));
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(targetDb), { recursive: true, force: true });
  });

  test('ENT-58: engram-gc consolidates duplicates and tombstones below-min-salience', async () => {
    const eng = require('../shared-core/engram.js');
    const gc  = require('../shared-core/engram-gc.js');
    const agent_id = 'gc-test-' + Date.now();
    // Record a few engrams; one with low salience to be evicted
    eng.recordEngram({ agent_id, statement: 'high importance fact', salience: 1.5, source: 'test' });
    eng.recordEngram({ agent_id, statement: 'low importance fact', salience: 0.05, source: 'test' });
    const r = await gc.gcAgent({ agent_id, dry_run: true, min_salience: 0.1 });
    assert.strictEqual(r.ok, true);
    assert.ok(r.evicted_count >= 1, 'low-salience engram evicted (got evicted_count=' + r.evicted_count + ')');
  });

  test('ENT-57: benchmark-runner runSuite scores baseline vs substrate via injected oneShot', async () => {
    const br = require('../shared-core/benchmark-runner.js');
    // Fake oneShot: baseline returns weak text, substrate returns ideal text
    const oneShot = async (prompt, modeOpts) => {
      if (modeOpts.mode === 'baseline') return 'I do not know about this. Random output.';
      // substrate mode: caller passes our composed system prefix, we pretend the model used it
      return 'According to the user, the codeword is cerulean-tortoise. Honoring active commitments.';
    };
    const tasks = [
      { id: 't1', category: 'recall', prompt: 'What is the codeword?',
        rubric: { must_contain: ['cerulean-tortoise'], must_avoid: ['random'] } },
      { id: 't2', category: 'recall', prompt: 'What did user say?',
        rubric: { must_contain: ['active commitments'] } }
    ];
    const r = await br.runSuite({ one_shot: oneShot, tasks, agent_id: 'bench-' + Date.now() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results.length, 2);
    assert.ok(r.summary.mean_delta > 0, 'substrate mode beat baseline (delta=' + r.summary.mean_delta + ')');
    assert.ok(r.summary.wins >= 1);
  });

  test('ENT-56: benchmark-runner defaultScorer rewards must_contain hits and penalises must_avoid', () => {
    const br = require('../shared-core/benchmark-runner.js');
    const good = br.defaultScorer('The codeword is cerulean-tortoise; honoured.', { must_contain: ['cerulean-tortoise', 'honoured'], must_avoid: ['random'] });
    const bad  = br.defaultScorer('Random nonsense without the right words.', { must_contain: ['cerulean-tortoise', 'honoured'], must_avoid: ['random'] });
    assert.ok(good.score > 0.7, 'good text scores high');
    assert.ok(bad.score  < 0.5, 'bad text scores low');
    assert.ok(good.score > bad.score);
  });

  test('ENT-55: ingest-watcher live ingests new files into a chameleon scope', async () => {
    const fs = require('fs');
    const path = require('path');
    const watcher = require('../shared-core/ingest-watcher.js');
    const chameleon = require('../shared-core/chameleon.js');
    const tmpRoot = require('os').tmpdir() + '/troth-watcher-' + Date.now();
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'note1.md'), 'The team uses Rust for high-perf modules. The CI runs nightly.');
    const events = [];
    const w = watcher.startWatcher({
      agent_id: 'wat-' + Date.now(),
      cwd: '/tmp/wat-' + Date.now(),
      scope: 'docs:watcher-test',
      source_root: tmpRoot,
      poll_ms: 60000,
      notify: (n) => events.push(n)
    });
    await w.tickNow();
    // Add a second file, tick again — should pick up only the new one
    fs.writeFileSync(path.join(tmpRoot, 'note2.md'), 'Postgres is the primary store. Migrations run via sqlx.');
    await w.tickNow();
    w.stop();
    var ingestedFiles = events.filter(e => e.kind === 'watcher_ingested').map(e => path.basename(e.file));
    assert.ok(ingestedFiles.includes('note1.md'), 'note1 ingested');
    assert.ok(ingestedFiles.includes('note2.md'), 'note2 ingested on second tick');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('ENT-54: ingest-watcher diffSignatures detects added/changed/removed', () => {
    const w = require('../shared-core/ingest-watcher.js');
    const prev = { '/a': '1:100', '/b': '2:200' };
    const curr = { '/a': '1:100', '/b': '3:201', '/c': '4:50' };
    const d = w.diffSignatures(prev, curr);
    assert.deepStrictEqual(d.added,   ['/c']);
    assert.deepStrictEqual(d.changed, ['/b']);
    assert.deepStrictEqual(d.removed, []);
  });

  test('ENT-52: server-lifecycle composeCommand emits canonical llama-server invocation with substrate flags', () => {
    const sl = require('../shared-core/server-lifecycle.js');
    const r = sl.composeCommand({
      model_path: '/models/x.gguf',
      port: 11436, ngl: 999,
      slot_save_path: '/tmp/slots',
      control_vector_scaled: { path: '/tmp/cv.gguf', scale: 1.5 },
      lora_path: '/tmp/lora.gguf'
    });
    assert.ok(r.command_string.includes('-m /models/x.gguf'));
    assert.ok(r.command_string.includes('--port 11436'));
    assert.ok(r.command_string.includes('--slot-save-path /tmp/slots'));
    assert.ok(r.command_string.includes('--control-vector-scaled /tmp/cv.gguf:1.5'));
    assert.ok(r.command_string.includes('--lora /tmp/lora.gguf'));
    assert.ok(r.command_string.includes('--embeddings'));
    // Shifted-prefix KV reuse must stay in the canonical invocation:
    // without --cache-reuse, any prefix shift re-prefills the whole prompt.
    assert.ok(r.command_string.includes('--cache-reuse 256'));
  });

  // DM-DEDUP —  regression guard for the 6-dupes-in-7-seconds
  // bug. recordTurn must drop same (agent_id, user_text, assistant_text)
  // within the 30s window but PRESERVE cross-surface writes (different
  // agent_id) so voice + chat + CLI + watcher all stay first-class
  // cognitive moments per the substrate-as-mind thesis.
  test('DM-DEDUP-1: recordTurn drops same-surface duplicate within 30s window', () => {
    const dm = require('../shared-core/dialogue-memory.js');
    const state = require('../shared-core/state.js');
    const agent_id = 'dm-dedup-' + Date.now();
    const user_text = 'dedup probe user-text ' + Date.now();
    const assistant_text = 'dedup probe assistant-text';
    const r1 = dm.recordTurn({ agent_id, user_text, assistant_text, faculty: 'test' });
    const r2 = dm.recordTurn({ agent_id, user_text, assistant_text, faculty: 'test' });
    assert.strictEqual(r1, true,  'first write succeeds');
    assert.strictEqual(r2, false, 'identical write within window is deduped');
    const rows = state.queryActions({ type: 'tool_call', agent_id, limit: 5 });
    assert.strictEqual(rows.length, 1, 'only one physical row in DB');
  });

  test('DM-DEDUP-2: recordTurn allows same content on DIFFERENT surface (multi-surface continuity)', () => {
    const dm = require('../shared-core/dialogue-memory.js');
    const state = require('../shared-core/state.js');
    const base = 'dm-dedup-multi-' + Date.now();
    const user_text = 'same prompt across surfaces';
    const assistant_text = 'same reply across surfaces';
    const r1 = dm.recordTurn({ agent_id: base + '-voice', user_text, assistant_text, faculty: 'test' });
    const r2 = dm.recordTurn({ agent_id: base + '-chat',  user_text, assistant_text, faculty: 'test' });
    assert.strictEqual(r1, true, 'voice write succeeds');
    assert.strictEqual(r2, true, 'chat write also succeeds — different surface = different cognitive moment');
    const a = state.queryActions({ type: 'tool_call', agent_id: base + '-voice', limit: 3 });
    const b = state.queryActions({ type: 'tool_call', agent_id: base + '-chat',  limit: 3 });
    assert.strictEqual(a.length, 1, 'voice surface row recorded');
    assert.strictEqual(b.length, 1, 'chat surface row recorded');
  });

  test('DM-DEDUP-3: recordTurn allows same agent with DIFFERENT text', () => {
    const dm = require('../shared-core/dialogue-memory.js');
    const state = require('../shared-core/state.js');
    const agent_id = 'dm-dedup-distinct-' + Date.now();
    const r1 = dm.recordTurn({ agent_id, user_text: 'msg one', assistant_text: 'reply one', faculty: 'test' });
    const r2 = dm.recordTurn({ agent_id, user_text: 'msg two', assistant_text: 'reply two', faculty: 'test' });
    assert.strictEqual(r1, true, 'first distinct write succeeds');
    assert.strictEqual(r2, true, 'second distinct write succeeds — different content');
    const rows = state.queryActions({ type: 'tool_call', agent_id, limit: 5 });
    assert.strictEqual(rows.length, 2, 'both physical rows present');
  });

  test('ENT-47: background-worker notify callback fires per task with task + notes + elapsed_ms', async () => {
    const bg = require('../shared-core/background-worker.js');
    const captured = [];
    const customTask = {
      name: 'unit_test_task',
      cadence_ms: 0,
      run: () => ({ events: [{ type: 'tool_call', input: { tool_name: 'x' }, output: { status: 'ok' } }], notes: ['ran'] })
    };
    const submitted = [];
    const w = bg.startWorker({
      submit:  (ev) => submitted.push(ev),
      getView: () => ({ mind: { active_projects: [] } }),
      tasks:   [customTask],
      tick_ms: 50,
      idle_threshold_ms: 0,
      notify:  (n) => captured.push(n)
    });
    await new Promise(r => setTimeout(r, 200));
    w.stop();
    assert.ok(captured.length >= 1, 'notify fired at least once');
    assert.strictEqual(captured[0].task, 'unit_test_task');
    assert.ok(Array.isArray(captured[0].events));
    assert.ok(typeof captured[0].elapsed_ms === 'number');
    assert.ok(captured[0].notes && captured[0].notes.includes('ran'));
  });

  // PSW (Phase Scheduler Wiring) — runDueTasks one-shot path used by
  // SessionStart hook (and any future proxy/voice tick caller). Cadence
  // debounced via type='decision', input.kind='background_task_run'
  // records read from a substrate state shim.
  function mockBgState(rows) {
    return {
      queryActions: (opts) => {
        opts = opts || {};
        return (rows || []).filter((r) => {
          if (opts.type && r.type !== opts.type) return false;
          if (opts.since && r.timestamp < opts.since) return false;
          if (opts.cwd && r.cwd && r.cwd !== opts.cwd) return false;
          return true;
        }).sort((a, b) => b.timestamp - a.timestamp);
      }
    };
  }

  test('PSW1: runDueTasks fires due daily tasks and records cadence decisions', async () => {
    const bg = require('../shared-core/background-worker.js');
    const submitted = [];
    const dailyTask = {
      name: 'psw_unit_daily',
      cadence_ms: 24 * 60 * 60 * 1000,
      run: () => ({ events: [{ type: 'tool_call', input: { tool_name: 'unit' }, output: { status: 'ok' } }], notes: ['psw1'] })
    };
    const r = await bg.runDueTasks({
      submit: (ev) => submitted.push(ev),
      getView: () => ({ substrate_ctx: { agent_id: 'psw-agent', cwd: '/tmp/psw1', user_id: 'default' } }),
      tasks: [dailyTask],
      // Hermetic to CI runner stalls: this test pins WHICH tasks run,
      // not the wall-budget guard — a >5s monolithic stall on a GitHub
      // runner burned DEFAULT_PER_CYCLE_BUDGET and skipped due tasks
      //.
      per_cycle_budget_ms: 10 * 60 * 1000,
      state: mockBgState([])  // no prior runs
    });
    assert.strictEqual(r.ran.length, 1, 'one task ran when no prior cadence record exists');
    assert.strictEqual(r.ran[0].task, 'psw_unit_daily');
    // Two events submitted: the task's own tool_call event + the
    // background_task_run debounce record.
    assert.strictEqual(submitted.length, 2, 'task event + cadence record both submitted');
    const cadenceEvent = submitted.find(e => e.input && e.input.kind === 'background_task_run');
    assert.ok(cadenceEvent, 'a background_task_run decision was submitted');
    assert.strictEqual(cadenceEvent.input.task, 'psw_unit_daily');
  });

  test('PSW2: runDueTasks skips task when a prior background_task_run record is within cadence', async () => {
    const bg = require('../shared-core/background-worker.js');
    const submitted = [];
    const dailyTask = {
      name: 'psw_unit_daily_2',
      cadence_ms: 24 * 60 * 60 * 1000,
      run: () => ({ events: [], notes: ['should_not_run'] })
    };
    // Seed a cadence record from 1 hour ago — well within the 24h window.
    const priorRow = {
      type: 'decision',
      timestamp: Date.now() - (60 * 60 * 1000),
      cwd: '/tmp/psw2',
      input: JSON.stringify({ kind: 'background_task_run', task: 'psw_unit_daily_2' }),
      output: JSON.stringify({ decision: 'ran' })
    };
    const r = await bg.runDueTasks({
      submit: (ev) => submitted.push(ev),
      getView: () => ({ substrate_ctx: { agent_id: 'psw-agent', cwd: '/tmp/psw2', user_id: 'default' } }),
      tasks: [dailyTask],
      // Hermetic to CI runner stalls: this test pins WHICH tasks run,
      // not the wall-budget guard — a >5s monolithic stall on a GitHub
      // runner burned DEFAULT_PER_CYCLE_BUDGET and skipped due tasks
      //.
      per_cycle_budget_ms: 10 * 60 * 1000,
      state: mockBgState([priorRow])
    });
    assert.strictEqual(r.ran.length, 0, 'no tasks should run within cadence');
    assert.strictEqual(r.skipped.length, 1, 'task should be skipped');
    assert.strictEqual(r.skipped[0].reason, 'within_cadence');
    assert.strictEqual(submitted.length, 0, 'no events submitted when nothing ran');
  });

  test('PSW3: runDueTasks filters out sub-min_cadence tasks (drift_scan etc.) by default', async () => {
    const bg = require('../shared-core/background-worker.js');
    const submitted = [];
    const fastTask = {
      name: 'psw_unit_fast',
      cadence_ms: 60 * 1000,  // 60s — below default 12h floor
      run: () => ({ events: [{ type: 'tool_call', input: { tool_name: 'fast' }, output: { status: 'ok' } }], notes: [] })
    };
    const slowTask = {
      name: 'psw_unit_slow',
      cadence_ms: 24 * 60 * 60 * 1000,
      run: () => ({ events: [], notes: ['slow_ran'] })
    };
    const r = await bg.runDueTasks({
      submit: (ev) => submitted.push(ev),
      getView: () => ({ substrate_ctx: { agent_id: 'psw-agent', cwd: '/tmp/psw3', user_id: 'default' } }),
      tasks: [fastTask, slowTask],
      // Hermetic to CI runner stalls: this test pins WHICH tasks run,
      // not the wall-budget guard — a >5s monolithic stall on a GitHub
      // runner burned DEFAULT_PER_CYCLE_BUDGET and skipped due tasks
      //.
      per_cycle_budget_ms: 10 * 60 * 1000,
      state: mockBgState([])
    });
    assert.strictEqual(r.ran.length, 1, 'only the daily task should run');
    assert.strictEqual(r.ran[0].task, 'psw_unit_slow');
    const skippedFast = r.skipped.find(s => s.task === 'psw_unit_fast');
    assert.ok(skippedFast, 'fast task should be skipped');
    assert.strictEqual(skippedFast.reason, 'below_min_cadence');
  });

  test('PSW4: runDueTasks routes per-task agent_id_overrides into substrate_ctx', async () => {
    const bg = require('../shared-core/background-worker.js');
    const submitted = [];
    const seenAgents = [];
    const taskA = {
      name: 'psw4_default_agent',
      cadence_ms: 24 * 60 * 60 * 1000,
      run: (view) => {
        seenAgents.push({ task: 'psw4_default_agent', agent_id: view && view.substrate_ctx && view.substrate_ctx.agent_id });
        return { events: [], notes: [] };
      }
    };
    const taskB = {
      name: 'psw4_overridden_agent',
      cadence_ms: 24 * 60 * 60 * 1000,
      run: (view) => {
        seenAgents.push({ task: 'psw4_overridden_agent', agent_id: view && view.substrate_ctx && view.substrate_ctx.agent_id });
        return { events: [], notes: [] };
      }
    };
    const r = await bg.runDueTasks({
      submit: (ev) => submitted.push(ev),
      getView: () => ({ substrate_ctx: { agent_id: 'default-agent', cwd: '/tmp/psw4', user_id: 'default' } }),
      tasks: [taskA, taskB],
      // Hermetic to CI runner stalls: this test pins WHICH tasks run,
      // not the wall-budget guard — a >5s monolithic stall on a GitHub
      // runner burned DEFAULT_PER_CYCLE_BUDGET and skipped due tasks
      //.
      per_cycle_budget_ms: 10 * 60 * 1000,
      agent_id_overrides: { psw4_overridden_agent: 'override-agent' },
      state: mockBgState([])
    });
    assert.strictEqual(r.ran.length, 2, 'both tasks should run');
    const a = seenAgents.find(s => s.task === 'psw4_default_agent');
    const b = seenAgents.find(s => s.task === 'psw4_overridden_agent');
    assert.strictEqual(a.agent_id, 'default-agent',
      'unmapped task must keep the default agent_id from substrate_ctx');
    assert.strictEqual(b.agent_id, 'override-agent',
      'mapped task must see the override agent_id in its view.substrate_ctx');
  });

  test('ENT-44: identity-vectors rerankByIdentity adjusts scores by anchor/refusal alignment', () => {
    const iv = require('../shared-core/identity-vectors.js');
    const directions = [
      { kind: 'anchor',  label: 'a', direction: [1, 0, 0] },
      { kind: 'refusal', label: 'r', direction: [0, 1, 0] }
    ];
    const items = [
      { id: 'aligned',    embedding: [1, 0, 0], score: 0.5 }, // matches anchor
      { id: 'forbidden',  embedding: [0, 1, 0], score: 0.5 }, // matches refusal
      { id: 'neutral',    embedding: [0, 0, 1], score: 0.5 }
    ];
    const out = iv.rerankByIdentity(items, directions, { anchor_weight: 0.4, refusal_weight: -0.4 });
    // anchored item ranks first, forbidden last
    assert.strictEqual(out[0].id, 'aligned',   'anchor-aligned ranks first');
    assert.strictEqual(out[2].id, 'forbidden', 'refusal-aligned ranks last');
    assert.ok(out[0].score > out[1].score, 'monotonic ordering');
    assert.ok(out[1].score > out[2].score, 'monotonic ordering');
  });

  test('ENT-43: identity-vectors math primitives (mean, sub, normalize, cosine)', () => {
    const iv = require('../shared-core/identity-vectors.js');
    assert.deepStrictEqual(iv.vecMean([[1, 2], [3, 4]]), [2, 3], 'mean works');
    assert.deepStrictEqual(iv.vecSub([5, 5], [1, 2]), [4, 3], 'sub works');
    const u = iv.vecNormalize([3, 4]);
    assert.ok(Math.abs(iv.vecNorm(u) - 1) < 1e-9, 'normalized magnitude is 1');
    assert.ok(Math.abs(iv.cosine([1, 0], [1, 0]) - 1) < 1e-9, 'cosine identical=1');
    assert.ok(Math.abs(iv.cosine([1, 0], [0, 1])) < 1e-9, 'cosine orthogonal=0');
  });

  test('ENT-42: transport-config snapshot exposes env/file/default sources for UI rendering', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = require('os').tmpdir() + '/troth-snap-' + Date.now();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'),
      JSON.stringify({ ollama_model: 'custom-from-file' }));
    process.env.TROTH_CONFIG_DIR  = tmpDir;
    process.env.TROTH_CONFIG_PATH = path.join(tmpDir, 'config.json');
    delete require.cache[require.resolve('../shared-core/transport-config.js')];
    const cfg = require('../shared-core/transport-config.js');
    process.env.TROTH_LLAMACPP_HOST = 'http://from-env-test:9988';
    const snap = cfg.snapshot();
    // Six fields covered
    assert.ok(snap.llamacpp_host && snap.ollama_host && snap.embedding_host
      && snap.slot_save_path && snap.llamacpp_model && snap.ollama_model,
      'all six fields present in snapshot');
    // Source labelling
    assert.strictEqual(snap.llamacpp_host.source, 'env');
    assert.strictEqual(snap.llamacpp_host.value, 'http://from-env-test:9988');
    assert.strictEqual(snap.ollama_model.source, 'file');
    assert.strictEqual(snap.ollama_model.value, 'custom-from-file');
    assert.strictEqual(snap.slot_save_path.source, 'default');
    // Each entry exposes default + env_key for UI display
    for (const k of Object.keys(snap)) {
      assert.ok(Object.prototype.hasOwnProperty.call(snap[k], 'default'));
      assert.ok(Object.prototype.hasOwnProperty.call(snap[k], 'env_key'));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TROTH_CONFIG_DIR;
    delete process.env.TROTH_CONFIG_PATH;
    delete process.env.TROTH_LLAMACPP_HOST;
    delete require.cache[require.resolve('../shared-core/transport-config.js')];
  });

  test('ENT-41: chameleon ingestDocument + queryScope + listScopes round-trip end-to-end', async () => {
    const ch = require('../shared-core/chameleon.js');
    const agent_id = 'cham-' + Date.now();
    const cwd = require('os').tmpdir() + '/cham-' + Date.now();
    const text = [
      'The argus tokenizer handles UTF-8 source files with grapheme clusters.',
      'It uses a finite state machine for whitespace and identifier classification.',
      '',
      'Performance benchmarks show 2.4 GB/s on M3 Ultra with full Unicode coverage.',
      'The fast path uses SIMD intrinsics for ASCII-only segments.'
    ].join('\n');
    const r = await ch.ingestDocument({
      agent_id, cwd,
      scope: 'docs:argus',
      title: 'argus design',
      text,
      chunk_chars: 200,
      chunk_overlap: 30
    });
    assert.strictEqual(r.ok, true, 'ingest ok');
    assert.ok(r.recorded >= 1, 'at least one chunk recorded');
    // List scopes — argus must appear
    const scopes = ch.listScopes({ agent_id, cwd });
    assert.ok(scopes.find(s => s.scope === 'docs:argus'), 'scope listed');
    // Query within scope (lexical fallback — no embeddings here)
    const q = await ch.queryScope({
      agent_id, cwd,
      scope: 'docs:argus',
      query: 'tokenizer SIMD performance'
    });
    assert.ok(q.items.length >= 1, 'at least one match');
    // Other scope must NOT match
    const empty = await ch.queryScope({
      agent_id, cwd,
      scope: 'docs:does-not-exist',
      query: 'tokenizer'
    });
    assert.strictEqual(empty.items.length, 0, 'wrong scope returns nothing');
  });

  test('ENT-40: chameleon chunkText respects budget + preserves sentence boundaries', () => {
    const ch = require('../shared-core/chameleon.js');
    // chunkText enforces a minimum target of 120 chars so chunks are
    // big enough to embed meaningfully. Build a text well above that.
    const sentence = 'This sentence has roughly forty characters X.';  // ~46 chars
    const text = Array(20).fill(sentence).join(' '); // ~920 chars
    const chunks = ch.chunkText(text, { chunk_chars: 200, chunk_overlap: 30 });
    assert.ok(chunks.length >= 3, 'multiple chunks for budget-exceeding text (got ' + chunks.length + ')');
    for (const c of chunks) {
      assert.ok(c.length <= 300, 'chunk within ~budget*1.5 (got ' + c.length + ')');
    }
    // Each chunk should end with sentence-ending punctuation when
    // possible (sentence-aware packing).
    for (const c of chunks) {
      assert.ok(/[.!?]\s*$/.test(c.trim()) || c === chunks[chunks.length - 1],
        'chunk ends at sentence boundary');
    }
  });

  test('ENT-39: engram listEngrams supports scope filter', () => {
    const eng = require('../shared-core/engram.js');
    const agent_id = 'scope-test-' + Date.now();
    eng.recordEngram({ agent_id, statement: 'fact A', scope: 'corpusA' });
    eng.recordEngram({ agent_id, statement: 'fact B', scope: 'corpusB' });
    eng.recordEngram({ agent_id, statement: 'fact C' }); // no scope
    const a = eng.listEngrams({ agent_id, scope: 'corpusA' });
    const b = eng.listEngrams({ agent_id, scope: 'corpusB' });
    const none = eng.listEngrams({ agent_id, scope: null });
    const all = eng.listEngrams({ agent_id });
    assert.strictEqual(a.length, 1, 'corpusA filter');
    assert.strictEqual(b.length, 1, 'corpusB filter');
    assert.strictEqual(none.length, 1, 'null scope filter');
    assert.strictEqual(all.length, 3, 'no filter shows all');
  });

  test('ENT-38: auto-engram buildJudgePrompt includes both turn sides + JSON instruction', () => {
    const ae = require('../shared-core/auto-engram.js');
    const p = ae.buildJudgePrompt('I prefer tabs', 'OK noted.');
    assert.ok(/I prefer tabs/.test(p), 'user text included');
    assert.ok(/OK noted/.test(p), 'assistant text included');
    assert.ok(/JSON.*facts/i.test(p), 'JSON output instruction present');
    assert.ok(/durable/i.test(p), 'judge framing present');
    assert.deepStrictEqual(ae.FACTS_SCHEMA.required, ['facts'], 'schema requires facts');
  });

  test('ENT-37: transport-config writePatch persists overrides + readback survives mtime', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = require('os').tmpdir() + '/troth-cfg-test-' + Date.now();
    process.env.TROTH_CONFIG_DIR  = tmpDir;
    process.env.TROTH_CONFIG_PATH = path.join(tmpDir, 'config.json');
    delete require.cache[require.resolve('../shared-core/transport-config.js')];
    const cfg = require('../shared-core/transport-config.js');
    delete process.env.TROTH_LLAMACPP_HOST;
    assert.strictEqual(cfg.llamacppHost(), 'http://127.0.0.1:11436', 'starts at default');
    const ok = cfg.writePatch({ llamacpp_host: 'http://my-box:9999' });
    assert.strictEqual(ok, true, 'writePatch ok');
    assert.strictEqual(cfg.llamacppHost(), 'http://my-box:9999', 'override persisted');
    assert.ok(fs.existsSync(path.join(tmpDir, 'config.json')), 'file written');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TROTH_CONFIG_DIR;
    delete process.env.TROTH_CONFIG_PATH;
    delete require.cache[require.resolve('../shared-core/transport-config.js')];
  });

  test('ENT-36: transport-config resolves env > file > default', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = require('os').tmpdir() + '/troth-cfg-prio-' + Date.now();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'),
      JSON.stringify({ llamacpp_host: 'http://from-file:8000', ollama_host: 'http://from-file:7000' }));
    process.env.TROTH_CONFIG_DIR  = tmpDir;
    process.env.TROTH_CONFIG_PATH = path.join(tmpDir, 'config.json');
    delete require.cache[require.resolve('../shared-core/transport-config.js')];
    const cfg = require('../shared-core/transport-config.js');
    // No env override — file should win over default
    delete process.env.TROTH_LLAMACPP_HOST;
    assert.strictEqual(cfg.llamacppHost(), 'http://from-file:8000', 'file beats default');
    // Env override — env should win over file
    process.env.TROTH_LLAMACPP_HOST = 'http://from-env:6000';
    assert.strictEqual(cfg.llamacppHost(), 'http://from-env:6000', 'env beats file');
    // Default fallback for unset field
    assert.strictEqual(cfg.slotSavePath(), '/tmp/llama-slots', 'default falls through');
    // snapshot tags source
    const snap = cfg.snapshot();
    assert.strictEqual(snap.llamacpp_host.source, 'env');
    assert.strictEqual(snap.ollama_host.source,   'file');
    assert.strictEqual(snap.slot_save_path.source, 'default');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TROTH_CONFIG_DIR;
    delete process.env.TROTH_CONFIG_PATH;
    delete process.env.TROTH_LLAMACPP_HOST;
    delete require.cache[require.resolve('../shared-core/transport-config.js')];
  });

  test('ENT-35: orchestrator composeAgentic loops through tool_calls then returns text', async () => {
    // Fake transport: first round emits tool_call, second round emits text.
    let round = 0;
    const fakeTransport = {
      stream(req) {
        round++;
        const events = (round === 1)
          ? [
              { tool_calls: [{ id: 'c1', function: { name: 'engram_search', arguments: '{"query":"x"}' } }], finish_reason: 'tool_calls' },
              { done: true, finish_reason: 'tool_calls' }
            ]
          : [
              { delta: 'I checked memory; here is the answer.' },
              { done: true, finish_reason: 'stop' }
            ];
        let i = 0;
        return {
          [Symbol.asyncIterator]() { return this; },
          next: async () => {
            if (i >= events.length) return { value: undefined, done: true };
            return { value: events[i++], done: false };
          }
        };
      },
      abort() {}
    };
    const orch = llmOrchestrator.makeOrchestrator({
      transport: fakeTransport,
      stable_prefix: 'sys',
      tool_runner: async (tc) => JSON.stringify({ name: tc.function.name, called_with: tc.function.arguments })
    });
    const res = await orch.composeAgentic({ kind: 'llm', prompt: 'hi', options: { max_iterations: 4, tools: [{}] } }, {});
    assert.strictEqual(res.status, 'ok');
    assert.ok(/checked memory/.test(res.text), 'final text from second round');
    assert.strictEqual(res.trace.length, 2, 'two iterations recorded');
    assert.strictEqual(res.trace[0].finish_reason, 'tool_calls');
    assert.strictEqual(res.trace[1].finish_reason, 'stop');
  });

  test('ENT-34: substrate-tools dispatches engram_search through registered tool', () => {
    // Test-pollution isolation: earlier tests in the suite leave the
    // cached shared-core/state module pointing at a wiped /tmp dir
    // (T3 et al set CLAUDE_PLUGIN_DATA then rm the dir). The cached
    // engram/substrate-tools modules hold that stale state reference,
    // so recordEngram writes to a dead path and engram_search reads
    // nothing back. Mass-invalidate require.cache for the substrate
    // chain + ensure CLAUDE_PLUGIN_DATA is unset so a fresh require
    // captures DATA_DIR=~/.troth. Pattern mirrors RCL-99 cleanup.
    const _SAVED_ENV = process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_DATA;
    for (const key of Object.keys(require.cache)) {
      if (key.indexOf('/shared-core/') >= 0) delete require.cache[key];
    }
    const tools  = require('../shared-core/substrate-tools.js');
    const engram = require('../shared-core/engram.js');
    const agent_id = 'st-' + Date.now();
    // A genuinely-unique ALPHA token (base36 of the timestamp) — NOT the old
    // hardcoded 'zxqv' suffix + pure-digit timestamp, which every run shared
    // and the tokenizer collapsed, so accumulated fixtures from prior runs all
    // scored identically and the fresh one couldn't win top-3 once recall
    // stopped suppressing legacy engrams (S3 fail-neutral fix). A single
    // distinctive alpha token means only THIS fixture matches the query.
    const unique = 'roundtripz' + Date.now().toString(36);
    engram.recordEngram({ agent_id, statement: 'fixture engram ' + unique + ' for round-trip verification' });
    const toolCall = {
      function: {
        name: 'engram_search',
        arguments: '{"query":"' + unique + '","k":3}'
      }
    };
    return tools.dispatchToolCall(toolCall, { agent_id })
      .then(payload => {
        if (_SAVED_ENV === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
        else process.env.CLAUDE_PLUGIN_DATA = _SAVED_ENV;
        const data = JSON.parse(payload);
        assert.ok(Array.isArray(data.results), 'results array returned');
        assert.ok(data.results.length >= 1, 'at least one result');
        assert.ok(data.results.some(r => r.statement.includes(unique)),
          'fixture engram surfaces via engram_search; got: ' + JSON.stringify(data.results));
      });
  });

  test('ENT-33: substrate-tools toolsArray exposes OpenAI-compatible function schemas', () => {
    const tools = require('../shared-core/substrate-tools.js');
    const arr = tools.toolsArray();
    assert.ok(Array.isArray(arr) && arr.length >= 3, 'at least 3 tools registered');
    for (const t of arr) {
      assert.strictEqual(t.type, 'function', 'OpenAI tools format');
      assert.ok(t.function && t.function.name, 'each has function.name');
      assert.ok(t.function.parameters && t.function.parameters.type === 'object', 'parameters are object schemas');
    }
    const filtered = tools.toolsArray(['engram_search']);
    assert.strictEqual(filtered.length, 1, 'filter respects names');
    assert.strictEqual(filtered[0].function.name, 'engram_search');
  });

  test('ENT-32: kv-state filenameForScope namespaces by agent + scope + slot', () => {
    const kv = require('../shared-core/kv-state.js');
    assert.strictEqual(kv.filenameForScope({ agent_id: 'demo-entity', scope: 'session-1', slot: 0 }),
      'demo-entity__session-1__slot0.kv');
    // sanitize unsafe chars — dots, slashes, backslashes all collapse to '_'
    // so the resulting filename can never escape --slot-save-path's directory.
    assert.strictEqual(kv.filenameForScope({ agent_id: 'a/b\\c', scope: '../etc/passwd', slot: 7 }),
      'a_b_c_____etc_passwd__slot7.kv');
  });

  test('ENT-31: kv-state save/restore returns ok:false when host missing (best-effort surface)', () => {
    const kv = require('../shared-core/kv-state.js');
    return Promise.all([
      kv.saveSlot({}),
      kv.restoreSlot({ host: 'http://x', slot: 0 })
    ]).then(([sv, rs]) => {
      assert.strictEqual(sv.ok, false, 'save with no host fails cleanly');
      assert.ok(sv.error, 'save returns error reason');
      assert.strictEqual(rs.ok, false, 'restore with no filename fails cleanly');
    });
  });

  test('ENT-30: engram lexical retrieval ranks token-overlap matches above unrelated', () => {
    const engram = require('../shared-core/engram.js');
    const agent_id = 'test-engram-' + Date.now();
    engram.recordEngram({ agent_id, statement: 'The codeword is cerulean-tortoise', source: 'user' });
    engram.recordEngram({ agent_id, statement: 'I prefer dark mode in the editor', source: 'user' });
    engram.recordEngram({ agent_id, statement: 'My dog is named Pepper', source: 'user' });
    return engram.retrieveRelevant({ agent_id, query: 'what was the codeword?', k: 3 })
      .then(results => {
        assert.ok(results.length >= 1, 'must retrieve at least one match');
        assert.ok(/cerulean/.test(results[0].statement), 'top match must mention codeword');
      });
  });

  test('ENT-29: engram cosine similarity returns 1 for identical vectors and 0 for orthogonal', () => {
    const engram = require('../shared-core/engram.js');
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    const c = [0, 1, 0];
    assert.ok(Math.abs(engram.cosine(a, b) - 1) < 1e-9, 'identical → 1');
    assert.ok(Math.abs(engram.cosine(a, c)) < 1e-9, 'orthogonal → 0');
  });

  test('ENT-28: engram renderRetrieval emits bullet list within budget', () => {
    const engram = require('../shared-core/engram.js');
    const items = [
      { statement: 'fact one', score: 0.9 },
      { statement: 'fact two', score: 0.5 }
    ];
    const out = engram.renderRetrieval(items);
    assert.ok(out.includes('Substrate engram'), 'header present');
    assert.ok(out.includes('fact one'), 'first item present');
    assert.ok(out.includes('fact two'), 'second item present');
  });

  test('ENT-27: grammar-from-substrate cross_lingual expands bias to known translations', () => {
    const { buildConstraints } = require('../shared-core/grammar-from-substrate.js');
    // Single-word extras are rejected post bench eval-2 (they collide
    // with compliance vocabulary). Use multi-word phrases that contain
    // the target English term — cross-lingual fallback finds the term
    // by first-word lookup.
    const out = buildConstraints(
      { refusals: ['I do not provide medical advice that substitutes professional consultation'] },
      { extra_bias_strings: ['recommend taking'], cross_lingual: true }
    );
    // English fragments derived from refusal + extras
    assert.ok(out.bias_strings.includes('medical advice'),
      'English fragment from refusal present');
    // Cross-lingual: Russian + Chinese for "medical" should appear
    assert.ok(out.bias_strings.includes('медицинский'),
      'Russian translation of medical present');
    assert.ok(out.bias_strings.includes('医疗'),
      'Chinese translation of medical present');
    // recommend → translations (via first-word fallback in CROSS_LINGUAL)
    assert.ok(out.bias_strings.includes('推荐') || out.bias_strings.includes('рекомендую'),
      'recommend translations present');
  });

  test('ENT-26: dialogue-memory recordTurn + recentTurns round-trip across rebuild', () => {
    const dm = require('../shared-core/dialogue-memory.js');
    const agent_id = 'test-dialogue-' + Date.now();
    const ok1 = dm.recordTurn({
      agent_id, user_id: 'u', cwd: '/tmp/x',
      user_text: 'first user line', assistant_text: 'first reply'
    });
    const ok2 = dm.recordTurn({
      agent_id, user_id: 'u', cwd: '/tmp/x',
      user_text: 'second line', assistant_text: 'second reply',
      faculty: 'llamacpp', elapsed_ms: 123, fragments: 1
    });
    assert.ok(ok1 && ok2, 'both writes accepted');
    const turns = dm.recentTurns({ agent_id, cwd: '/tmp/x', limit: 5 });
    assert.strictEqual(turns.length, 2, 'two turns retrieved');
    assert.strictEqual(turns[0].user_text, 'first user line', 'chronological order preserved');
    assert.strictEqual(turns[1].faculty, 'llamacpp', 'faculty metadata round-trips');
  });

  test('ENT-26b: HALF rows (mirror user-only / cancelled assistant-only) never consume window slots', () => {
    // The app-side chat mirror writes a
    // user-only row at send time and an assistant-only "(cancelled)" row on
    // aborts; two cancelled sends filled the whole 3-turn window with half
    // rows and evicted the real context — the partner went amnesiac inside
    // its own conversation. A window turn must be a COMPLETE exchange.
    const dm = require('../shared-core/dialogue-memory.js');
    const agent_id = 'test-halfrows-' + Date.now();
    const conv = 'conv-halfrows-' + Date.now();
    dm.recordTurn({ agent_id, user_id: 'u', cwd: '/tmp/x', conversation_id: conv,
      user_text: 'the real earlier exchange', assistant_text: 'the real earlier answer' });
    // Mirror-shaped junk, newest-first from the reader's perspective:
    dm.recordTurn({ agent_id, user_id: 'u', cwd: '/tmp/x', conversation_id: conv,
      user_text: 'gia ftiaxto tora', assistant_text: '' });
    dm.recordTurn({ agent_id, user_id: 'u', cwd: '/tmp/x', conversation_id: conv,
      user_text: '', assistant_text: '(cancelled)' });
    dm.recordTurn({ agent_id, user_id: 'u', cwd: '/tmp/x', conversation_id: conv,
      user_text: 'go on', assistant_text: '' });
    const turns = dm.recentTurns({ agent_id, cwd: '/tmp/x', conversation_id: conv, limit: 3 });
    assert.strictEqual(turns.length, 1, 'only the complete exchange fills a slot; got ' + turns.length);
    assert.strictEqual(turns[0].user_text, 'the real earlier exchange',
      'the real context survives the junk half rows');
  });

  test('ENT-25: dialogue-memory renderTranscript emits readable transcript with budget cap', () => {
    const dm = require('../shared-core/dialogue-memory.js');
    const turns = [
      { ts: 1, user_text: 'hello', assistant_text: 'hi' },
      { ts: 2, user_text: 'how are you', assistant_text: 'good' }
    ];
    const out = dm.renderTranscript(turns);
    assert.ok(out.includes('Recent dialogue'), 'header present');
    assert.ok(out.includes('user: hello'), 'first user turn surfaces');
    assert.ok(out.includes('faculty: good'), 'last faculty reply surfaces');
    // Budget cap test
    const longTurns = [];
    for (let i = 0; i < 50; i++) longTurns.push({ ts: i, user_text: 'q'.repeat(80), assistant_text: 'a'.repeat(80) });
    const capped = dm.renderTranscript(longTurns, { max_chars: 500 });
    assert.ok(capped.length <= 600, 'transcript respects budget cap (with elision marker)');
    assert.ok(capped.includes('elided'), 'elision marker present');
  });

  test('ENT-24: prefix_provider context refreshes per call while system stays byte-stable', async () => {
    // Prefix-stability contract: the provider's VOLATILE output
    // must NOT land in req.system (one changed byte there invalidates the
    // llama-server KV prefix in front of ~9K tokens of tool schemas, which
    // cost 40s per turn. It rides the user message instead, fenced,
    // and still refreshes on every call.
    const captured = [];
    const fakeTransport = {
      stream(req) {
        captured.push(req);
        return {
          [Symbol.asyncIterator]() { return this; },
          next: async () => ({ value: { done: true }, done: false })
        };
      },
      abort() {}
    };
    let counter = 0;
    const orch = llmOrchestrator.makeOrchestrator({
      transport: fakeTransport,
      stable_prefix: 'STATIC',
      prefix_provider: () => 'DYNAMIC#' + (++counter)
    });
    await orch.callOnce({ kind: 'llm', prompt: 'one' }, {});
    await orch.callOnce({ kind: 'llm', prompt: 'two' }, {});
    assert.strictEqual(captured.length, 2);
    // system: byte-identical across calls - the cacheable prefix.
    assert.strictEqual(captured[0].system, 'STATIC');
    assert.strictEqual(captured[1].system, 'STATIC');
    // user: carries the per-call context, fenced, then the prompt.
    assert.strictEqual(captured[0].user, '<turn_context>\nDYNAMIC#1\n</turn_context>\n\none');
    assert.strictEqual(captured[1].user, '<turn_context>\nDYNAMIC#2\n</turn_context>\n\ntwo');
  });

  test('ENT-23: dispatcher picks llamacpp when substrate decode constraints are present', () => {
    const dispatchModule = require('../shared-core/dispatch.js');
    const d = dispatchModule.makeDispatcher({ available: ['llamacpp', 'ollama', 'router'] });
    const action = {
      kind: 'llm',
      prompt: 'hi',
      options: { substrate_decode_constraints: { bias_strings: ['medical advice'], bias_amount: -100 } }
    };
    const choice = d.pick(action, { mind: { active_projects: [] } });
    assert.strictEqual(choice.faculty, 'llamacpp', 'must route to llamacpp when constraints present');
    assert.strictEqual(choice._rule, 'decode_constraints_require_llamacpp');
  });

  test('ENT-22: dispatcher honors explicit transport_hint over rules', () => {
    const dispatchModule = require('../shared-core/dispatch.js');
    const d = dispatchModule.makeDispatcher({ available: ['llamacpp', 'ollama', 'anthropic'] });
    const action = {
      kind: 'llm',
      prompt: 'hard reasoning task',
      options: {
        transport_hint: 'ollama',                  // explicit hint
        difficulty: 'hard',                          // would otherwise route to anthropic
        substrate_decode_constraints: { bias_strings: ['x'] } // would otherwise route to llamacpp
      }
    };
    const choice = d.pick(action, { mind: { active_projects: [] } });
    assert.strictEqual(choice.faculty, 'ollama', 'explicit hint must win');
    assert.strictEqual(choice._rule, 'explicit_transport_hint');
  });

  test('ENT-21: dispatcher falls back to priority order when no rule matches', () => {
    const dispatchModule = require('../shared-core/dispatch.js');
    const d = dispatchModule.makeDispatcher({ available: ['router', 'noop'] });
    const action = { kind: 'llm', prompt: 'plain', options: {} };
    const choice = d.pick(action, {});
    assert.strictEqual(choice.faculty, 'router', 'priority default picks router over noop');
    assert.strictEqual(choice._rule, 'priority_default');
  });

  test('ENT-20: llamacpp transport exposes stream + abort surface (no live network)', () => {
    const { makeLlamaCppTransport } = require('../shared-core/transports/llamacpp.js');
    const tx = makeLlamaCppTransport({ host: 'http://127.0.0.1:11436', model: 'qwen3.6:35b' });
    assert.strictEqual(typeof tx.stream, 'function', 'stream must exist');
    assert.strictEqual(typeof tx.abort, 'function', 'abort must exist');
    // Live decode-time intervention is verified out-of-band via the demo
    // binary against a running llama-server. CI does not require the
    // server to be present — the transport surface is unit-checkable
    // without it.
  });

  test('ENT-93: chameleon-runtime spawns filesystem adapter end-to-end', async () => {
    // End-to-end: substrate runtime spawns the filesystem reference adapter,
    // walks the JSON-RPC handshake (initialize → describe → read), and
    // funnels chunks into chameleon.ingestDocument(). Then we query the
    // resulting scope and assert at least one match comes back. Verifies
    // the protocol is wired end-to-end (no direct ingestDocument shortcut).
    const fsRT = require('fs');
    const pathRT = require('path');
    const pRT = pathRT.resolve(__dirname, '..');
    const ADAPTER_RT = pathRT.join(pRT, 'adapters', 'chameleon-filesystem.mjs');
    const runtime = require('../shared-core/chameleon-runtime.js');
    const ch = require('../shared-core/chameleon.js');

    const tmpDir = require('os').tmpdir() + '/gc-rt-fixture-' + Date.now();
    fsRT.mkdirSync(tmpDir, { recursive: true });
    // Filesystem adapter requires file size in [200, 2_000_000] bytes.
    fsRT.writeFileSync(pathRT.join(tmpDir, 'one.md'),
      '# Doc One\n\nThe substrate dispatch layer routes between faculties. ' +
      'tachyon '.repeat(40));
    fsRT.writeFileSync(pathRT.join(tmpDir, 'two.md'),
      '# Doc Two\n\nEvery action_record carries an explicit causal edge. ' +
      'plumeria '.repeat(40));
    fsRT.writeFileSync(pathRT.join(tmpDir, 'three.txt'),
      'Filesystem chameleon adapter speaks JSON-RPC over stdio. ' +
      'aurelia '.repeat(40));

    const agent_id = 'rt-' + Date.now();
    const cwd = require('os').tmpdir() + '/rt-cwd-' + Date.now();

    const result = await runtime.runIngestionFlow(
      'node',
      [ADAPTER_RT, '--root', tmpDir, '--source-id', 'fs-rt-test'],
      { agent_id, cwd, scope: 'test:rt', label: 'rt-test' }
    );

    assert.ok(result.ingested > 0, 'runtime must report ingested>0 (got: ' + result.ingested + ')');
    assert.deepStrictEqual(result.scopes, ['test:rt']);
    assert.strictEqual(result.source_id, 'fs-rt-test');

    // Lexical search inside the runtime-produced scope. One of the
    // unique words from the fixtures must come back via queryScope.
    const q = await ch.queryScope({
      agent_id, cwd,
      scope: 'test:rt',
      query: 'tachyon plumeria aurelia substrate'
    });
    assert.ok(q.items.length > 0,
      'queryScope must return >0 hits from runtime-ingested scope (got: ' + q.items.length + ')');

    // Cleanup.
    fsRT.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ENT-94: drift-monitor flags sycophancy on high "you\'re right" frequency', () => {
    const dm = require('../shared-core/drift-monitor.js');
    // 4 assistant turns; 3 contain canonical sycophancy phrases. Score
    // should be 3/4 = 0.75, flagged as a signal with 3 evidence ids.
    const actions = [
      { id: 'a1', type: 'tool_call', input: JSON.stringify({ tool_name: 'dialogue.turn' }),
        output: JSON.stringify({ assistant_text: "You're absolutely right, I should reconsider." }) },
      { id: 'a2', type: 'tool_call', input: JSON.stringify({ tool_name: 'dialogue.turn' }),
        output: JSON.stringify({ assistant_text: "Great point, my apologies for the confusion." }) },
      { id: 'a3', type: 'tool_call', input: JSON.stringify({ tool_name: 'dialogue.turn' }),
        output: JSON.stringify({ assistant_text: "The substrate dispatches based on profile constraints." }) },
      { id: 'a4', type: 'tool_call', input: JSON.stringify({ tool_name: 'dialogue.turn' }),
        output: JSON.stringify({ assistant_text: "I was wrong about that — let me revise." }) }
    ];
    const r = dm.analyzeWindow(actions);
    assert.ok(r.sycophancy >= 0.7, 'sycophancy score must reflect 3/4 hit rate (got ' + r.sycophancy + ')');
    assert.strictEqual(r.tunnel_vision, 0, 'tunnel_vision should not fire on dialogue turns');
    const sig = r.signals.find(s => s.kind === 'sycophancy');
    assert.ok(sig, 'sycophancy signal present in signals[]');
    assert.strictEqual(sig.evidence.length, 3, 'three sycophantic turns recorded as evidence');
    assert.deepStrictEqual(sig.evidence.sort(), ['a1', 'a2', 'a4']);
  });

  test('ENT-95: drift-monitor flags tunnel_vision on 6x same-tool repetition', () => {
    const dm = require('../shared-core/drift-monitor.js');
    // 7 tool_call records where 6 in a row use the same tool. Run length
    // 6 over 7 named-tool actions → score ~0.857, evidence list contains
    // the 6 ids in the run.
    const sameTool = (id) => ({
      id, type: 'tool_call',
      input: JSON.stringify({ tool_name: 'Grep', args: { pattern: 'foo' } }),
      output: JSON.stringify({ status: 'ok' })
    });
    const actions = [
      { id: 'r0', type: 'tool_call', input: JSON.stringify({ tool_name: 'Read' }),
        output: JSON.stringify({ status: 'ok' }) },
      sameTool('g1'), sameTool('g2'), sameTool('g3'),
      sameTool('g4'), sameTool('g5'), sameTool('g6')
    ];
    const r = dm.analyzeWindow(actions);
    assert.ok(r.tunnel_vision > 0.6,
      'tunnel_vision must fire on 6-in-a-row Grep streak (got ' + r.tunnel_vision + ')');
    const sig = r.signals.find(s => s.kind === 'tunnel_vision');
    assert.ok(sig, 'tunnel_vision signal present');
    assert.strictEqual(sig.evidence.length, 6, 'all 6 streak ids in evidence');
    assert.deepStrictEqual(sig.evidence, ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
    // Sycophancy unrelated → must stay 0.
    assert.strictEqual(r.sycophancy, 0);
  });

  test('ENT-96: deliberator.tick() writes engram when drift score exceeds threshold', () => {
    const { Deliberator } = require('../shared-core/deliberator.js');
    const eng = require('../shared-core/engram.js');
    const agent_id = 'delib-drift-' + Date.now();
    const cwd = require('os').tmpdir() + '/delib-' + Date.now();
    // Pre-seed substrate with assistant turns that will trip sycophancy.
    const dm2 = require('../shared-core/dialogue-memory.js');
    for (let i = 0; i < 5; i++) {
      dm2.recordTurn({
        agent_id, cwd, user_id: 'u',
        user_text: 'q' + i,
        assistant_text: i < 4
          ? "You're absolutely right, I'll defer to your judgment."
          : "I apologize for the mistake, you're correct."
      });
    }
    const captured = [];
    const d = new Deliberator({
      agent_id, cwd,
      enabled: true,                // bypass cfg.deliberator_enabled default-off
      threshold: 0.3,
      window_limit: 50,
      notify: (n) => captured.push(n)
    });
    const summary = d.tick();
    assert.strictEqual(summary.ok, true, 'tick reports ok');
    assert.ok(summary.window_size >= 5, 'window pulled the seeded turns');
    assert.ok(summary.drift, 'drift report present');
    assert.ok(summary.drift.sycophancy > 0.3, 'sycophancy crosses threshold');
    assert.ok(summary.drift_engrams_written >= 1, 'at least one drift engram written');
    // Confirm engram is on disk under the system:drift scope.
    const engrams = eng.listEngrams({ agent_id, cwd, scope: 'system:drift' });
    assert.ok(engrams.length >= 1, 'system:drift engram persisted');
    const sycEngram = engrams.find(e => /sycophancy/i.test(e.statement));
    assert.ok(sycEngram, 'sycophancy engram present among system:drift engrams');
    // Notify fired with structured drift_signal carrying signal_kind.
    const sigEvent = captured.find(e => e.kind === 'drift_signal');
    assert.ok(sigEvent, 'drift_signal notification emitted');
    assert.ok(typeof sigEvent.signal_kind === 'string' && sigEvent.signal_kind.length > 0,
      'drift_signal event names the underlying signal kind');
  });

  test('ENT-97: deliberator.tick() with empty action history is a no-op', () => {
    const { Deliberator } = require('../shared-core/deliberator.js');
    const eng = require('../shared-core/engram.js');
    const agent_id = 'delib-empty-' + Date.now();
    const cwd = require('os').tmpdir() + '/delib-empty-' + Date.now();
    const captured = [];
    const d = new Deliberator({
      agent_id, cwd,
      enabled: true,
      notify: (n) => captured.push(n)
    });
    const summary = d.tick();
    assert.strictEqual(summary.window_size, 0, 'no actions in window');
    assert.strictEqual(summary.drift_engrams_written, 0, 'no engrams written');
    assert.strictEqual(summary.contradiction_engrams_written, 0, 'no contradictions written');
    // Should have emitted exactly one tick_skipped(empty_window) event.
    const skip = captured.find(e => e.kind === 'tick_skipped' && e.reason === 'empty_window');
    assert.ok(skip, 'empty-window skip notification emitted');
    // And nothing landed under the drift scope.
    const engrams = eng.listEngrams({ agent_id, cwd, scope: 'system:drift' });
    assert.strictEqual(engrams.length, 0, 'no drift engrams created on empty window');
  });

  test('ENT-98: deliberator → drift engram → session-start orientation surface (e2e wire)', () => {
    // P1.1 wire: simulate the session-start.mjs path. With
    // cfg.deliberator_enabled=true, a session boot ticks the deliberator,
    // which writes drift engrams; the same hook then queries those
    // engrams for the orientation block. This test stitches those steps
    // together without spawning the actual hook subprocess.
    const cfgMod = require('../shared-core/transport-config.js');
    const { Deliberator } = require('../shared-core/deliberator.js');
    const eng = require('../shared-core/engram.js');
    const dm = require('../shared-core/dialogue-memory.js');

    // 1) Default config has deliberator_enabled=true.: flipped
    // from off to on. Property #3 (continuous thinking) and Property #6
    // (self-knowledge of degradation) are entity-defining; they can't be
    // opt-in if the dream is "ONE living mind that thinks continuously".
    // Set to false in `~/.troth/config.json` to disable per workspace.
    const defEnabled = cfgMod.get('deliberator_enabled');
    assert.strictEqual(defEnabled, true,
      'deliberator_enabled defaults true in BUILT_IN_DEFAULTS');

    const agent_id = 'troth-deliberator-e2e-' + Date.now();
    const cwd = require('os').tmpdir() + '/delib-e2e-' + Date.now();

    // 2) Seed sycophantic dialogue so drift signals will fire.
    for (let i = 0; i < 5; i++) {
      dm.recordTurn({
        agent_id, cwd, user_id: 'u',
        user_text: 'plan ' + i,
        assistant_text: "You're absolutely right, that's a great idea."
      });
    }

    // 3) Tick once with enabled override (mirrors what session-start does
    //    when cfg.deliberator_enabled is set).
    const summary = new Deliberator({ agent_id, cwd, threshold: 0.3 })
      .tick({ enabled: true });
    assert.ok(summary.drift_engrams_written >= 1,
      'tick wrote at least one drift engram');

    // 4) Query last 24h drift engrams the way session-start.mjs does.
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const driftRows = eng.listEngrams({
      agent_id, cwd, scope: 'system:drift',
      limit: 10, order: 'desc'
    }) || [];
    const recent = driftRows.filter((r) => (r.ts || 0) >= since).slice(0, 3);
    assert.ok(recent.length >= 1, 'recent drift engram retrievable for orientation');

    // 5) Format would render at least one '• <statement>' line.
    const lines = recent.map((r) => '  • ' + String(r.statement || '').slice(0, 220));
    assert.ok(lines[0].length > 5, 'first drift line has a real statement body');
    assert.ok(/sycophancy|tunnel|repetition|length/i.test(lines[0]),
      'drift line names a known signal kind');
  });

  test('ENT-99: two panes in one project read their OWN thread, not each other\'s', async () => {
    const dm = require('../shared-core/dialogue-memory.js');
    const tools = require('../shared-core/substrate-tools.js');
    const cwd = require('os').tmpdir() + '/thread-scope-' + Date.now();
    const A = 'pane-A-' + Date.now();
    const B = 'pane-B-' + Date.now();
    const put = (cid, u) => dm.recordTurn({
      agent_id: 'thread-probe', user_id: 'default', cwd,
      conversation_id: cid, user_text: u, assistant_text: 'noted'
    });
    put(A, 'the deploy uses blue-green with a manual cutover');
    put(A, 'the cutover needs two approvals');
    put(B, 'the invoice template is missing the VAT line');
    put(B, 'the VAT line goes under the subtotal');

    const tool = tools.REGISTRY.dialogue_recent;
    const leaks = (r) => (JSON.stringify(r).match(/VAT|invoice/g) || []).length;

    const scoped = await tool.run({}, { cwd, conversation_id: A });
    assert.strictEqual(scoped.turns.length, 2, 'the thread returns its own two turns');
    assert.strictEqual(leaks(scoped), 0, "the other pane's turns must not appear");

    const unscoped = await tool.run({}, { cwd });
    assert.strictEqual(unscoped.turns.length, 4, 'a surface with no thread is unchanged');

    const cross = await tool.run({ all_projects: true }, { cwd, conversation_id: A });
    assert.ok(cross.turns.length >= 4, 'an explicit cross-read still crosses');
  });
})();

};
