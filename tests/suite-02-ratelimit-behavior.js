// SPDX-License-Identifier: AGPL-3.0-only
// Auto-split from tests/test-all.js (verbatim section bodies; order preserved).
// Sections: RATELIMIT (behavior) | PLUGIN HOOKS (behavior) | PROXY ↔ PLUGIN COEXISTENCE (behavior) | CRITIC ↔ REFLEXION LOOP (behavior) | ERRORTAX (behavior) | CRITIC (behavior) | TASK TIER CLASSIFIER (behavior) | DANGER CLASSIFIER (behavior) | REPOMAP (behavior) | EDIT MATCHER (behavior) | INJECTOR (behavior) 
module.exports = function run({ test, skip }) {
const assert = require('assert');
const TMP = require('os').tmpdir() + '/troth-validator-test-' + Date.now();
const dedup = require('../proxy/modules/dedup');
const { parseHeaders, parseRetryAfter } = require('../proxy/modules/ratelimit');
const { record, getRecent } = require('../proxy/modules/perflog');
const migrate = require('../proxy/modules/migrate');
// --- RATELIMIT (behavior) ---
console.log('\nRatelimit (behavior):');

test('parseHeaders extracts rate limit info', () => {
  const headers = {
    'x-ratelimit-limit-requests': '100',
    'x-ratelimit-remaining-requests': '50',
    'retry-after': '5',
  };
  const info = parseHeaders('test-provider', headers);
  assert(info);
  assert(info.remaining === 50);
  assert(info.limit === 100);
});

// --- PLUGIN HOOKS (behavior) ---
//
// Exercise plugin/hooks/*.mjs end-to-end by piping JSON payloads through
// `node <script>` and asserting the JSON response + state.db side effects.
// Uses a throwaway state dir so real ~/.troth/state.db stays clean.
console.log('\nPlugin hooks (behavior):');
(function runPluginHookTests() {
  const childProcess = require('child_process');
  const pathMod2 = require('path');
  const fsMod2 = require('fs');
  const REPO = pathMod2.resolve(__dirname, '..');
  const PLUGIN = pathMod2.join(REPO, 'plugin');
  const TMP_DATA = pathMod2.join(REPO, '.tmp-plugin-state');
  if (fsMod2.existsSync(TMP_DATA)) fsMod2.rmSync(TMP_DATA, { recursive: true, force: true });
  fsMod2.mkdirSync(TMP_DATA, { recursive: true });

  function runHook(script, payload) {
    const out = childProcess.execFileSync(
      'node',
      [pathMod2.join(PLUGIN, 'hooks', script)],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: TMP_DATA }),
        encoding: 'utf8'
      }
    );
    const trimmed = (out || '').trim();
    return trimmed ? JSON.parse(trimmed) : {};
  }

  test('LoopBreaker allows, nudges, then blocks on repeated identical tool calls', () => {
    const call = { session_id: 'loop-test', tool_name: 'Bash', tool_input: { command: 'false' } };
    assert.deepStrictEqual(runHook('loopbreaker.mjs', call), {}, 'call 1 should allow silently');
    assert.deepStrictEqual(runHook('loopbreaker.mjs', call), {}, 'call 2 should allow silently');
    const third = runHook('loopbreaker.mjs', call);
    assert.ok(third.hookSpecificOutput, 'call 3 should return hookSpecificOutput');
    assert.ok(
      (third.hookSpecificOutput.additionalContext || '').includes('troth/loopbreaker'),
      'call 3 should inject the loop-warning nudge'
    );
    const fifth = (runHook('loopbreaker.mjs', call), runHook('loopbreaker.mjs', call));
    assert.strictEqual(
      fifth.hookSpecificOutput && fifth.hookSpecificOutput.permissionDecision,
      'ask',
      'call 5 should escalate to ask'
    );
  });

  // Regression for the  hard-task benchmark misfire
  // (benchmarks/results/12-qwen-ab-hard.md). Loopbreaker killed legitimate
  // multi-bug exploration by denying repeat Read calls at turn 4. Read /
  // Grep / Glob are exploration tools — they must nudge (once) but never
  // deny, even at 6+ identical calls.
  test('LoopBreaker never denies repeat Read/Grep/Glob calls (exploration)', () => {
    const readCall = { session_id: 'loop-read-' + Date.now(), tool_name: 'Read', tool_input: { file_path: '/tmp/any.js' } };
    // 8 identical reads — simulating the benchmark's multi-bug exploration pattern
    for (let i = 0; i < 8; i++) {
      const r = runHook('loopbreaker.mjs', readCall);
      if (r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'ask') {
        throw new Error('Read was denied at iteration ' + (i + 1) + ' — regression of the hard-task misfire');
      }
    }
    // Grep + Glob same behaviour
    for (const tool of ['Grep', 'Glob']) {
      const call = { session_id: 'loop-' + tool + '-' + Date.now(), tool_name: tool, tool_input: { pattern: 'foo' } };
      for (let i = 0; i < 6; i++) {
        const r = runHook('loopbreaker.mjs', call);
        if (r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'ask') {
          throw new Error(tool + ' was denied at iteration ' + (i + 1));
        }
      }
    }
  });

  test('LoopBreaker still denies repeat Edit calls (Edit is the real loop signal)', () => {
    const editCall = { session_id: 'loop-edit-' + Date.now(), tool_name: 'Edit', tool_input: { file_path: '/tmp/a.js', old_string: 'x', new_string: 'y' } };
    // 4 identical edits should still escalate to ask — that IS the stuck-agent signal
    let denied = false;
    for (let i = 0; i < 6; i++) {
      const r = runHook('loopbreaker.mjs', editCall);
      if (r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'ask') {
        denied = true; break;
      }
    }
    assert.ok(denied, 'repeat Edit calls must still trigger the deny path');
  });

  test('VerifyFirst allows new files, blocks unread edits, releases after mark-read', () => {
    const newFile = pathMod2.join(TMP_DATA, 'brand-new.txt');
    const existing = __filename;

    assert.deepStrictEqual(
      runHook('verifyfirst.mjs', {
        session_id: 'vf-test-1',
        tool_name: 'Write',
        tool_input: { file_path: newFile, content: 'hello' }
      }),
      {},
      'new file should allow'
    );

    const firstEdit = runHook('verifyfirst.mjs', {
      session_id: 'vf-test-1',
      tool_name: 'Edit',
      tool_input: { file_path: existing, old_string: 'x', new_string: 'y' }
    });
    assert.strictEqual(
      firstEdit.hookSpecificOutput && firstEdit.hookSpecificOutput.permissionDecision,
      'ask',
      'unread edit on existing file should ask'
    );

    runHook('mark-read.mjs', {
      session_id: 'vf-test-1',
      tool_name: 'Read',
      tool_input: { file_path: existing }
    });

    assert.deepStrictEqual(
      runHook('verifyfirst.mjs', {
        session_id: 'vf-test-1',
        tool_name: 'Edit',
        tool_input: { file_path: existing, old_string: 'x', new_string: 'y' }
      }),
      {},
      'edit after read should allow'
    );
  });

  // MD-GUARD: claude user-memory writes must redirect to troth substrate.
  test('MD-GUARD-1: blocks Write into ~/.claude/projects/*/memory/*.md', () => {
    const os2 = require('os');
    const target = pathMod2.join(os2.homedir(), '.claude/projects/-Users-OPERATOR/memory/sample-note.md');
    const r = runHook('memory-md-guard.mjs', {
      session_id: 'md-guard-1', tool_name: 'Write',
      tool_input: { file_path: target, content: 'rule X' }
    });
    assert.strictEqual(
      r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision, 'deny',
      'memory .md write must be denied'
    );
    assert.match(
      r.hookSpecificOutput.permissionDecisionReason || '',
      /troth_engram_record/,
      'reason must redirect to substrate engram tool'
    );
  });

  test('MD-GUARD-2: allows Write into project-local CHANGELOG.md / docs/*.md', () => {
    const target = pathMod2.join(TMP_DATA, 'CHANGELOG.md');
    assert.deepStrictEqual(
      runHook('memory-md-guard.mjs', {
        session_id: 'md-guard-2', tool_name: 'Write',
        tool_input: { file_path: target, content: '## changelog' }
      }),
      {},
      'project-local .md must pass through'
    );
  });

  test('MD-GUARD-3: blocks Edit on ~/.claude/CLAUDE.md (global user instructions)', () => {
    const os3 = require('os');
    const target = pathMod2.join(os3.homedir(), '.claude/CLAUDE.md');
    const r = runHook('memory-md-guard.mjs', {
      session_id: 'md-guard-3', tool_name: 'Edit',
      tool_input: { file_path: target, old_string: 'a', new_string: 'b' }
    });
    assert.strictEqual(
      r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision, 'deny',
      'global CLAUDE.md edit must be denied'
    );
  });

  test('MD-GUARD-4: allows project-local CLAUDE.md (legitimate project docs)', () => {
    const target = pathMod2.join(TMP_DATA, 'CLAUDE.md');
    assert.deepStrictEqual(
      runHook('memory-md-guard.mjs', {
        session_id: 'md-guard-4', tool_name: 'Write',
        tool_input: { file_path: target, content: '# project rules' }
      }),
      {},
      'project-local CLAUDE.md must pass through'
    );
  });

  test('MD-GUARD-5: blocks the continuity files that sit BESIDE the memory folder', () => {
    // RESUME.md and progress.md live at ~/.claude/projects/<key>/, one level
    // above memory/. The guard required '/memory/' in the path, so a full
    // session handoff written to RESUME.md sails past the guard whose entire
    // purpose is to stop exactly that. Nothing an agent authors belongs anywhere under that
    // directory: it is Claude Code's own store, and continuity is the
    // substrate's job.
    const os5 = require('os');
    for (const name of ['RESUME.md', 'progress.md']) {
      const target = pathMod2.join(os5.homedir(), '.claude/projects/-Users-OPERATOR/' + name);
      const r = runHook('memory-md-guard.mjs', {
        session_id: 'md-guard-5', tool_name: 'Write',
        tool_input: { file_path: target, content: '# handoff' }
      });
      assert.strictEqual(
        r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision, 'deny',
        name + ' must be denied, not only files inside memory/'
      );
    }
  });

  test('MD-GUARD-6: the guard covers hashline_edit — troth\'s own editor cannot bypass it', () => {
    // The two hooks were defeating each other: edit-steer pushes every edit
    // onto troth-hashline, and this guard\'s matcher listed only
    // Write|Edit|MultiEdit. So the product\'s PREFERRED editor was the one
    // path into the operator\'s memory files that nothing checked — proven
    // live by editing ~/.claude/CLAUDE.md, a file this guard
    // names explicitly, with no block. A guard every real edit routes around
    // is decoration.
    const fsG = require('fs');
    const src = fsG.readFileSync(pathMod2.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8');
    const cfg = JSON.parse(src);
    const events = cfg.hooks || cfg;
    const entry = (events.PreToolUse || []).find((e) =>
      (e.hooks || []).some((h) => String(h.command || '').includes('memory-md-guard')));
    assert.ok(entry, 'the guard is registered');
    assert.match(String(entry.matcher), /hashline_edit/,
      'and its matcher includes the editor troth itself steers every edit into: ' + entry.matcher);

    // And it decides on the payload that editor actually sends.
    const os6 = require('os');
    const r = runHook('memory-md-guard.mjs', {
      session_id: 'md-guard-6',
      tool_name: 'mcp__plugin_troth_troth-hashline__hashline_edit',
      tool_input: { file_path: pathMod2.join(os6.homedir(), '.claude/CLAUDE.md'), edits: [] }
    });
    assert.strictEqual(
      r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision, 'deny',
      'a hashline edit of the global CLAUDE.md must be denied like any other'
    );
  });

  test('cache-populate: PostToolUse stores Read tool_response so next probe hits', () => {
    const tmpFile = pathMod2.join(TMP_DATA, 'cache-popul-' + process.pid + '.txt');
    fsMod2.writeFileSync(tmpFile, 'hello cached world\n');

    // PostToolUse cache-populate
    const popOut = runHook('cache-populate.mjs', {
      session_id: 'cache-f-1',
      tool_name: 'Read',
      tool_input: { file_path: tmpFile },
      tool_response: 'hello cached world\n',
      cwd: TMP_DATA,
    });
    assert.deepStrictEqual(popOut, {}, 'cache-populate allows silently');

    // PreToolUse cache-probe for the same call should now inject additionalContext.
    // P0.4: hint injection is opt-in (env TROTH_CACHE_PROBE_HINTS=1) to
    // avoid pure waste in yolo mode where the model can't be redirected.
    // Enabled here to exercise the feature path the rest of this test asserts.
    process.env.TROTH_CACHE_PROBE_HINTS = '1';
    const probeOut = runHook('cache-probe.mjs', {
      session_id: 'cache-f-1',
      tool_name: 'Read',
      tool_input: { file_path: tmpFile },
      cwd: TMP_DATA,
    });
    delete process.env.TROTH_CACHE_PROBE_HINTS;
    assert.ok(probeOut.hookSpecificOutput, 'probe must emit hookSpecificOutput');
    assert.strictEqual(probeOut.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(
      (probeOut.hookSpecificOutput.additionalContext || '').includes('hello cached world'),
      'cached content must be injected as additionalContext'
    );
    try { fsMod2.unlinkSync(tmpFile); } catch (_) {}
  });

  test('cache-probe: misses on file whose content has changed since populate (hash busts)', () => {
    const tmpFile = pathMod2.join(TMP_DATA, 'cache-probe-bust-' + process.pid + '.txt');
    fsMod2.writeFileSync(tmpFile, 'v1\n');
    runHook('cache-populate.mjs', {
      session_id: 'cache-f-2', tool_name: 'Read',
      tool_input: { file_path: tmpFile }, tool_response: 'v1\n', cwd: TMP_DATA
    });
    // Mutate on disk.
    fsMod2.writeFileSync(tmpFile, 'v2-changed\n');
    const probeOut = runHook('cache-probe.mjs', {
      session_id: 'cache-f-2', tool_name: 'Read',
      tool_input: { file_path: tmpFile }, cwd: TMP_DATA
    });
    assert.deepStrictEqual(probeOut, {}, 'stale cache must miss — plain allow, no context');
    try { fsMod2.unlinkSync(tmpFile); } catch (_) {}
  });

  test('cache-populate: refuses to cache error tool_response', () => {
    const tmpFile = pathMod2.join(TMP_DATA, 'cache-err-' + process.pid + '.txt');
    fsMod2.writeFileSync(tmpFile, 'real content\n');
    runHook('cache-populate.mjs', {
      session_id: 'cache-f-3', tool_name: 'Read',
      tool_input: { file_path: tmpFile },
      tool_response: { is_error: true, error: 'permission denied' },
      cwd: TMP_DATA
    });
    const probeOut = runHook('cache-probe.mjs', {
      session_id: 'cache-f-3', tool_name: 'Read',
      tool_input: { file_path: tmpFile }, cwd: TMP_DATA
    });
    assert.deepStrictEqual(probeOut, {}, 'error response never cached → probe miss');
    try { fsMod2.unlinkSync(tmpFile); } catch (_) {}
  });

  // ── troth-cache MCP server (Phase G — hard serve) ────────────────────
  test('MCP cache server: cached_read misses cold, hits warm, busts on edit', () => {
    const McpFile = pathMod2.join(PLUGIN, 'mcp-servers', 'troth-cache', 'server.mjs');
    const tmpFile = pathMod2.join(TMP_DATA, 'mcp-read-' + process.pid + '.txt');
    fsMod2.writeFileSync(tmpFile, 'original content\n');

    // Drive the server with a 4-message JSON-RPC script.
    const script = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cached_read', arguments: { file_path: tmpFile } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cached_read', arguments: { file_path: tmpFile } } },
    ].map(m => JSON.stringify(m)).join('\n') + '\n';

    const out = childProcess.execFileSync('node', [McpFile], {
      input: script,
      env: Object.assign({}, process.env, {
        CLAUDE_PLUGIN_ROOT: PLUGIN,
        CLAUDE_PLUGIN_DATA: TMP_DATA
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    const lines = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const byId = Object.fromEntries(lines.map(m => [m.id, m]));

    assert.strictEqual(byId[1].result.serverInfo.name, 'troth-cache');
    const toolNames = byId[2].result.tools.map(t => t.name);
    assert.deepStrictEqual(toolNames, ['cached_read', 'cached_grep']);

    // The session's first result may lead with the one-shot [troth] greeting
    // block; the payload is whichever content block parses as JSON.
    const jsonBlock = (res) => {
      for (const c of res.content) { try { return JSON.parse(c.text); } catch (_) {} }
      throw new Error('no JSON content block in: ' + JSON.stringify(res.content).slice(0, 120));
    };
    const first = jsonBlock(byId[3].result);
    assert.strictEqual(first.cached, false, 'cold read must miss');
    assert.strictEqual(first.source, 'fs');
    assert.strictEqual(first.content, 'original content\n');

    const second = jsonBlock(byId[4].result);
    assert.strictEqual(second.cached, true, 'warm read must hit cache');
    assert.strictEqual(second.source, 'troth-cache');
    assert.strictEqual(second.content, 'original content\n');

    // File-hash bust: mutate disk, then a third call must miss again.
    fsMod2.writeFileSync(tmpFile, 'edited content\n');
    const script2 = JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'cached_read', arguments: { file_path: tmpFile } }
    }) + '\n';
    const out2 = childProcess.execFileSync('node', [McpFile], {
      input: script2,
      env: Object.assign({}, process.env, {
        CLAUDE_PLUGIN_ROOT: PLUGIN,
        CLAUDE_PLUGIN_DATA: TMP_DATA
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    const third = jsonBlock(JSON.parse(out2.trim()).result);
    assert.strictEqual(third.cached, false, 'post-edit read must miss (file hash changed)');
    assert.strictEqual(third.content, 'edited content\n');

    try { fsMod2.unlinkSync(tmpFile); } catch (_) {}
  });

  test('MCP cache server: cached_read rejects missing file_path', () => {
    const McpFile = pathMod2.join(PLUGIN, 'mcp-servers', 'troth-cache', 'server.mjs');
    const script = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cached_read', arguments: {} }
    }) + '\n';
    const out = childProcess.execFileSync('node', [McpFile], {
      input: script,
      env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: TMP_DATA }),
      encoding: 'utf8', timeout: 3000,
    });
    const msg = JSON.parse(out.trim());
    assert.ok(msg.error, 'missing file_path must return a JSON-RPC error');
    assert.strictEqual(msg.error.code, -32602);
  });

  // ── The read wall stands on every road ───────────────────────────────
  //
  // path-policy decides what may be read: key material, credential files,
  // the substrate database. A retrieval tool that skips it is a way around
  // the wall, and these two are the tools the servers tell the model to
  // PREFER over the native Read.
  function driveMcp(serverRel, call) {
    const McpFile = pathMod2.join(PLUGIN, 'mcp-servers', serverRel, 'server.mjs');
    const script = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: call }
    ].map(m => JSON.stringify(m)).join('\n') + '\n';
    const out = childProcess.execFileSync('node', [McpFile], {
      input: script,
      env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: TMP_DATA }),
      encoding: 'utf8', timeout: 8000,
    });
    return out.trim().split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean).find(m => m.id === 2);
  }

  test('WALL-1: cached_read refuses a credential file and says why', () => {
    const dir = pathMod2.join(TMP_DATA, 'wall-' + process.pid);
    fsMod2.mkdirSync(dir, { recursive: true });
    const secretish = pathMod2.join(dir, '.env');
    fsMod2.writeFileSync(secretish, 'DECOY_TOKEN=not-a-real-secret\n');
    const msg = driveMcp('troth-cache', { name: 'cached_read', arguments: { file_path: secretish } });
    assert.ok(msg && msg.error, 'a refused read is an error, not content');
    assert.ok(/blocked_secret_read/.test(JSON.stringify(msg.error)), JSON.stringify(msg.error).slice(0, 160));
    assert.ok(!/not-a-real-secret/.test(JSON.stringify(msg)), 'the value must not appear anywhere in the reply');
    try { fsMod2.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test('WALL-2: cached_grep withholds matches from files the policy refuses', () => {
    const dir = pathMod2.join(TMP_DATA, 'wall2-' + process.pid);
    fsMod2.mkdirSync(dir, { recursive: true });
    fsMod2.writeFileSync(pathMod2.join(dir, '.env'), 'DECOY_TOKEN=not-a-real-secret\n');
    fsMod2.writeFileSync(pathMod2.join(dir, 'normal.txt'), 'ordinary line mentioning DECOY_TOKEN\n');
    const msg = driveMcp('troth-cache', { name: 'cached_grep', arguments: { pattern: 'DECOY_TOKEN', path: dir } });
    const blob = JSON.stringify(msg);
    assert.ok(!/not-a-real-secret/.test(blob), 'the credential line must be withheld');
    assert.ok(/ordinary line mentioning/.test(blob), 'the ordinary match still comes back');
    assert.ok(/withheld/.test(blob), 'and the withholding is stated, not silent');
    try { fsMod2.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test('WALL-3: hashline_read refuses a credential file', () => {
    const dir = pathMod2.join(TMP_DATA, 'wall3-' + process.pid);
    fsMod2.mkdirSync(dir, { recursive: true });
    const secretish = pathMod2.join(dir, '.env');
    fsMod2.writeFileSync(secretish, 'DECOY_TOKEN=not-a-real-secret\n');
    const msg = driveMcp('troth-hashline', { name: 'hashline_read', arguments: { file_path: secretish } });
    const blob = JSON.stringify(msg);
    assert.ok(/blocked_secret_read/.test(blob), blob.slice(0, 200));
    assert.ok(!/not-a-real-secret/.test(blob), 'the value must not appear anywhere in the reply');
    try { fsMod2.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test('WALL-4: an ordinary file still reads through both roads', () => {
    const dir = pathMod2.join(TMP_DATA, 'wall4-' + process.pid);
    fsMod2.mkdirSync(dir, { recursive: true });
    const ok = pathMod2.join(dir, 'notes.txt');
    fsMod2.writeFileSync(ok, 'plain content\n');
    const a = driveMcp('troth-cache', { name: 'cached_read', arguments: { file_path: ok } });
    const b = driveMcp('troth-hashline', { name: 'hashline_read', arguments: { file_path: ok } });
    assert.ok(/plain content/.test(JSON.stringify(a)), 'cached_read still serves ordinary files');
    assert.ok(/plain content/.test(JSON.stringify(b)), 'hashline_read still serves ordinary files');
    try { fsMod2.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test('cache-populate: skips uncacheable Edit tool entirely', () => {
    const out = runHook('cache-populate.mjs', {
      session_id: 'cache-f-4', tool_name: 'Edit',
      tool_input: { file_path: '/tmp/anything.js', old_string: 'a', new_string: 'b' },
      tool_response: 'ok', cwd: TMP_DATA
    });
    assert.deepStrictEqual(out, {}, 'Edit is uncacheable — bare allow, no store');
  });

  try { fsMod2.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
})();

// --- PROXY ↔ PLUGIN COEXISTENCE (behavior) ---
console.log('\nProxy ↔ plugin coexistence (behavior):');
(function runCoexistenceTests() {
  const proxyInjector = require('../proxy/modules/injector');
  const proxyCritic   = require('../proxy/modules/critic');

  test('proxy injector runs normally with coexistence OFF (default)', () => {
    delete process.env.TROTH_COEXISTENCE;
    const body = JSON.stringify({
      model: 'qwen3-max',
      messages: [{ role: 'user', content: 'hello' }]
    });
    const out = proxyInjector.inject(body, null);
    // Default behaviour: returns the transformed body (shape is an object
    // with the injected system block). What matters for the coexistence
    // test is that it's NOT equal to the original string.
    assert.ok(out, 'should return something');
    assert.notStrictEqual(out, body, 'proxy injector should modify, not pass through');
  });

  test('proxy injector skips when TROTH_COEXISTENCE=1 (plugin in charge)', () => {
    process.env.TROTH_COEXISTENCE = '1';
    // Make sure state.db shows the plugin as active by firing a fake event.
    const state = require('../shared-core/state.js');
    state.recordHookEvent({ event: 'coexistence-test', session_id: 'coex-1' });

    const body = JSON.stringify({
      model: 'qwen3-max',
      messages: [{ role: 'user', content: 'hello' }]
    });
    const out = proxyInjector.inject(body, null);
    assert.strictEqual(out, body, 'proxy must pass through unchanged when plugin is active');
    delete process.env.TROTH_COEXISTENCE;
  });

  test('proxy critic returns null when coexistence ON + plugin active', () => {
    process.env.TROTH_COEXISTENCE = '1';
    const state = require('../shared-core/state.js');
    state.recordHookEvent({ event: 'coex-critic', session_id: 'coex-2' });

    const responseBody = JSON.stringify({
      content: [{ type: 'text', text: 'some real completion with details' }]
    });
    const out = proxyCritic.criticize(responseBody);
    assert.strictEqual(out, null, 'critic must no-op when plugin is active');
    delete process.env.TROTH_COEXISTENCE;
  });
})();

// --- CRITIC ↔ REFLEXION LOOP (behavior) ---
console.log('\nCritic ↔ Reflexion loop (behavior):');
(function runLoopTests() {
  const childP = require('child_process');
  const pMod = require('path');
  const fMod = require('fs');
  const REPO = pMod.resolve(__dirname, '..');
  const PLUGIN = pMod.join(REPO, 'plugin');
  const TMP = pMod.join(REPO, '.tmp-loop-state');
  if (fMod.existsSync(TMP)) fMod.rmSync(TMP, { recursive: true, force: true });
  fMod.mkdirSync(TMP, { recursive: true });

  function runHook(script, payload) {
    const out = childP.execFileSync(
      'node',
      [pMod.join(PLUGIN, 'hooks', script)],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function writeTranscript(session_id, text, toolCalls) {
    const p = pMod.join(TMP, session_id + '.jsonl');
    const lines = [];
    for (let i = 0; i < toolCalls; i++) {
      lines.push(JSON.stringify({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] }));
    }
    lines.push(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text }] }));
    fMod.writeFileSync(p, lines.join('\n'));
    return p;
  }

  test('errortax failure records a lesson, next injector surfaces it', () => {
    const session_id = 'loop-errortax-1';
    // 1) Trigger errortax hook on a simulated tool failure.
    const errOut = runHook('errortax.mjs', {
      session_id,
      tool_name: 'Bash',
      tool_response: {
        is_error: true,
        content: "ENOENT: no such file or directory, open 'missing.ts'"
      }
    });
    assert.ok(errOut.hookSpecificOutput, 'errortax should inject recovery context');
    // 2) Next UserPromptSubmit — injector pulls the errortax lesson.
    const injOut = runHook('injector.mjs', {
      session_id,
      cwd: REPO,
      user_prompt: 'try again'
    });
    const ctx = (injOut.hookSpecificOutput && injOut.hookSpecificOutput.additionalContext) || '';
    assert.ok(ctx.includes('[troth/lessons]'), 'lesson block present');
    assert.ok(ctx.includes('file_not_found') || ctx.includes('ENOENT') || ctx.includes('Recovery:'),
      'lesson mentions the errortax recovery hint');
  });

  // A hook that speaks every turn only says what it can attest. A recall
  // result is answer text and may contain the vocabulary of failure without
  // being one; reported as a failed call it becomes precedent the model
  // carries for days.
  test('errortax stays silent when the call succeeded and only the prose sounds bad', () => {
    const out = runHook('errortax.mjs', {
      session_id: 'errortax-truth-1',
      cwd: REPO,
      tool_name: 'mcp__troth-substrate__troth_recall',
      tool_input: { query: 'open repo' },
      tool_response: {
        content: 'every component presented as an organ toward that destination; the repo exists and is private'
      }
    });
    const ctx = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ctx.includes('[troth/errortax]'),
      'a successful call must never be reported as failed; got ' + JSON.stringify(ctx.slice(0, 160)));
  });

  // The goal line exists to carry an EARLIER commitment forward. When intent
  // capture falls back to the prompt itself (language-agnostic capture), the
  // line renders as "Working on: <what you just typed>" — noise the model
  // already has, at the top of every turn.
  test('the goal line is not the prompt echoed back', () => {
    const session_id = 'goal-echo-1';
    const prompt = 'bro prepei na doume pos tha ftiaxoume ta issues sto proion xoris malakies';
    runHook('intent-capture.mjs', { session_id, cwd: REPO, user_prompt: prompt });
    const injOut = runHook('injector.mjs', { session_id, cwd: REPO, user_prompt: prompt });
    const ctx = (injOut.hookSpecificOutput && injOut.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ctx.includes('[troth/goal] Working on: ' + prompt.slice(0, 40)),
      'the fallback goal must not be spoken back; got ' + JSON.stringify(ctx.slice(0, 200)));
  });

  test('loopbreaker block records a lesson, next injector surfaces it', () => {
    const session_id = 'loop-lb-1';
    const call = { session_id, tool_name: 'Bash', tool_input: { command: 'false' } };
    // Fire LoopBreaker 5 times to trigger the deny branch.
    for (let i = 0; i < 5; i++) runHook('loopbreaker.mjs', call);

    const injOut = runHook('injector.mjs', {
      session_id,
      cwd: REPO,
      user_prompt: 'ok retry'
    });
    const ctx = (injOut.hookSpecificOutput && injOut.hookSpecificOutput.additionalContext) || '';
    assert.ok(ctx.includes('[troth/lessons]'), 'lesson block present');
    assert.ok(
      ctx.includes('loopbreaker') || ctx.includes('blocked after repeating') || ctx.includes('change approach'),
      'lesson references the loop break'
    );
  });

  test('critic block records a lesson, next injector surfaces it', () => {
    const session_id = 'loop-test-1';
    const transcriptPath = writeTranscript(session_id, 'Let me now check and fix that.', 0);

    // 1) Critic blocks the turn (promise-without-delivery).
    // Stop-hook schema (CC 2.1.x): decision + reason are TOP-LEVEL,
    // not nested under hookSpecificOutput.
    const criticOut = runHook('critic.mjs', {
      session_id, transcript_path: transcriptPath, stop_hook_active: false
    });
    assert.strictEqual(criticOut.decision, 'block', 'critic must return decision=block at top level');
    assert.ok(criticOut.reason, 'critic must include a reason');

    // 2) Next UserPromptSubmit — injector should find the lesson.
    const injOut = runHook('injector.mjs', {
      session_id,
      cwd: REPO,
      user_prompt: 'try again'
    });
    assert.ok(injOut.hookSpecificOutput, 'injector should emit context');
    const ctx = injOut.hookSpecificOutput.additionalContext || '';
    assert.ok(ctx.includes('[troth/lessons]'), 'lesson block must appear');
    assert.ok(ctx.includes('blocked by the critic'), 'lesson must name the failure');

    // 3) Second UserPromptSubmit — lesson was consumed, should NOT re-appear.
    const inj2 = runHook('injector.mjs', {
      session_id,
      cwd: REPO,
      user_prompt: 'anything else'
    });
    const ctx2 = (inj2.hookSpecificOutput && inj2.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ctx2.includes('[troth/lessons]'), 'consumed lesson must not re-inject');
  });

  test('CROSS-SESSION — lesson from session A surfaces in session B, same cwd', () => {
    const sessA = 'x-sess-A-' + Date.now();
    const sessB = 'x-sess-B-' + Date.now();

    // Session A: critic block records a lesson.
    const transcriptA = writeTranscript(sessA, 'Let me check and fix that.', 0);
    const criticOut = runHook('critic.mjs', {
      session_id: sessA, cwd: REPO, transcript_path: transcriptA, stop_hook_active: false
    });
    assert.strictEqual(criticOut.decision, 'block', 'session A must block (top-level decision per Stop-hook schema)');

    // Session B: different session_id, same cwd. Injector must surface
    // the cross-session lesson. This is the claim that was broken
    // before lessons were scoped to a single session_id.
    const injOut = runHook('injector.mjs', {
      session_id: sessB,
      cwd: REPO,
      user_prompt: 'starting fresh session, continue'
    });
    const ctx = (injOut.hookSpecificOutput && injOut.hookSpecificOutput.additionalContext) || '';
    assert.ok(ctx.includes('[troth/lessons]'),
      'cross-session lesson MUST surface in new session under same cwd');
    assert.ok(ctx.includes('blocked by the critic'),
      'cross-session lesson must carry the critic failure reason');
  });

  test('CROSS-SESSION — different cwd does NOT leak lessons', () => {
    const sessA = 'x-leak-A-' + Date.now();
    const sessB = 'x-leak-B-' + Date.now();
    const otherCwd = REPO + '/benchmarks';  // different project tree

    const transcriptA = writeTranscript(sessA, 'Let me investigate and address that.', 0);
    runHook('critic.mjs', {
      session_id: sessA, cwd: REPO, transcript_path: transcriptA, stop_hook_active: false
    });

    const injOut = runHook('injector.mjs', {
      session_id: sessB,
      cwd: otherCwd,
      user_prompt: 'unrelated project'
    });
    const ctx = (injOut.hookSpecificOutput && injOut.hookSpecificOutput.additionalContext) || '';
    // Even if a [troth/lessons] block appears for other reasons, it
    // must NOT contain session A's critic failure.
    assert.ok(!ctx.includes('blocked by the critic'),
      'lesson must NOT leak across projects (different cwd)');
  });

  test('P14: per-turn injector surfaces fresh insight_surfaced once, then suppresses on repeat', () => {
    const sessId = 'p14-' + Date.now();
    const cwdP14 = REPO;

    // Reload state with our test data dir so we can seed an insight.
    process.env.CLAUDE_PLUGIN_DATA = TMP;
    delete require.cache[require.resolve('../shared-core/state')];
    const state    = require('../shared-core/state');
    const ar       = require('../shared-core/action-record');
    const surfacer = require('../shared-core/insight-surfacer');

    // Seed a high-priority insight via the official surfacer path so the
    // shape matches production exactly. Source event = a synthesized
    // contradiction-flagged tool_call.
    const sourceEvent = {
      type: 'tool_call',
      input: { tool_name: 'background_worker.contradiction_flagged', args: { a: 'x', b: 'y' } },
      output: { status: 'flagged' }
    };
    const r = surfacer.recordInsight({
      agent_id: 'test-collab',
      cwd: cwdP14,
      source_event: sourceEvent,
      summary: 'P14-test-marker: contradiction between two active commitments — review',
      reason: 'p14_test_seed'
    });
    assert.ok(r.ok, 'surfacer.recordInsight must succeed; got: ' + JSON.stringify(r));
    assert.ok(r.priority >= 0.7, 'seeded insight must clear the 0.7 threshold (got ' + r.priority + ')');

    // Run injector — must surface the seeded insight on first turn.
    const inj1 = runHook('injector.mjs', {
      session_id: sessId,
      cwd: cwdP14,
      user_prompt: 'fix the bug in src/server.js where it errors on missing file'
    });
    const ctx1 = (inj1.hookSpecificOutput && inj1.hookSpecificOutput.additionalContext) || '';
    assert.ok(ctx1.includes('[troth/insight]'),
      'first turn must surface fresh insight; got: ' + ctx1.slice(0, 400));
    assert.ok(ctx1.includes('P14-test-marker'),
      'surfaced insight must carry the seeded summary');

    // Run injector again — must NOT re-surface (delivery record was written).
    const inj2 = runHook('injector.mjs', {
      session_id: sessId,
      cwd: cwdP14,
      user_prompt: 'continue working on the same file at src/server.js'
    });
    const ctx2 = (inj2.hookSpecificOutput && inj2.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ctx2.includes('P14-test-marker'),
      'second turn must NOT re-surface the same insight; got: ' + ctx2.slice(0, 400));
  });

  // plugin parity. Verifies the Phase G
  // pre-action-recall hook + the new injector continuity block ship the
  // same substrate-as-entity envelope on the Claude Code surface that
  // the entity daemon already had. Uses the same TMP CLAUDE_PLUGIN_DATA
  // dir as other injector tests; engrams seeded via fresh-required
  // shared-core modules so they land in the test's isolated state.db.
  test('AC-PLUGIN-1: pre-action-recall surfaces prior context for Read on a known file', () => {
    process.env.CLAUDE_PLUGIN_DATA = TMP;
    for (const k of Object.keys(require.cache)) {
      if (k.indexOf('/shared-core/') >= 0) delete require.cache[k];
    }
    const eng = require('../shared-core/engram');
    const cwdAC = pMod.join(TMP, 'ac-plugin-1');
    fMod.mkdirSync(cwdAC, { recursive: true });
    // autonomous step: seed at llm_inferred tier rather than
    // operator_confirmed. This test exercises pre-action-recall's recall
    // mechanism, not the integration point signature wall. Recall returns engrams
    // regardless of tier; using llm_inferred avoids coupling this test
    // to the operator-key signing path (which has its own coverage in
    // internal step).
    eng.recordEngram({
      agent_id: 'ac-plugin-1', cwd: cwdAC,
      statement: 'we use AC-PLUGIN-1-UNIQUE-TOKEN for schema validation in users.ts',
      scope: 'decision:validation', source_authority: 'llm_inferred'
    });
    const out = runHook('pre-action-recall.mjs', {
      hook_event_name: 'PreToolUse',
      session_id: 'ac-plugin-1-sess',
      cwd: cwdAC,
      tool_name: 'Read',
      tool_input: { file_path: pMod.join(cwdAC, 'users.ts') }
    });
    const ctx = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(out.hookSpecificOutput && out.hookSpecificOutput.hookEventName === 'PreToolUse',
      'pre-action-recall must emit PreToolUse-shaped response; got: ' + JSON.stringify(out));
    assert.ok(ctx.includes('[troth/prior_context]'),
      'must surface prior-context block; got: ' + ctx.slice(0, 200));
    assert.ok(ctx.includes('AC-PLUGIN-1-UNIQUE-TOKEN'),
      'must surface the seeded decision; got: ' + ctx.slice(0, 300));
  });

  test('AC-PLUGIN-2: pre-action-recall skips Bash (substrate-native skip list)', () => {
    const out = runHook('pre-action-recall.mjs', {
      hook_event_name: 'PreToolUse',
      session_id: 'ac-plugin-2-sess',
      cwd: pMod.join(TMP, 'ac-plugin-2'),
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    });
    // Hook either emits nothing (default allow) or emits hookSpecificOutput
    // without additionalContext. Either way, no [troth/prior_context]
    // payload because Bash is in the skip list.
    const ctx = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(!ctx.includes('[troth/prior_context]'),
      'Bash must NOT trigger pre-action context; got: ' + ctx.slice(0, 200));
  });

  test('AC-PLUGIN-3: injector continuity block surfaces project-scoped decisions + focus + handoff with lineage', () => {
    process.env.CLAUDE_PLUGIN_DATA = TMP;
    for (const k of Object.keys(require.cache)) {
      if (k.indexOf('/shared-core/') >= 0) delete require.cache[k];
    }
    const eng = require('../shared-core/engram');
    const st  = require('../shared-core/state');
    // Force project_id deterministically by writing a.troth/project.json
    // override so cwd basename doesn't drift across test runs.
    const cwdAC = pMod.join(TMP, 'ac-plugin-3');
    fMod.mkdirSync(pMod.join(cwdAC, '.troth'), { recursive: true });
    fMod.writeFileSync(pMod.join(cwdAC, '.troth', 'project.json'),
      JSON.stringify({ id: 'ac-plugin-3-proj' }));
    // Clear project-id cache so the new project.json is picked up.
    const pid = require('../shared-core/project-id');
    pid._clearCache();
    // Seed rationale -> decision edge so Phase H lineage renders.
    const ratId = eng.recordEngram({
      agent_id: 'ac-plugin-3', cwd: cwdAC,
      statement: 'AC-PLUGIN-3-RATIONALE: audit found plugin parity gap',
      scope: 'research:audit'
    });
    const decId = eng.recordEngram({
      agent_id: 'ac-plugin-3', cwd: cwdAC,
      statement: 'AC-PLUGIN-3-DECISION: ship continuity block to plugin',
      scope: 'decision:plugin-port'
    });
    st.recordEdge({ from_id: ratId, to_id: decId, label: 'rationalizes' });
    eng.recordEngram({
      agent_id: 'ac-plugin-3', cwd: cwdAC,
      statement: 'AC-PLUGIN-3-FOCUS: porting the continuity work to the plugin',
      scope: 'system:current_focus:ac-plugin-3-proj',
      audience: 'substrate_internal', source: 'background_worker.purpose_refresh'
    });
    eng.recordEngram({
      agent_id: 'ac-plugin-3', cwd: cwdAC,
      statement: 'AC-PLUGIN-3-HANDOFF: 6 gaps identified, shipping in parallel',
      scope: 'handoff:plugin-port', audience: 'substrate_internal'
    });
    const out = runHook('injector.mjs', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'ac-plugin-3-sess',
      cwd: cwdAC,
      user_prompt: 'where are we with the plugin port effort right now'
    });
    const ctx = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
    assert.ok(ctx.includes('[troth/continuity]'),
      'injector must emit [troth/continuity] block; got: ' + ctx.slice(0, 600));
    assert.ok(ctx.includes('project=ac-plugin-3-proj'),
      'continuity block must carry resolved project_id; got: ' + ctx.slice(0, 600));
    assert.ok(ctx.includes('AC-PLUGIN-3-DECISION'),
      'project-scoped decision must surface; got: ' + ctx.slice(0, 600));
    assert.ok(ctx.includes('AC-PLUGIN-3-RATIONALE'),
      'Phase H lineage must render the rationale; got: ' + ctx.slice(0, 600));
    assert.ok(ctx.includes('AC-PLUGIN-3-FOCUS'),
      'current focus must surface; got: ' + ctx.slice(0, 600));
    // The handoff must NOT be in the continuity block. It was removed from the
    // per-turn injector on  (see the note in plugin/hooks/injector.mjs
    // where compact_handoff used to be): a handoff is a resume artifact, true
    // only right after a compaction or an explicit resume, and serving it every
    // turn meant a fresh chat opened with the previous session's unfinished
    // work. session-start.mjs surfaces it at the moment it is true.
    //
    // This test kept asserting the old behaviour and passed by accident,
    // whenever the seeded handoff engram happened to score into the separate
    // recall block. That made it fail about two runs in three on a clean tree.
    // Assert against the continuity block specifically, which is what this
    // test is about.
    const continuityBlock = (ctx.split('[troth/continuity]')[1] || '').split('\n[troth/')[0];
    assert.ok(!continuityBlock.includes('AC-PLUGIN-3-HANDOFF'),
      'a handoff must not ride the per-turn continuity block; got: ' + continuityBlock.slice(0, 400));
  });

  try { fMod.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
})();

// --- ERRORTAX (behavior) ---
console.log('\nError taxonomy (behavior):');
(function runErrortaxTests() {
  const et = require('../shared-core/errortax-hook');

  test('classifies EACCES as permission_denied', () => {
    assert.strictEqual(et.classify("EACCES: permission denied, open '/foo'"), 'permission_denied');
  });
  test('classifies ENOENT as file_not_found', () => {
    assert.strictEqual(et.classify("ENOENT: no such file or directory, open 'missing'"), 'file_not_found');
  });
  test('classifies "command not found" as command_not_found', () => {
    assert.strictEqual(et.classify('/bin/bash: ripgrep: command not found'), 'command_not_found');
  });
  test('classifies Edit old_string failure', () => {
    assert.strictEqual(et.classify('Error: string to replace not found in file'), 'string_not_found');
  });
  test('classifies timeout', () => {
    assert.strictEqual(et.classify('Command timed out after 120 seconds'), 'timeout');
  });
  test('classifies non-zero exit', () => {
    assert.strictEqual(et.classify('Process exited with exit code 2'), 'nonzero_exit');
  });
  test('returns null diagnosis for clean output', () => {
    assert.strictEqual(et.diagnose('file1.js\nfile2.js\n'), null);
  });
  test('diagnose returns description + concrete recovery hint', () => {
    const d = et.diagnose('ENOENT: no such file');
    assert.strictEqual(d.class, 'file_not_found');
    assert.ok(d.recovery.includes('Glob'));
  });
})();

// --- CRITIC (behavior) ---
console.log('\nCritic (behavior):');
(function runCriticTests() {
  const critic = require('../shared-core/critic');

  test('review passes clean completion', () => {
    const r = critic.review('I added the getUser function to src/users.ts and verified the test passes.', { toolCallsInTurn: 2 });
    assert.strictEqual(r.ok, true);
  });

  test('review blocks a refusal pattern', () => {
    const r = critic.review('Unfortunately, I cannot complete this task.', { toolCallsInTurn: 0 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reasons.join(' ').includes('refusal'));
  });

  test('review blocks "let me..." with no tool calls', () => {
    const r = critic.review('Let me now read the file and fix the bug.', { toolCallsInTurn: 0 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reasons.join(' ').includes('promise'));
  });

  test('review passes "let me..." when a tool was actually called', () => {
    const r = critic.review('Let me read the file first. Done — the issue was on line 42.', { toolCallsInTurn: 1 });
    assert.strictEqual(r.ok, true);
  });

  test('review blocks placeholder TODO content', () => {
    const r = critic.review('Here is the function:\n\n```js\nfunction foo() {\n  // TODO: implement this\n}\n```', { toolCallsInTurn: 1 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reasons.join(' ').includes('placeholder'));
  });

  test('review passes a question-mark clarification', () => {
    const r = critic.review('Which directory should the output go in?', { toolCallsInTurn: 0 });
    assert.strictEqual(r.ok, true);
  });
})();

// --- TASK TIER CLASSIFIER (behavior) ---
console.log('\nTask tier classifier (behavior):');
(function runTaskTierTests() {
  const tt = require('../shared-core/task-tier');

  test('classifies /hard slash command as hard', () => {
    const r = tt.classify({ messages: [{ role: 'user', content: '/hard design the auth system' }] });
    assert.strictEqual(r.tier, 'hard');
  });
  test('classifies "design the system" as hard', () => {
    const r = tt.classify({ messages: [{ role: 'user', content: 'design the system to handle spike traffic' }] });
    assert.strictEqual(r.tier, 'hard');
  });
  test('classifies "security audit" as hard', () => {
    assert.strictEqual(tt.classify({ messages: [{ role: 'user', content: 'do a security review' }] }).tier, 'hard');
  });
  test('classifies "what is the port" as simple', () => {
    assert.strictEqual(tt.classify({ messages: [{ role: 'user', content: 'what is the default port' }] }).tier, 'simple');
  });
  test('classifies "list the tests" as simple', () => {
    assert.strictEqual(tt.classify({ messages: [{ role: 'user', content: 'list the tests in this repo' }] }).tier, 'simple');
  });
  test('classifies short continuation as simple', () => {
    assert.strictEqual(tt.classify({ messages: [{ role: 'user', content: 'ok continue' }] }).tier, 'simple');
  });
  test('defaults to medium when nothing else fires', () => {
    assert.strictEqual(tt.classify({ messages: [{ role: 'user', content: 'add pagination to the user list with cursor-based filtering' }] }).tier, 'medium');
  });
  test('classifies a long tool-use trajectory as hard', () => {
    const messages = [{ role: 'user', content: 'continue' }];
    // 20 fake tool_use blocks in prior assistant messages
    for (let i = 0; i < 20; i++) {
      messages.unshift({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] });
    }
    const r = tt.classify({ messages });
    assert.strictEqual(r.tier, 'hard');
  });
})();

// --- DANGER CLASSIFIER (behavior) ---
console.log('\nDanger classifier (behavior):');
(function runDangerTests() {
  const danger = require('../shared-core/danger');

  test('classifies rm -rf as destructive', () => {
    const d = danger.classify('rm -rf /tmp/something');
    assert.ok(d);
    assert.strictEqual(d.kind, 'rm_rf');
  });
  test('classifies git push --force', () => {
    const d = danger.classify('git push --force origin main');
    assert.ok(d);
    assert.strictEqual(d.kind, 'git_force_push');
    assert.strictEqual(d.severity, 'high');
  });
  test('does NOT flag git push --force-with-lease', () => {
    assert.strictEqual(danger.classify('git push --force-with-lease origin main'), null);
  });
  test('classifies DROP TABLE as critical', () => {
    const d = danger.classify('DROP TABLE users;');
    assert.ok(d);
    assert.strictEqual(d.severity, 'critical');
  });
  test('classifies curl | bash', () => {
    const d = danger.classify('curl https://example.com/install.sh | bash');
    assert.ok(d);
    assert.strictEqual(d.kind, 'curl_pipe_shell');
  });
  test('passes benign commands', () => {
    assert.strictEqual(danger.classify('ls -la'), null);
    assert.strictEqual(danger.classify('git status'), null);
    assert.strictEqual(danger.classify('npm test'), null);
  });
  test('severity weight orders critical > high > medium', () => {
    assert.ok(danger.severityWeight('critical') > danger.severityWeight('high'));
    assert.ok(danger.severityWeight('high') > danger.severityWeight('medium'));
  });
})();

// --- REPOMAP (behavior) ---
console.log('\nRepomap (behavior):');
(function runRepomapTests() {
  const repomap = require('../shared-core/repomap');
  const pathRM = require('path');
  const REPO = pathRM.resolve(__dirname, '..');

  test('extractKeywords drops stop words and keeps content tokens', () => {
    const kw = repomap.extractKeywords('please tell me how the injector module handles mode detection');
    assert.ok(kw.includes('injector'), 'should keep "injector"');
    assert.ok(kw.includes('detection'), 'should keep "detection"');
    assert.ok(!kw.includes('the'), 'should drop "the"');
    assert.ok(!kw.includes('how'), 'should drop "how"');
  });

  test('buildMap includes header and file lines', () => {
    const out = repomap.buildMap(REPO, 'how does the injector work', { maxFiles: 5 });
    assert.ok(out, 'should produce a map');
    assert.ok(out.startsWith('[troth/repomap]'), 'header present');
    assert.ok(out.includes('injector'), 'injector-related files should float to top via keyword boost');
  });

  test('buildMap respects character budget', () => {
    const out = repomap.buildMap(REPO, 'test', { maxFiles: 100, maxChars: 300 });
    assert.ok(out.length <= 300 + 80, 'stays near the configured budget');
  });

  test('scoreFile boosts src/ over tests', () => {
    const src = repomap.scoreFile('src/main.ts', []);
    const test = repomap.scoreFile('tests/main.test.ts', []);
    assert.ok(src > test, 'src should outrank test');
  });

  test('keyword presence boosts matching file', () => {
    const withKw = repomap.scoreFile('src/auth-service.ts', ['auth']);
    const withoutKw = repomap.scoreFile('src/auth-service.ts', []);
    assert.ok(withKw > withoutKw * 5, 'keyword should multiply score by ~10');
  });

  test('extractImports finds ESM + CJS + dynamic + python', () => {
    const text = [
      "import X from './foo';",
      "import { Y } from \"./bar\";",
      "const z = require('./baz');",
      "const w = await import('./qux');",
      "from src.util import helper",
      "import src.things"
    ].join('\n');
    const got = new Set(repomap.extractImports(text));
    assert.ok(got.has('./foo'));
    assert.ok(got.has('./bar'));
    assert.ok(got.has('./baz'));
    assert.ok(got.has('./qux'));
    assert.ok(got.has('src.util') || got.has('src.things'), 'at least one python import');
  });

  test('pagerank elevates nodes with many inbound edges vs isolated nodes', () => {
    // Graph:  a→b, c→b, d→b   (b is a hub),   z isolated (no edges).
    // Hub b should rank well above isolated z.
    const graph = {
      nodes: ['a', 'b', 'c', 'd', 'z'],
      adj: new Map([
        ['a', new Set(['b'])],
        ['b', new Set()],
        ['c', new Set(['b'])],
        ['d', new Set(['b'])],
        ['z', new Set()]
      ])
    };
    const rank = repomap.pagerank(graph, { iterations: 40 });
    assert.ok(rank.get('b') > rank.get('z'), 'hub b should outrank isolated z');
    assert.ok(rank.get('b') > rank.get('a'), 'hub b should outrank its upstream leaves');
  });

  test('pagerank personalization biases toward flagged nodes', () => {
    const graph = {
      nodes: ['a', 'b', 'c'],
      adj: new Map([
        ['a', new Set(['b'])],
        ['b', new Set(['c'])],
        ['c', new Set()]
      ])
    };
    const plain = repomap.pagerank(graph, { iterations: 40 });
    const personalized = repomap.pagerank(graph, {
      iterations: 40,
      personalization: new Map([['a', 10], ['b', 1], ['c', 1]])
    });
    assert.ok(personalized.get('a') > plain.get('a'), 'personalized start raises node a');
  });

  test('buildPagerankMap surfaces keyword-relevant hubs on real repo', () => {
    const out = repomap.buildPagerankMap(require('path').resolve(__dirname, '..'), 'injector', { maxFilesOut: 10 });
    assert.ok(out, 'should produce output');
    assert.ok(out.includes('injector'), 'injector-related files should appear');
    assert.ok(out.startsWith('[troth/repomap:pagerank]'));
  });
})();

// --- EDIT MATCHER (behavior) ---
console.log('\nEdit matcher (behavior):');
(function runEditMatchTests() {
  const em = require('../shared-core/editmatch');

  test('exactMatch passes through when content contains old_string', () => {
    const r = em.findMatch('abc\nfoo\nbar\n', 'foo');
    assert.strictEqual(r.strategy, 'exact');
    assert.strictEqual(r.exact, 'foo');
  });

  test('trimMatch rescues trailing-whitespace mismatches', () => {
    const content = 'function foo() {\n  return 42;\n}\n';
    const old_ = 'function foo() {\n  return 42;  \n}\n';  // trailing spaces
    const r = em.findMatch(content, old_);
    assert.ok(r, 'should match');
    assert.ok(['trim', 'collapse'].includes(r.strategy), 'trim or collapse path');
    assert.ok(content.includes(r.exact), 'returned exact must appear verbatim in content');
  });

  test('collapseMatch rescues multi-space vs single-space', () => {
    const content = 'if   (x == 1)   return;';
    const old_    = 'if (x == 1) return;';
    const r = em.findMatch(content, old_);
    assert.ok(r, 'should match');
    assert.ok(content.includes(r.exact));
  });

  test('anchorMatch rescues when one unique line is present', () => {
    const content =
      'const CONSTANT_A = 1;\n' +
      'const UNIQUE_FUNC = () => {\n' +
      '  return innerValue;\n' +
      '};\n' +
      'const CONSTANT_B = 2;\n';
    // Same anchor line, slightly different body
    const old_ =
      'const UNIQUE_FUNC = () => {\n' +
      '  return wrongValue;\n' +
      '};';
    const r = em.findMatch(content, old_);
    assert.ok(r, 'should find anchor');
    assert.strictEqual(r.strategy, 'anchor');
    assert.ok(content.includes(r.exact), 'returned exact must appear verbatim');
  });

  test('returns null when nothing matches closely', () => {
    assert.strictEqual(em.findMatch('a b c', 'totally unrelated content here'), null);
  });

  test('editmatcher hook prefers strategy whose post-edit AST parses clean', () => {
    const childE = require('child_process');
    const pE = require('path');
    const fE = require('fs');
    const REPO2 = pE.resolve(__dirname, '..');
    const PLUGIN2 = pE.join(REPO2, 'plugin');
    const tmp = pE.join(require('os').tmpdir(), 'troth-editmatch-sample.js');

    // File where trim-strategy rescue would put a dangling "{" inside a
    // function, breaking syntax. Anchor-strategy should find the whole
    // function block intact.
    fE.writeFileSync(tmp,
      'function first() {\n' +
      '  return 1;\n' +
      '}\n' +
      '\n' +
      'function second() {\n' +
      '  return 2;\n' +
      '}\n');

    // old_string with whitespace drift from `second` — trim-match would
    // anchor on one of the `return` lines and corrupt the replacement.
    const old_ =
      'function second() {\n' +
      '    return 2;\n' +
      '}';

    const out = childE.execFileSync(
      'node',
      [pE.join(PLUGIN2, 'hooks', 'editmatcher.mjs')],
      {
        input: JSON.stringify({
          session_id: 'em-ast-test',
          tool_name: 'Edit',
          tool_input: {
            file_path: tmp,
            old_string: old_,
            new_string: 'function second() {\n  return 22;\n}'
          }
        }),
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN2 }),
        encoding: 'utf8'
      }
    );
    const parsed = JSON.parse((out || '').trim() || '{}');
    assert.ok(parsed.hookSpecificOutput, 'should emit a decision');
    const ui = parsed.hookSpecificOutput.updatedInput || {};
    // Whatever strategy wins, applying it must produce valid JS.
    const original = fE.readFileSync(tmp, 'utf8');
    const asv = require('../shared-core/ast-validate');
    if (ui.old_string) {
      const post = asv.applyEdit(original, ui.old_string, 'function second() {\n  return 22;\n}');
      const check = asv.validate(tmp, post);
      assert.ok(check.ok || check.skipped, 'post-edit content must parse cleanly');
    }
    fE.unlinkSync(tmp);
  });

  test('MultiEdit hook runs each sub-edit through chooseStrategy', () => {
    const childE2 = require('child_process');
    const pE2 = require('path');
    const fE2 = require('fs');
    const REPO3 = pE2.resolve(__dirname, '..');
    const PLUGIN3 = pE2.join(REPO3, 'plugin');
    const tmp = pE2.join(require('os').tmpdir(), 'troth-editmatch-multi.js');
    fE2.writeFileSync(tmp,
      'function alpha() {\n  return 1;\n}\n\n' +
      'function beta() {\n  return 2;\n}\n\n' +
      'function gamma() {\n  return 3;\n}\n');

    const out = childE2.execFileSync(
      'node',
      [pE2.join(PLUGIN3, 'hooks', 'editmatcher.mjs')],
      {
        input: JSON.stringify({
          session_id: 'em-multi-ast',
          tool_name: 'MultiEdit',
          tool_input: {
            file_path: tmp,
            edits: [
              { old_string: 'function alpha() {\n    return 1;\n}', new_string: 'function alpha() {\n  return 11;\n}' },
              { old_string: 'function beta() {\n    return 2;\n}',  new_string: 'function beta() {\n  return 22;\n}' }
            ]
          }
        }),
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN3 }),
        encoding: 'utf8'
      }
    );
    const parsed = JSON.parse((out || '').trim() || '{}');
    assert.ok(parsed.hookSpecificOutput, 'MultiEdit path must emit a decision');
    const ui = parsed.hookSpecificOutput.updatedInput || {};
    const reason = parsed.hookSpecificOutput.permissionDecisionReason || '';
    // Either fuzzy-rescued edits are present, or every edit was already
    // exact. In BOTH cases the result must apply to yield clean AST.
    const asv2 = require('../shared-core/ast-validate');
    let rolling = fE2.readFileSync(tmp, 'utf8');
    const final = (ui.edits || []);
    for (const e of final) {
      if (!e || typeof e.old_string !== 'string') continue;
      if (!rolling.includes(e.old_string)) continue;
      rolling = rolling.replace(e.old_string, e.new_string || '');
    }
    const check = asv2.validate(tmp, rolling);
    assert.ok(check.ok || check.skipped,
      'after MultiEdit rescue, rolling content must parse cleanly: ' + (check.errors || ''));
    fE2.unlinkSync(tmp);
  });
})();

// --- INJECTOR (behavior) ---
console.log('\nInjector (behavior):');
(function runInjectorTests() {
  const injector = require('../shared-core/injector');

  test('detectMode maps debugging keywords to "debugging"', () => {
    assert.strictEqual(injector.detectMode('fix this TypeError crash'), 'debugging');
    assert.strictEqual(injector.detectMode('why is my tests failing'), 'debugging');
  });
  test('detectMode maps testing keywords to "testing"', () => {
    assert.strictEqual(injector.detectMode('write a jest unit test for this'), 'testing');
  });
  test('detectMode maps refactoring keywords to "refactoring"', () => {
    assert.strictEqual(injector.detectMode('refactor this into a hook'), 'refactoring');
  });
  test('detectMode default is feature', () => {
    assert.strictEqual(injector.detectMode('add a new endpoint'), 'feature');
  });
  test('detectProject finds node + typescript from package.json + tsconfig', () => {
    const p = injector.detectProject(require('path').resolve(__dirname, '..'));
    assert.ok(p.hints.includes('node'), 'should detect node');
  });
  test('buildContext returns a compact additionalContext block', () => {
    const out = injector.buildContext(require('path').resolve(__dirname, '..'), 'fix this bug in the parser');
    assert.ok(out.context.startsWith('[troth/context]'));
    assert.ok(out.context.includes('Mode: debugging'));
    assert.ok(out.context.length < 600, 'should stay small');
  });

  test('shouldSuggestArchive fires on "previous grep" / "that result" / "earlier output"', () => {
    assert.ok(injector.shouldSuggestArchive('can you re-check the previous grep for auth'));
    assert.ok(injector.shouldSuggestArchive('that grep result you ran earlier — where was foo defined?'));
    assert.ok(injector.shouldSuggestArchive('what was in the previous output'));
  });
  test('shouldSuggestArchive stays quiet on neutral prompts', () => {
    assert.strictEqual(injector.shouldSuggestArchive('write a test for getUser'), false);
    assert.strictEqual(injector.shouldSuggestArchive('add pagination to /api/users'), false);
  });
  test('buildContext includes archive hint when prompt references earlier data', () => {
    const out = injector.buildContext(require('path').resolve(__dirname, '..'),
      'remember that grep you ran earlier? show me the auth matches again');
    assert.ok(out.context.includes('[troth/archive]'), 'archive hint must appear');
    assert.ok(out.archiveSuggested === true, 'metadata flag should be set');
  });
})();

// --- AST VALIDATE (behavior) ---
console.log('\nAST validate (behavior):');
(function runAstValidateTests() {
  const astValidate = require('../shared-core/ast-validate');
  const childAV = require('child_process');
  const pAV = require('path');
  const fAV = require('fs');
  const REPO = pAV.resolve(__dirname, '..');
  const PLUGIN = pAV.join(REPO, 'plugin');

  test('validate() returns ok:true for syntactically valid JS', () => {
    const r = astValidate.validate('/tmp/x.js', 'function foo() { return 42; }');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.language, 'js');
  });

  test('validate() returns ok:false with row/column for broken JS', () => {
    const r = astValidate.validate('/tmp/x.js', 'function foo() { return ');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors && r.errors.length > 0, 'should list at least one error');
    assert.ok(r.errors[0].line >= 1, 'row should be 1-based');
  });

  test('validate() returns ok:true for valid TSX', () => {
    const r = astValidate.validate('/tmp/x.tsx', 'const X = <div>{count}</div>;');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.language, 'tsx');
  });

  test('validate() returns ok:true for valid Python, ok:false for broken', () => {
    assert.strictEqual(astValidate.validate('/tmp/a.py', 'def foo():\n    return 1\n').ok, true);
    const bad = astValidate.validate('/tmp/a.py', 'def foo(:\n    return 1\n');
    assert.strictEqual(bad.ok, false);
  });

  // The validator was blind above 32,768 bytes: tree-sitter's binding refuses
  // a string argument longer than that and throws, and a throw is treated as a
  // skip — which reads exactly like a pass. The four largest files in this
  // tree were therefore written without ever being parsed, and a stray brace
  // in one of them reached disk while the validator reported nothing.
  const BIG = (function () {
    let s = ''; while (s.length < 120000) s += 'const someValue = 1;\n'; return s;
  })();

  test('validate() parses a file far larger than the binding\'s string limit', () => {
    assert.strictEqual(BIG.length > 32768, true, 'the fixture is past the old boundary');
    const r = astValidate.validate('/tmp/big.js', BIG);
    assert.strictEqual(r.ok, true, 'a clean 120 KB file is clean, not skipped: ' + JSON.stringify(r));
    assert.strictEqual(r.skipped, undefined, 'and it is not quietly skipped');
  });

  test('validate() catches a broken construct past that limit, with a line number', () => {
    const r = astValidate.validate('/tmp/big.js', BIG + 'function broken( {\n');
    assert.strictEqual(r.ok, false, 'the error is found: ' + JSON.stringify(r));
    assert.ok(r.errors[0].line > 1000, 'and it is located, not merely reported: ' + r.errors[0].line);
  });

  test('validate() still answers identically on either side of the old boundary', () => {
    // 32,723 bytes parsed and 32,779 threw. Both must now behave the same way.
    const mk = (n) => { let s = ''; while (s.length < n) s += 'const a = 1;\n'; return s + 'function b( {\n'; };
    const under = astValidate.validate('/tmp/u.js', mk(32000));
    const over  = astValidate.validate('/tmp/o.js', mk(32800));
    assert.strictEqual(under.ok, false, 'below the boundary, caught');
    assert.strictEqual(over.ok, false, 'above it, caught too: ' + JSON.stringify(over));
    assert.strictEqual(over.language, under.language, 'same language, same answer shape');
  });

  test('validate() reads the largest real file in this tree rather than skipping it', () => {
    // The one that a silent skip actually cost something on.
    const big = pAV.join(REPO, 'proxy', 'server.js');
    const src = fAV.readFileSync(big, 'utf8');
    assert.ok(src.length > 200000, 'still the large one: ' + src.length);
    const r = astValidate.validate(big, src);
    assert.strictEqual(r.ok, true, 'the shipped file parses: ' + JSON.stringify(r).slice(0, 120));
    const nl = src.indexOf('\n', Math.floor(src.length * 0.6));
    const broken = src.slice(0, nl + 1) + '}\n' + src.slice(nl + 1);
    const rb = astValidate.validate(big, broken);
    assert.strictEqual(rb.ok, false, 'and one stray brace in it is caught');
  });

  test('validate() catches broken JSON', () => {
    assert.strictEqual(astValidate.validate('/tmp/a.json', '{"a": 1}').ok, true);
    const bad = astValidate.validate('/tmp/a.json', '{"a": 1,,}');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.language, 'json');
  });

  test('validate() skips unsupported extensions without crashing', () => {
    const r = astValidate.validate('/tmp/x.rs', 'fn main() {}');
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.reason, 'unsupported');
  });

  test('applyEdit substitutes once by default, and all with replace_all', () => {
    assert.strictEqual(astValidate.applyEdit('a b a', 'a', 'X'), 'X b a');
    assert.strictEqual(astValidate.applyEdit('a b a', 'a', 'X', true), 'X b X');
    assert.strictEqual(astValidate.applyEdit('foo', 'missing', 'x'), null);
  });

  test('PreToolUse hook blocks Write of syntactically-broken JS', () => {
    const out = childAV.execFileSync(
      'node',
      [pAV.join(PLUGIN, 'hooks', 'ast-validate.mjs')],
      {
        input: JSON.stringify({
          session_id: 'ast-test',
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/troth-ast-test.js', content: 'function broken( {' }
        }),
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN }),
        encoding: 'utf8'
      }
    );
    const parsed = JSON.parse(out.trim());
    assert.ok(parsed.hookSpecificOutput, 'should return hookSpecificOutput');
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'ask');
    assert.ok(
      (parsed.hookSpecificOutput.permissionDecisionReason || '').includes('syntax error'),
      'reason should name the syntax issue'
    );
  });

  test('PreToolUse hook allows Write of valid JS', () => {
    const out = childAV.execFileSync(
      'node',
      [pAV.join(PLUGIN, 'hooks', 'ast-validate.mjs')],
      {
        input: JSON.stringify({
          session_id: 'ast-test',
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/troth-ast-test.js', content: 'export const ok = 1;' }
        }),
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN }),
        encoding: 'utf8'
      }
    );
    assert.strictEqual(out.trim(), '{}', 'valid JS should allow silently');
  });
})();

// --- OUTPUT SANDBOX (behavior) ---
console.log('\nOutput sandbox (behavior):');
(function runOutputSandboxTests() {
  const childP = require('child_process');
  const pMod = require('path');
  const fMod = require('fs');
  const REPO = pMod.resolve(__dirname, '..');
  const PLUGIN = pMod.join(REPO, 'plugin');
  const TMP = pMod.join(REPO, '.tmp-sandbox-state');
  if (fMod.existsSync(TMP)) fMod.rmSync(TMP, { recursive: true, force: true });
  fMod.mkdirSync(TMP, { recursive: true });

  function runHook(script, payload) {
    const out = childP.execFileSync(
      'node',
      [pMod.join(PLUGIN, 'hooks', script)],
      {
        input: JSON.stringify(payload),
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      }
    );
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function dbConnect() {
    const Database = require('better-sqlite3');
    return new Database(pMod.join(TMP, 'state.db'));
  }

  test('small output skips archival (under 4KB threshold)', () => {
    // Trigger state.js migration first so the schema exists regardless of
    // whether the hook short-circuits before touching the db.
    runHook('session-start.mjs', { session_id: 's-sandbox-a', reason: 'startup' });
    runHook('output-sandbox.mjs', {
      session_id: 's-sandbox-a',
      tool_name: 'Read',
      tool_response: { content: 'hi there' }
    });
    const d = dbConnect();
    const row = d.prepare("SELECT COUNT(*) as n FROM tool_output_archive WHERE session_id = 's-sandbox-a'").get();
    d.close();
    assert.strictEqual(row.n, 0, 'small payload should not be archived');
  });

  test('large Read output is archived and FTS5-searchable', () => {
    const big = Array(500).fill('lorem ipsum consectetur adipiscing').join('\n') + '\nUNIQUE_TOKEN_XYZ777 needle\n';
    runHook('output-sandbox.mjs', {
      session_id: 's-sandbox-b',
      tool_name: 'Read',
      tool_response: { content: big }
    });
    const d = dbConnect();
    try {
      const archived = d.prepare('SELECT id, tool, bytes_in FROM tool_output_archive').get();
      assert.ok(archived, 'should have archived 1 row');
      assert.strictEqual(archived.tool, 'Read');
      const hit = d.prepare(
        "SELECT rowid FROM tool_output_fts WHERE tool_output_fts MATCH 'UNIQUE_TOKEN_XYZ777'"
      ).get();
      assert.ok(hit, 'FTS5 should find the unique token');
      assert.strictEqual(hit.rowid, archived.id);
    } finally { d.close(); }
  });

  test('MCP tool output returns updatedMCPToolOutput with archive reference', () => {
    const big = Array(400).fill('wibble wobble noise').join('\n');
    const out = runHook('output-sandbox.mjs', {
      session_id: 's-sandbox-c',
      tool_name: 'mcp__troth-bash__run',
      tool_response: { output: big }
    });
    assert.ok(out.hookSpecificOutput, 'MCP tool should get hookSpecificOutput');
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(
      out.hookSpecificOutput.updatedMCPToolOutput.includes('archive_id='),
      'updatedMCPToolOutput should reference the archive id'
    );
    assert.ok(
      out.hookSpecificOutput.updatedMCPToolOutput.length < big.length,
      'updatedMCPToolOutput should be shorter than raw'
    );
  });

  try { fMod.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
})();

// --- BASH COMPRESSOR (behavior) ---
console.log('\nBash compressor (behavior):');
(function runBashCompressorTests() {
  const { execFileSync } = require('child_process');
  const pathMod3 = require('path');
  const fsMod3 = require('fs');
  const REPO = pathMod3.resolve(__dirname, '..');
  const compressor = pathMod3.join(REPO, 'plugin', 'mcp-servers', 'troth-bash', 'compress.mjs');

  function invoke(command, output) {
    const script = `
      import { compressCommandOutput } from '${compressor}';
      const result = compressCommandOutput(${JSON.stringify(command)}, ${JSON.stringify(output)});
      process.stdout.write(JSON.stringify(result));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
    return JSON.parse(out);
  }

  test('small output passes through unchanged', () => {
    const out = 'file1.txt\nfile2.txt\n';
    const r = invoke('ls', out);
    assert.strictEqual(r.summary, out);
    assert.strictEqual(r.ratio, 1);
  });

  test('git log gets head/tail compression over 100 commits', () => {
    const lines = [];
    for (let i = 0; i < 300; i++) lines.push('abc' + i + ' commit message ' + i);
    const raw = lines.join('\n');
    const r = invoke('git log --oneline', raw);
    assert.ok(r.ratio < 1, 'should compress');
    assert.ok(r.summary.includes('commits trimmed'), 'should mark the trim');
    assert.ok(r.summary.includes('abc0'), 'head should survive');
    assert.ok(r.summary.includes('abc299'), 'tail should survive');
  });

  test('grep output caps to ~180 lines with match/file summary', () => {
    const lines = [];
    for (let i = 0; i < 500; i++) lines.push('src/file' + (i % 20) + '.js:12:foo()');
    const r = invoke('grep -r foo src/', lines.join('\n'));
    assert.ok(r.ratio < 1, 'should compress');
    assert.ok(/\d+ additional matches across \d+ files/.test(r.summary), 'should report trimmed matches + file count');
  });

  test('generic long output head/tail compressed with explicit marker', () => {
    const lines = [];
    for (let i = 0; i < 400; i++) lines.push('log line ' + i + ' ' + 'x'.repeat(30));
    const r = invoke('custom-tool', lines.join('\n'));
    assert.ok(r.ratio < 1, 'should compress');
    assert.ok(r.summary.includes('lines trimmed by troth-bash'), 'generic marker present');
    assert.ok(r.summary.includes('log line 0'), 'head preserved');
    assert.ok(r.summary.includes('log line 399'), 'tail preserved');
  });
})();

// --- HASHLINE (behavior) ---
console.log('\nHashline edit format (behavior):');
(function runHashlineTests() {
  const hl = require('../shared-core/hashline');

  const src =
    'import { foo } from "bar";\n' +
    '\n' +
    'function greet(name) {\n' +
    '  return `hello ${name}`;\n' +
    '}\n';

  test('encodeFile produces 1-indexed LINE#TAG|content lines', () => {
    const { decorated, tags } = hl.encodeFile(src);
    const lines = decorated.split('\n');
    assert.strictEqual(lines.length, src.split('\n').length);
    assert.match(lines[0], /^1#[A-Z]{2}\|/);
    assert.match(lines[2], /^3#[A-Z]{2}\|function greet\(name\)/);
    assert.strictEqual(tags.length, src.split('\n').length);
    // Tags must be 2 chars from the documented alphabet.
    for (const t of tags) {
      assert.strictEqual(t.length, 2);
      for (const c of t) assert.ok(hl.ALPHABET.includes(c), 'tag char in alphabet: ' + t);
    }
  });

  test('computeTag is deterministic for identical input', () => {
    assert.strictEqual(hl.computeTag('hello world', 1), hl.computeTag('hello world', 1));
  });

  test('computeTag differs for different content at same line', () => {
    const a = hl.computeTag('function foo() {', 5);
    const b = hl.computeTag('function bar() {', 5);
    assert.notStrictEqual(a, b, 'different content must produce different tags');
  });

  test('whitespace-only lines use line number as seed to decorrelate', () => {
    // All blank lines should not collapse to the same tag.
    const t1 = hl.computeTag('', 1);
    const t2 = hl.computeTag('', 2);
    const t5 = hl.computeTag('', 5);
    assert.ok(t1 !== t2 || t2 !== t5,
      'blank lines must not all share one tag (seed=lineNum decorrelates)');
  });

  test('applyEdits round-trip: replace single line by LINE#TAG', () => {
    const { tags } = hl.encodeFile(src);
    const edits = [{ op: 'replace', pos: '4#' + tags[3], lines: '  return `hi ${name}`;' }];
    const r = hl.applyEdits(src, edits);
    assert.strictEqual(r.ok, true);
    assert.ok(r.content.includes('return `hi ${name}`'), 'line 4 replaced');
    assert.ok(!r.content.includes('hello ${name}'), 'old content gone');
  });

  test('applyEdits rejects on hash mismatch (file drifted since read)', () => {
    const edits = [{ op: 'replace', pos: '4#XX', lines: 'fake' }];
    const r = hl.applyEdits(src, edits);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errors[0].reason, 'hash_mismatch');
    assert.strictEqual(r.errors[0].got.length, 2, 'must return the expected current tag');
  });

  test('applyEdits supports range replace (pos..end)', () => {
    const { tags } = hl.encodeFile(src);
    const edits = [{
      op: 'replace',
      pos: '3#' + tags[2],
      end: '5#' + tags[4],
      lines: ['function greet(name) {', '  return name;', '}']
    }];
    const r = hl.applyEdits(src, edits);
    assert.strictEqual(r.ok, true);
    assert.ok(r.content.includes('return name;'));
    assert.ok(!r.content.includes('hello'));
  });

  test('applyEdits supports append (insert AFTER anchor)', () => {
    const { tags } = hl.encodeFile(src);
    const edits = [{ op: 'append', pos: '5#' + tags[4], lines: ['', 'export { greet };'] }];
    const r = hl.applyEdits(src, edits);
    assert.strictEqual(r.ok, true);
    const lines = r.content.split('\n');
    // }\n\nexport…
    const idx = lines.findIndex(l => l === 'export { greet };');
    assert.ok(idx > lines.indexOf('}'), 'append inserts AFTER anchor');
  });

  test('applyEdits supports prepend (insert BEFORE anchor)', () => {
    const { tags } = hl.encodeFile(src);
    const edits = [{ op: 'prepend', pos: '1#' + tags[0], lines: '// header' }];
    const r = hl.applyEdits(src, edits);
    assert.strictEqual(r.ok, true);
    const lines = r.content.split('\n');
    assert.strictEqual(lines[0], '// header');
    assert.ok(lines[1].startsWith('import '));
  });

  test('applyEdits lines=null deletes the referenced line', () => {
    const { tags } = hl.encodeFile(src);
    const edits = [{ op: 'replace', pos: '2#' + tags[1], lines: null }];
    const r = hl.applyEdits(src, edits);
    assert.strictEqual(r.ok, true);
    const lines = r.content.split('\n');
    // Line 2 was the blank line; after deletion line 2 becomes "function…"
    assert.ok(lines[1].startsWith('function greet'), 'blank line removed');
  });

  test('applyEdits multi-edit applies bottom-up to keep indices stable', () => {
    const { tags } = hl.encodeFile(src);
    const edits = [
      { op: 'prepend', pos: '1#' + tags[0], lines: '// top' },
      { op: 'replace', pos: '4#' + tags[3], lines: '  return name.toUpperCase();' },
      { op: 'append',  pos: '5#' + tags[4], lines: ['', 'export { greet };'] },
    ];
    const r = hl.applyEdits(src, edits);
    assert.strictEqual(r.ok, true);
    assert.ok(r.content.startsWith('// top\n'), 'prepend landed');
    assert.ok(r.content.includes('name.toUpperCase()'), 'middle replace landed');
    assert.ok(r.content.includes('export { greet };'), 'append landed');
  });

  test('validateRef returns hash mismatch with current tag for stale refs', () => {
    const v = hl.validateRef(src, '4#AA');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'hash_mismatch');
    assert.strictEqual(v.expected, 'AA');
    assert.strictEqual(v.got.length, 2);
  });

  test('validateRef returns out_of_range for line numbers past EOF', () => {
    const v = hl.validateRef(src, '999#AB');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'out_of_range');
  });

  test('parsePos rejects malformed references', () => {
    assert.strictEqual(hl.parsePos(''), null);
    assert.strictEqual(hl.parsePos('42'), null);
    assert.strictEqual(hl.parsePos('42#X'), null);
    assert.strictEqual(hl.parsePos('42#XYZ'), null);
    assert.strictEqual(hl.parsePos('abc#XY'), null);
    assert.deepStrictEqual(hl.parsePos('42#XY'), { line: 42, tag: 'XY' });
  });

  test('xxHash32 matches a known vector (empty string, seed 0)', () => {
    // Reference: xxHash32('') with seed=0 = 0x02CC5D05.
    assert.strictEqual(hl.xxHash32('', 0), 0x02CC5D05);
  });

  test('hashline_edit MCP rejects edits that break AST', () => {
    // The reject road only exists where the parsers do; a runtime without
    // them serves edits with validation reported skipped, proven elsewhere.
    if (!require('../shared-core/ast-validate.js').available()) return skip('no tree-sitter parsers on this runtime');
    const childMCP = require('child_process');
    const pMCP = require('path');
    const fMCP = require('fs');
    const REPO_HL = pMCP.resolve(__dirname, '..');
    const SERVER = pMCP.join(REPO_HL, 'plugin/mcp-servers/troth-hashline/server.mjs');
    const tmp = pMCP.join(require('os').tmpdir(), 'troth-hl-ast-' + Date.now() + '.js');
    fMCP.writeFileSync(tmp, 'function f() {\n  return 1;\n}\n');

    // Spawn server, exchange init + read + edit that breaks syntax.
    const child = childMCP.spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const replies = [];
    child.stdout.on('data', (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) replies.push(JSON.parse(line));
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'hashline_read', arguments: { file_path: tmp } } });

    // Wait for the read, extract tag, send a bad edit (drops closing brace).
    // deadline must be per-call, not shared. The previous shared
    // `const deadline = Date.now() + 3000` was computed at test-declaration
    // time but only checked inside flushAsyncTests at end-of-suite — so on
    // any suite longer than 3s, both waitFor() calls saw an already-expired
    // deadline and rejected immediately.
    function waitFor(n, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 3000);
      return new Promise((res, rej) => {
        const tick = setInterval(() => {
          if (replies.length >= n) { clearInterval(tick); res(); }
          else if (Date.now() > deadline) { clearInterval(tick); rej(new Error('timeout')); }
        }, 20);
      });
    }

    // waitFor(2) is set up SYNCHRONOUSLY during test declaration but only
    // awaited at end-of-suite by flushAsyncTests. A 3-second deadline
    // would expire during sync execution of the 900+ tests that follow.
    // Give it 60s — plenty for the suite to reach the await. waitFor(3)
    // is called inside.then (post-await), so its 3s default is fine.
    return waitFor(2, 60000).then(() => {
      // payload is the LAST block — the session's first result may lead with
      // the one-shot [troth] greeting
      const decorated = replies[1].result.content[replies[1].result.content.length - 1].text;
      const tag3 = decorated.split('\n')[2].match(/^3#([A-Z]{2})\|/)[1]; // line 3 = "}"
      // Replace line 3 ("}") with something else that breaks the function.
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'hashline_edit', arguments: {
          file_path: tmp,
          edits: [{ op: 'replace', pos: '3#' + tag3, lines: 'return 2;' }]  // breaks: no closing brace
        } } });
      return waitFor(3);
    }).then(() => {
      const r = replies[2].result;
      child.kill();
      // AST gate should have blocked this.
      assert.ok(r.isError, 'syntactically invalid edit must be rejected');
      const payload = JSON.parse(r.content[r.content.length - 1].text);
      assert.strictEqual(payload.error, 'ast_parse_failed',
        'reason must be AST parse failure, got: ' + payload.error);
      // File must be UNCHANGED (commit only on AST pass).
      const after = fMCP.readFileSync(tmp, 'utf8');
      assert.strictEqual(after, 'function f() {\n  return 1;\n}\n',
        'file must not be modified when AST gate rejects');
      fMCP.unlinkSync(tmp);
    }).catch(err => { child.kill(); throw err; });
  });

  test('hashline_edit MCP serves edits when no parser can, and the server keeps answering', () => {
    // The other half of the AST contract: a runtime whose parsers cannot
    // load degrades to hash-anchored edits with validation skipped — the
    // hands never go dark because a native binding died. The shim breaks
    // every tree-sitter require in the server process; on a runtime whose
    // parser dies at parse time instead, the boot probe reaches the same
    // skipped road.
    const childMCP = require('child_process');
    const pMCP = require('path');
    const fMCP = require('fs');
    const osMCP = require('os');
    const REPO_HL = pMCP.resolve(__dirname, '..');
    const SERVER = pMCP.join(REPO_HL, 'plugin/mcp-servers/troth-hashline/server.mjs');
    const shim = pMCP.join(osMCP.tmpdir(), 'troth-hl-noparser-shim-' + Date.now() + '.cjs');
    fMCP.writeFileSync(shim, [
      "const M = require('module');",
      'const orig = M._load;', 
      'M._load = function (req) {', 
      "  if (/^tree-sitter/.test(req)) throw new Error('parsers unavailable (test shim)');",
      '  return orig.apply(this, arguments);', 
      '};'
    ].join('\n'));
    const tmp = pMCP.join(osMCP.tmpdir(), 'troth-hl-noparser-' + Date.now() + '.js');
    fMCP.writeFileSync(tmp, 'function g() {\n  return 1;\n}\n');
    const child = childMCP.spawn('node', ['--require', shim, SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const replies = [];
    child.stdout.on('data', (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) replies.push(JSON.parse(line));
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'hashline_read', arguments: { file_path: tmp } } });
    function waitFor(n, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 3000);
      return new Promise((res, rej) => {
        const tick = setInterval(() => {
          if (replies.length >= n) { clearInterval(tick); res(); }
          else if (Date.now() > deadline) { clearInterval(tick); rej(new Error('timeout — the server went dark without parsers')); }
        }, 20);
      });
    }
    return waitFor(2, 60000).then(() => {
      const decorated = replies[1].result.content[replies[1].result.content.length - 1].text;
      const tag3 = decorated.split('\n')[2].match(/^3#([A-Z]{2})\|/)[1];
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'hashline_edit', arguments: {
          file_path: tmp,
          edits: [{ op: 'replace', pos: '3#' + tag3, lines: 'return 2;' }]
        } } });
      return waitFor(3, 10000);
    }).then(() => {
      const r = replies[2].result;
      child.kill();
      assert.ok(!r.isError, 'without parsers the hash-anchored edit must apply: ' + JSON.stringify(r).slice(0, 200));
      const after = fMCP.readFileSync(tmp, 'utf8');
      assert.strictEqual(after, 'function g() {\n  return 1;\nreturn 2;\n',
        'the edit must land exactly as anchored');
      fMCP.unlinkSync(tmp); fMCP.unlinkSync(shim);
    }).catch(err => { child.kill(); try { fMCP.unlinkSync(shim); } catch (_) {} throw err; });
  });
})();

// --- ACTIONRECORD / SUBSTRATE PHASE A (behavior) ---
console.log('\nActionRecord substrate:');
(function runActionRecordTests() {
  const AR = require('../shared-core/action-record');
  const V  = require('../shared-core/verification');

  // A1 — schema + validators + type registry
  test('A1: create() fills id + timestamp when omitted', () => {
    const r = AR.create({ type: 'edit', agent_id: 'x', input: { file_path: 'f', format: 'h' }, output: { hash_after: 'a' } });
    assert.strictEqual(typeof r.id, 'string');
    assert.strictEqual(r.id.length, 36);
    assert.ok(r.timestamp > 0);
  });

  test('A1: UUIDv7 ids are chronologically sortable', () => {
    const older = AR.uuidv7(1700000000000);
    const newer = AR.uuidv7(1800000000000);
    assert.ok(older < newer, 'older id < newer id lexicographically');
  });

  test('A1: uuidv7Timestamp extracts the embedded ms', () => {
    const id = AR.uuidv7(1776787777588);
    assert.strictEqual(AR.uuidv7Timestamp(id), 1776787777588);
  });

  test('A1: validate passes on well-formed edit record', () => {
    const r = AR.create({
      type: 'edit', agent_id: 'cc',
      input: { file_path: 'a.ts', format: 'hashline' },
      output: { hash_after: 'abc' }
    });
    const v = AR.validate(r);
    assert.strictEqual(v.ok, true, 'errors: ' + JSON.stringify(v.errors));
  });

  test('A1: validate rejects unknown type', () => {
    const v = AR.validate(AR.create({ type: 'made_up_type', agent_id: 'cc' }));
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some(e => e.kind === 'unknown_type'));
  });

  test('A1: validate rejects missing required input field', () => {
    const v = AR.validate(AR.create({ type: 'edit', agent_id: 'cc', output: { hash_after: 'a' } }));
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some(e => e.kind === 'missing_input_field' && e.field === 'file_path'));
  });

  test('A1: toRow/fromRow round-trip preserves content', () => {
    const r = AR.create({
      type: 'edit', agent_id: 'cc', session_id: 's', cwd: '/p',
      input: { file_path: 'x', format: 'h', extra: [1, 2, 3] },
      output: { hash_after: 'abc' },
      verification: { ast: { ok: true } }
    });
    const back = AR.fromRow(AR.toRow(r));
    assert.strictEqual(back.id, r.id);
    assert.strictEqual(back.input.file_path, 'x');
    assert.deepStrictEqual(back.input.extra, [1, 2, 3]);
    assert.strictEqual(back.verification.ast.ok, true);
  });

  test('A1: toSearchText surfaces type + agent + file_path for FTS', () => {
    const r = AR.create({
      type: 'edit', agent_id: 'claude-code', cwd: '/proj',
      input: { file_path: 'auth.ts', format: 'hashline' },
      output: { hash_after: 'abc' }
    });
    const t = AR.toSearchText(r);
    assert.ok(t.includes('edit'));
    assert.ok(t.includes('claude-code'));
    assert.ok(t.includes('auth.ts'));
  });

  // A2 — SQLite layer (uses isolated data dir)
  const pathMod = require('path');
  const fsMod = require('fs');
  const TMP_A = pathMod.join(require('os').tmpdir(), 'gc-substrate-a-' + Date.now());
  fsMod.mkdirSync(TMP_A, { recursive: true });
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = TMP_A;
  delete require.cache[require.resolve('../shared-core/state')];
  const state = require('../shared-core/state');
  delete require.cache[require.resolve('../shared-core/action-outcome')];
  const O = require('../shared-core/action-outcome');

  test('A2: recordAction persists + getAction retrieves', () => {
    const r = AR.create({
      type: 'edit', agent_id: 'cc', session_id: 'sA',
      cwd: '/tmp/projA',
      input: { file_path: 'a.ts', format: 'hashline' },
      output: { hash_after: 'h1' }
    });
    const id = state.recordAction(r, AR.toSearchText(r));
    assert.strictEqual(id, r.id);
    const row = state.getAction(r.id);
    assert.ok(row, 'row must exist');
    assert.strictEqual(row.type, 'edit');
    assert.strictEqual(row.session_id, 'sA');
  });

  test('A2: queryActions filters by type + cwd', () => {
    const base = { agent_id: 'cc', cwd: '/tmp/projB' };
    state.recordAction(AR.create({ type: 'read', ...base, input: { file_path: 'x.ts' }, output: { hash: 'r1' } }), 'read');
    state.recordAction(AR.create({ type: 'read', ...base, input: { file_path: 'y.ts' }, output: { hash: 'r2' } }), 'read');
    state.recordAction(AR.create({ type: 'edit', ...base, input: { file_path: 'z.ts', format: 'h' }, output: { hash_after: 'e1' } }), 'edit');
    const reads = state.queryActions({ type: 'read', cwd: '/tmp/projB' });
    const edits = state.queryActions({ type: 'edit', cwd: '/tmp/projB' });
    assert.strictEqual(reads.length, 2);
    assert.strictEqual(edits.length, 1);
  });

  test('A2: countActions returns correct totals', () => {
    const n = state.countActions({ cwd: '/tmp/projB' });
    assert.strictEqual(n, 3);
  });

  test('A2: searchActions finds by FTS token', () => {
    // Record with explicit search text containing a unique token so FTS mirror
    // has something to match against.
    const rec = AR.create({ type: 'search', agent_id: 'cc', session_id: 'sFTS', cwd: '/tmp/fts', input: { query: 'needlehaystack', kind: 'grep' }, output: { result_count: 0 } });
    state.recordAction(rec, AR.toSearchText(rec));
    const hits = state.searchActions('needlehaystack');
    assert.ok(hits.length >= 1, 'FTS should find the unique token');
    assert.strictEqual(hits[0].id, rec.id);
  });

  test('A2: parent_id links actions causally', () => {
    const parent = AR.create({ type: 'read', agent_id: 'cc', session_id: 'sC', cwd: '/tmp/projC', input: { file_path: 'p.ts' }, output: { hash: 'p1' } });
    state.recordAction(parent, AR.toSearchText(parent));
    const child = AR.create({ type: 'edit', agent_id: 'cc', session_id: 'sC', cwd: '/tmp/projC', parent_id: parent.id, input: { file_path: 'p.ts', format: 'h' }, output: { hash_after: 'p2' } });
    state.recordAction(child, AR.toSearchText(child));
    const children = state.queryActions({ parent_id: parent.id });
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].id, child.id);
  });

  // A3 — verification primitives
  test('A3: verifyAST passes on valid JS', () => {
    const r = V.verifyAST('/tmp/v.js', 'function f() { return 1; }');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.skipped, false);
  });

  test('A3: verifyAST fails on broken JS with structured errors', () => {
    const r = V.verifyAST('/tmp/v.js', 'function f( {');
    assert.strictEqual(r.ok, false);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    assert.strictEqual(r.errors[0].kind, 'parse_error');
  });

  test('A3: verifyAST skips unsupported extension gracefully', () => {
    const r = V.verifyAST('/tmp/v.rs', 'fn main() {}');
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.ok, null);
  });

  test('A3: verifyTests normalizes pass/fail counts', () => {
    assert.strictEqual(V.verifyTests({ passed: 5, failed: 0 }).ok, true);
    assert.strictEqual(V.verifyTests({ passed: 3, failed: 2 }).ok, false);
    assert.strictEqual(V.verifyTests(null).skipped, true);
  });

  test('A3: composite builds verification object; verdict aggregates', () => {
    const passV = V.composite({
      ast: () => V.verifyAST('/tmp/c.js', 'const x = 1;'),
      tests: () => V.verifyTests({ passed: 5, failed: 0 })
    });
    assert.strictEqual(V.verdict(passV), 'pass');

    const failV = V.composite({
      ast: () => V.verifyAST('/tmp/c.js', 'const x = ;'),
      tests: () => V.verifyTests({ passed: 3, failed: 0 })
    });
    assert.strictEqual(V.verdict(failV), 'fail');

    const partialV = V.composite({
      ast: () => V.verifyAST('/tmp/c.rs', 'fn main() {}')
    });
    assert.strictEqual(V.verdict(partialV), 'partial');
  });

  // A4 — outcome events
  test('A4: markAccepted creates an outcome event queryable via getOutcome', () => {
    const rec = AR.create({ type: 'edit', agent_id: 'cc', session_id: 'sD', cwd: '/tmp/projD', input: { file_path: 'o.ts', format: 'h' }, output: { hash_after: 'oh' } });
    state.recordAction(rec, AR.toSearchText(rec));
    O.markAccepted(state, rec.id, 'test-runner', { source: 'pytest', session_id: 'sD' });
    const o = O.getOutcome(state, rec.id);
    assert.strictEqual(o.accepted, true);
    assert.strictEqual(o.event_count, 1);
    assert.ok(o.sources.includes('pytest'));
  });

  test('A4: later revert overrides accepted; audit trail preserved', () => {
    const rec = AR.create({ type: 'edit', agent_id: 'cc', session_id: 'sE', cwd: '/tmp/projE', input: { file_path: 'r.ts', format: 'h' }, output: { hash_after: 'rh' } });
    state.recordAction(rec, AR.toSearchText(rec));
    O.markAccepted(state, rec.id, 'runner', { source: 'pytest', session_id: 'sE' });
    O.markReverted(state, rec.id, 'user', { reason: 'wrong approach', session_id: 'sE' });
    const o = O.getOutcome(state, rec.id);
    assert.strictEqual(o.accepted, false, 'revert must override');
    assert.strictEqual(o.reverted, true);
    assert.strictEqual(o.reverted_reason, 'wrong approach');
    assert.strictEqual(o.event_count, 2, 'both events preserved');
    const events = O.listOutcomeEvents(state, rec.id);
    assert.deepStrictEqual(events.map(e => e.input.outcome_kind), ['accepted', 'reverted']);
  });

  test('A4: linkCommit records commit_sha in outcome', () => {
    const rec = AR.create({ type: 'edit', agent_id: 'cc', session_id: 'sF', cwd: '/tmp/projF', input: { file_path: 'c.ts', format: 'h' }, output: { hash_after: 'ch' } });
    state.recordAction(rec, AR.toSearchText(rec));
    O.linkCommit(state, rec.id, 'commit-hook', { commit_sha: 'abc123def', branch: 'main', session_id: 'sF' });
    const o = O.getOutcome(state, rec.id);
    assert.strictEqual(o.led_to_commit, 'abc123def');
    assert.strictEqual(o.commit_branch, 'main');
  });

  // Clean up isolated data dir
  try { fsMod.rmSync(TMP_A, { recursive: true, force: true }); } catch (e) {}
  process.env.CLAUDE_PLUGIN_DATA = savedEnv;
})();

// --- Hook → ActionRecord integration ---
console.log('\nHook migration (behavior):');
(function runA5HookTests() {
  const AR = require('../shared-core/action-record');
  const childA = require('child_process');
  const pA = require('path');
  const fA = require('fs');
  const REPO_A = pA.resolve(__dirname, '..');
  const PLUGIN_A = pA.join(REPO_A, 'plugin');
  const TMP_A5 = pA.join(require('os').tmpdir(), 'gc-a5-' + Date.now());
  fA.mkdirSync(TMP_A5, { recursive: true });

  function runHookA(script, payload) {
    const out = childA.execFileSync('node', [pA.join(PLUGIN_A, 'hooks', script)], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN_A, CLAUDE_PLUGIN_DATA: TMP_A5 }),
      encoding: 'utf8'
    });
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function loadStateA5() {
    // Fresh require with the A5 data dir so queries see the hooks' writes.
    process.env.CLAUDE_PLUGIN_DATA = TMP_A5;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }

  test('A5: mark-read hook writes a read-type ActionRecord', () => {
    const sessId = 'a5-mr-' + Date.now();
    runHookA('mark-read.mjs', {
      session_id: sessId, cwd: REPO_A,
      tool_name: 'Read',
      tool_input: { file_path: REPO_A + '/package.json' },
      tool_response: {}
    });
    const s = loadStateA5();
    const rows = s.queryActions({ type: 'read', session_id: sessId });
    assert.ok(rows.length >= 1, 'at least one read action must be recorded');
    const parsed = AR.fromRow(rows[0]);
    assert.ok(parsed.input.file_path, 'file_path must be present in input');
  });

  test('A5: loopbreaker records a decision ActionRecord on allow path', () => {
    const sessId = 'a5-lb-' + Date.now();
    runHookA('loopbreaker.mjs', {
      session_id: sessId, cwd: REPO_A,
      tool_name: 'Bash', tool_input: { command: 'echo ping' }
    });
    const s = loadStateA5();
    const rows = s.queryActions({ type: 'decision', session_id: sessId });
    assert.ok(rows.length >= 1, 'decision action must be recorded');
    const parsed = AR.fromRow(rows[0]);
    assert.strictEqual(parsed.input.kind, 'loopbreaker');
    assert.strictEqual(parsed.output.decision, 'allow');
  });

  test('A5: verifyfirst emits decision ActionRecord with verifyfirst kind', () => {
    const sessId = 'a5-vf-' + Date.now();
    // Non-existent path → new_file path
    runHookA('verifyfirst.mjs', {
      session_id: sessId, cwd: REPO_A,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/does-not-exist-' + Date.now() + '.js' }
    });
    const s = loadStateA5();
    const rows = s.queryActions({ type: 'decision', session_id: sessId });
    const vf = rows.map(r => AR.fromRow(r)).filter(p => p.input.kind === 'verifyfirst');
    assert.ok(vf.length >= 1, 'verifyfirst decision must be recorded');
    assert.strictEqual(vf[0].output.reason, 'new_file');
  });

  // Step 1 (substrate-era) — mark-edit must write edit ActionRecords for
  // default-tool edits so cross-session precedent queries have data. This
  // is the gap the live multi-session benchmark surfaced on.
  test('Step1: mark-edit records a verified edit for a Write on a valid JS file', () => {
    const sessId = 'step1-we-' + Date.now();
    const tmpFile = pA.join(TMP_A5, 'e_' + Date.now() + '.js');
    fA.writeFileSync(tmpFile, 'module.exports = function () { return 42; };\n');
    runHookA('mark-edit.mjs', {
      session_id: sessId, cwd: REPO_A,
      tool_name: 'Write',
      tool_input: { file_path: tmpFile, content: 'module.exports = function () { return 42; };\n' },
      tool_response: {}
    });
    const s = loadStateA5();
    const rows = s.queryActions({ type: 'edit', session_id: sessId });
    assert.ok(rows.length >= 1, 'at least one edit action must be recorded');
    const parsed = AR.fromRow(rows[0]);
    assert.strictEqual(parsed.input.format, 'write');
    assert.ok(parsed.output.hash_after, 'hash_after must be populated');
    assert.strictEqual(parsed.verification.ast.ok, true, 'AST verification must pass on valid JS');
  });

  test('Step1: mark-edit records ast.ok=false when file has a syntax error', () => {
    const sessId = 'step1-br-' + Date.now();
    const tmpFile = pA.join(TMP_A5, 'b_' + Date.now() + '.js');
    // Deliberately broken: unclosed brace. Parser must reject.
    fA.writeFileSync(tmpFile, 'function oops() { return 1\n');
    runHookA('mark-edit.mjs', {
      session_id: sessId, cwd: REPO_A,
      tool_name: 'Edit',
      tool_input: { file_path: tmpFile, old_string: '', new_string: '' },
      tool_response: {}
    });
    const s = loadStateA5();
    const rows = s.queryActions({ type: 'edit', session_id: sessId });
    assert.ok(rows.length >= 1);
    const parsed = AR.fromRow(rows[0]);
    assert.strictEqual(parsed.verification.ast.ok, false, 'AST must flag the broken file');
  });

  test('Step1: mark-edit skips AST for unsupported extensions but still records the edit', () => {
    const sessId = 'step1-md-' + Date.now();
    const tmpFile = pA.join(TMP_A5, 'n_' + Date.now() + '.md');
    fA.writeFileSync(tmpFile, '# hello\n');
    runHookA('mark-edit.mjs', {
      session_id: sessId, cwd: REPO_A,
      tool_name: 'Write',
      tool_input: { file_path: tmpFile, content: '# hello\n' },
      tool_response: {}
    });
    const s = loadStateA5();
    const rows = s.queryActions({ type: 'edit', session_id: sessId });
    assert.ok(rows.length >= 1);
    const parsed = AR.fromRow(rows[0]);
    assert.strictEqual(parsed.verification.ast.skipped, true);
    assert.ok(parsed.output.hash_after, 'hash still computed for unsupported languages');
  });

  test('Step1: mark-edit passes through non-editing tools untouched', () => {
    const sessId = 'step1-pt-' + Date.now();
    runHookA('mark-edit.mjs', {
      session_id: sessId, cwd: REPO_A,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' }
    });
    const s = loadStateA5();
    const rows = s.queryActions({ type: 'edit', session_id: sessId });
    assert.strictEqual(rows.length, 0, 'Bash must not produce an edit record');
  });

  // query.getVerifiedActions must now return rows for the cwd — this is
  // what the injector's [troth/precedent] block depends on.
  test('Step1: getVerifiedActions surfaces an edit written by mark-edit', () => {
    const sessId = 'step1-qv-' + Date.now();
    const cwdIsolated = pA.join(TMP_A5, 'qv-cwd');
    fA.mkdirSync(cwdIsolated, { recursive: true });
    const tmpFile = pA.join(cwdIsolated, 'good.js');
    fA.writeFileSync(tmpFile, 'module.exports = {};\n');
    runHookA('mark-edit.mjs', {
      session_id: sessId, cwd: cwdIsolated,
      tool_name: 'Write',
      tool_input: { file_path: tmpFile, content: 'module.exports = {};\n' },
      tool_response: {}
    });
    const s = loadStateA5();
    const Q = require('../shared-core/query');
    const verified = Q.getVerifiedActions(s, { type: 'edit', cwd: cwdIsolated, limit: 10 });
    assert.ok(verified.length >= 1, 'verified edit must be surfaceable by getVerifiedActions');
    assert.strictEqual(verified[0].input.file_path, tmpFile);
  });

  // Step 2 (substrate-era) — chain tracker populates parent_id so
  // causality.traceCausalChain returns a real graph, not a single node.
  test('Step2: injector + PreToolUse + PostToolUse produce a causal chain', () => {
    const sessId = 'step2-chain-' + Date.now();
    const cwdIso = pA.join(TMP_A5, 'chain-cwd-' + Date.now());
    fA.mkdirSync(cwdIso, { recursive: true });
    const tmpFile = pA.join(cwdIso, 'f.js');
    fA.writeFileSync(tmpFile, 'module.exports = 1;\n');
    const toolUseId = 'tu_' + Date.now();

    // 1) injector fires as turn root
    runHookA('injector.mjs', {
      session_id: sessId, cwd: cwdIso,
      user_prompt: 'fix the null bug'
    });
    // 2) PreToolUse.loopbreaker for a Write on tmpFile
    runHookA('loopbreaker.mjs', {
      session_id: sessId, cwd: cwdIso,
      tool_name: 'Write',
      tool_input: { file_path: tmpFile, content: 'module.exports = 2;\n' },
      tool_use_id: toolUseId
    });
    // 3) PreToolUse.ast-validate for the same Write
    runHookA('ast-validate.mjs', {
      session_id: sessId, cwd: cwdIso,
      tool_name: 'Write',
      tool_input: { file_path: tmpFile, content: 'module.exports = 2;\n' },
      tool_use_id: toolUseId
    });
    // 4) Simulate the Write having happened, then PostToolUse.mark-edit
    fA.writeFileSync(tmpFile, 'module.exports = 2;\n');
    runHookA('mark-edit.mjs', {
      session_id: sessId, cwd: cwdIso,
      tool_name: 'Write',
      tool_input: { file_path: tmpFile, content: 'module.exports = 2;\n' },
      tool_response: {},
      tool_use_id: toolUseId
    });

    const s = loadStateA5();
    const edits = s.queryActions({ type: 'edit', session_id: sessId });
    assert.ok(edits.length >= 1, 'mark-edit must have recorded');
    const editRec = AR.fromRow(edits[0]);
    assert.ok(editRec.parent_id, 'edit record must have parent_id set');

    // Walk parents — should reach the injector's root decision.
    const causality = require('../shared-core/causality');
    const chain = causality.traceCausalChain(s, editRec.id) || [];
    assert.ok(chain.length >= 3, 'chain should be at least injector → preToolUse → edit, got: ' + chain.length);
    const kinds = chain.map(n => (n.input && n.input.kind) || n.type);
    assert.ok(kinds.includes('context_injection'), 'root of chain must be the injector decision; got kinds: ' + JSON.stringify(kinds));
  });

  test('Step2: tool_use_id=null payloads still chain under the turn root', () => {
    const sessId = 'step2-noid-' + Date.now();
    const cwdIso = pA.join(TMP_A5, 'noid-cwd-' + Date.now());
    fA.mkdirSync(cwdIso, { recursive: true });
    runHookA('injector.mjs', { session_id: sessId, cwd: cwdIso, user_prompt: 'x' });
    // Read hook without tool_use_id — still should be a child of injector.
    runHookA('mark-read.mjs', {
      session_id: sessId, cwd: cwdIso,
      tool_name: 'Read',
      tool_input: { file_path: pA.join(cwdIso, 'pkg.json') },
      tool_response: {}
    });
    const s = loadStateA5();
    const reads = s.queryActions({ type: 'read', session_id: sessId });
    assert.ok(reads.length >= 1);
    const r = AR.fromRow(reads[0]);
    assert.ok(r.parent_id, 'read without tool_use_id still gets parent_id = turn root');
  });

  try { fA.rmSync(TMP_A5, { recursive: true, force: true }); } catch (e) {}
})();

// --- Mind state: schema, validator, orientation formatter ---
console.log('\nMind state:');
(function runMindStateTests() {
  const mindState = require('../shared-core/mind-state');

  test('A6.V1: emptyMindState returns valid v0.1 shape', () => {
    const empty = mindState.emptyMindState('test-user');
    const v = mindState.validate(empty);
    assert.ok(v.ok, 'empty state must validate, got errors: ' + JSON.stringify(v.errors));
    assert.strictEqual(empty.schema_version, '0.1');
    assert.strictEqual(empty.user_id, 'test-user');
    assert.deepStrictEqual(empty.active_projects, []);
    assert.deepStrictEqual(empty.ongoing_threads, []);
    assert.deepStrictEqual(empty.decisions_explicitly_rejected, []);
  });

  test('A6.V2: validate rejects mind_state missing user_id', () => {
    const bad = { schema_version: '0.1', snapshot_at: '2026-04-29T20:00:00Z' };
    const v = mindState.validate(bad);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some(e => e.kind === 'missing_top_level' && e.field === 'user_id'),
      'expected missing user_id error, got: ' + JSON.stringify(v.errors));
  });

  test('A6.V3: validate rejects active_projects items missing id/name', () => {
    const bad = mindState.emptyMindState('u');
    bad.active_projects = [{ stage: 'design' }];
    const v = mindState.validate(bad);
    assert.strictEqual(v.ok, false);
    const kinds = v.errors.map(e => e.kind);
    assert.ok(kinds.includes('project_missing_field'),
      'expected project_missing_field, got kinds: ' + kinds.join(','));
  });

  test('A6.V4: validate rejects malformed task_signature', () => {
    const bad = mindState.emptyMindState('u');
    bad.current_intent = { task_signature: 'not-an-object' };
    const v = mindState.validate(bad);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some(e => e.kind === 'task_signature_not_object'));
  });

  test('A6.F1: formatOrientation returns empty string for empty mind state', () => {
    const out = mindState.formatOrientation(mindState.emptyMindState('u'));
    assert.strictEqual(out, '');
  });

  test('A6.F2: formatOrientation includes current_focus and project names', () => {
    const ms = mindState.emptyMindState('u');
    ms.current_focus = 'shipping mind protocol v0.1';
    ms.active_projects = [
      { id: 'gc', name: 'troth v11', stage: 'design', current_focus: 'paper done, build next' },
      { id: 'ar', name: 'atlasforge',   stage: 'GTM',    current_focus: 'weekly demo prep' }
    ];
    const out = mindState.formatOrientation(ms);
    assert.ok(out.includes('shipping mind protocol v0.1'), 'missing focus in output');
    assert.ok(out.includes('troth v11'), 'missing troth project');
    assert.ok(out.includes('atlasforge'), 'missing atlasforge project');
    assert.ok(out.includes('stage=design'), 'missing stage marker');
    assert.ok(out.includes('next=paper done, build next'), 'missing project current_focus');
  });

  test('A6.F3: formatOrientation truncates >10 projects with overflow note', () => {
    const ms = mindState.emptyMindState('u');
    ms.current_focus = 'lots of projects';
    ms.active_projects = Array.from({ length: 13 }, (_, i) => ({
      id: 'p' + i, name: 'Project ' + i, stage: 'active', current_focus: 'thing ' + i
    }));
    const out = mindState.formatOrientation(ms);
    assert.ok(out.includes('Project 0'));
    assert.ok(out.includes('Project 9'));
    assert.ok(!out.includes('Project 10'), 'project 10 should be in overflow');
    assert.ok(out.includes('+3 more'), 'expected +3 more overflow note');
  });

  test('A6.F4: formatOrientation surfaces decisions_explicitly_rejected', () => {
    const ms = mindState.emptyMindState('u');
    ms.current_focus = 'avoid relitigating';
    ms.decisions_explicitly_rejected = [
      { what: 'a rejected approach', rationale: 'did not hold up', rejected_at: '2026-01-01' }
    ];
    const out = mindState.formatOrientation(ms);
    assert.ok(out.includes('Already rejected'));
    assert.ok(out.includes('a rejected approach'));
  });

  test('A6.F5: formatOrientation surfaces top 2 decisions per project + overflow note', () => {
    const ms = mindState.emptyMindState('u');
    ms.active_projects = [{
      id: 'p1', name: 'Proj1', stage: 'build', current_focus: 'shipping',
      key_decisions: [
        { decision_id: 'd1', summary: 'use Resend not Tally',     rationale: 'brand fit' },
        { decision_id: 'd2', summary: 'modal pattern over inline', rationale: 'focus' },
        { decision_id: 'd3', summary: 'env-gated audience add',    rationale: 'best-effort' }
      ]
    }];
    const out = mindState.formatOrientation(ms);
    assert.ok(out.includes('use Resend not Tally'), 'first decision surfaces');
    assert.ok(out.includes('modal pattern over inline'), 'second decision surfaces');
    assert.ok(!out.includes('env-gated audience add'), 'third decision should be in overflow');
    assert.ok(out.includes('+1 more decisions'), 'overflow note present');
  });

  test('A6.B1: buildSnapshotRecord wraps mind_state into a valid ActionRecord', () => {
    const AR = require('../shared-core/action-record');
    const ms = mindState.emptyMindState('u');
    ms.current_focus = 'something';
    const built = mindState.buildSnapshotRecord({
      id: '019dd910-0000-7000-8000-000000000001',
      timestamp: 1714000000000,
      agent_id: 'claude-code',
      cwd: '/tmp/x',
      mind_state: ms,
      trigger: 'test'
    });
    assert.ok(built.ok, 'expected build ok, got errors: ' + JSON.stringify(built.errors || []));
    const v = AR.validate(built.record);
    assert.ok(v.ok, 'built record must validate as ActionRecord, got: ' + JSON.stringify(v.errors));
    assert.strictEqual(built.record.type, 'mind_snapshot');
    assert.strictEqual(built.record.input.trigger, 'test');
    assert.deepStrictEqual(built.record.output.mind_state, ms);
  });

  test('A6.B2: buildSnapshotRecord refuses invalid mind_state', () => {
    const built = mindState.buildSnapshotRecord({
      id: '019dd910-0000-7000-8000-000000000002',
      mind_state: { schema_version: '0.1' /* missing fields */ }
    });
    assert.strictEqual(built.ok, false);
    assert.ok(Array.isArray(built.errors) && built.errors.length > 0);
  });

  test('A6.R1: recomputeFromSubstrate returns empty mind_state when no records exist', () => {
    const fakeState = {
      queryActions: () => []
    };
    const out = mindState.recomputeFromSubstrate(fakeState, { user_id: 'fresh' });
    assert.ok(out && out.mind_state);
    assert.strictEqual(out.prev_snapshot_id, null);
    assert.strictEqual(out.intents_seen, 0);
    assert.strictEqual(out.mind_state.user_id, 'fresh');
    assert.strictEqual(out.mind_state.schema_version, '0.1');
  });

  test('A6.R2: recomputeFromSubstrate folds latest snapshot + intent into new view', () => {
    // Simulate substrate rows. queryActions returns row-shaped objects:
    // { id, timestamp, type, agent_id, cwd, input, output,... } where
    // input/output are JSON strings (matches state.js storage).
    const prevSnapshotId = '019dd911-0000-7000-8000-000000000001';
    const prevTs = 1714000000000;
    const prevState = mindState.emptyMindState('alex');
    prevState.current_focus = 'old focus';
    prevState.snapshot_at = '2026-04-25T00:00:00.000Z'; // pin so the
    // recomputed snapshot_at (now) is reliably different.
    prevState.active_projects = [
      { id: 'gc', name: 'troth v11', stage: 'design', current_focus: 'paper' }
    ];

    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') {
          return [{
            id: prevSnapshotId,
            timestamp: prevTs,
            type: 'mind_snapshot',
            agent_id: 'claude-code',
            cwd: '/tmp/test',
            input: JSON.stringify({ schema_version: '0.1', trigger: 'test' }),
            output: JSON.stringify({ mind_state: prevState }),
            verification: '{}',
            outcome: '{}'
          }];
        }
        if (type === 'intent') {
          return [{
            id: '019dd912-0000-7000-8000-000000000002',
            timestamp: prevTs + 1000,
            type: 'intent',
            agent_id: 'claude-code',
            cwd: '/tmp/test',
            input: JSON.stringify({ goal: 'ship mind protocol v0.1', source_message_hash: 'abc' }),
            output: JSON.stringify({ chosen_path: 'incremental' }),
            verification: '{}',
            outcome: '{}'
          }];
        }
        return [];
      }
    };

    const out = mindState.recomputeFromSubstrate(fakeState, { cwd: '/tmp/test' });
    assert.ok(out && out.mind_state);
    assert.strictEqual(out.prev_snapshot_id, prevSnapshotId);
    assert.strictEqual(out.intents_seen, 1);
    // Carried forward from prev snapshot.
    assert.strictEqual(out.mind_state.current_focus, 'old focus');
    assert.strictEqual(out.mind_state.active_projects[0].id, 'gc');
    // Updated by latest intent.
    assert.ok(out.mind_state.current_intent);
    assert.strictEqual(out.mind_state.current_intent.what, 'ship mind protocol v0.1');
    // snapshot_at refreshed (close to now, definitely later than prev).
    assert.ok(typeof out.mind_state.snapshot_at === 'string');
    assert.ok(out.mind_state.snapshot_at !== prevState.snapshot_at);
  });

  test('A6.R3: recomputeFromSubstrate output validates as a fresh mind_state', () => {
    const fakeState = {
      queryActions: () => []
    };
    const out = mindState.recomputeFromSubstrate(fakeState, { user_id: 'u' });
    const v = mindState.validate(out.mind_state);
    assert.ok(v.ok, 'recomputed state must validate, got: ' + JSON.stringify(v.errors));
  });

  test('A6.R4: recomputeFromSubstrate folds mind_decision events into project.key_decisions', () => {
    const prevSnapshotId = '019dd913-0000-7000-8000-000000000001';
    const prevTs = 1714000000000;
    const prevState = mindState.emptyMindState('alex');
    prevState.snapshot_at = '2026-04-25T00:00:00.000Z';
    prevState.active_projects = [
      { id: 'gc', name: 'troth v11', stage: 'design',
        key_decisions: [],
        open_questions: [], constraints: [], collaborators: [] },
      { id: 'ar', name: 'atlasforge', stage: 'GTM',
        key_decisions: [{ decision_id: 'pre-existing', summary: 'kept' }],
        open_questions: [], constraints: [], collaborators: [] }
    ];

    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') {
          return [{
            id: prevSnapshotId, timestamp: prevTs, type: 'mind_snapshot',
            agent_id: 'claude-code', cwd: '/tmp/test',
            input: JSON.stringify({ schema_version: '0.1' }),
            output: JSON.stringify({ mind_state: prevState }),
            verification: '{}', outcome: '{}'
          }];
        }
        if (type === 'intent') return [];
        if (type === 'decision') {
          return [
            {
              id: '019dd914-0000-7000-8000-000000000001',
              timestamp: prevTs + 1000,
              type: 'decision',
              agent_id: 'claude-code',
              cwd: '/tmp/test',
              input: JSON.stringify({
                kind: 'mind_decision',
                signals: {
                  project_id: 'gc',
                  summary: 'mind = working context, not persona',
                  rationale: 'persona is wrong frame'
                }
              }),
              output: JSON.stringify({ decision: 'recorded', reason: 'manual_capture' }),
              verification: '{}',
              outcome: '{}'
            },
            // Non-mind_decision rows must be ignored.
            {
              id: '019dd914-0000-7000-8000-000000000002',
              timestamp: prevTs + 2000,
              type: 'decision',
              agent_id: 'claude-code',
              cwd: '/tmp/test',
              input: JSON.stringify({
                kind: 'loopbreaker',
                signals: { hash: 'abc' }
              }),
              output: JSON.stringify({ decision: 'allow' }),
              verification: '{}',
              outcome: '{}'
            },
            {
              id: '019dd914-0000-7000-8000-000000000003',
              timestamp: prevTs + 3000,
              type: 'decision',
              agent_id: 'claude-code',
              cwd: '/tmp/test',
              input: JSON.stringify({
                kind: 'mind_decision',
                signals: {
                  project_id: 'ar',
                  summary: 'pivot to guided onboarding',
                  rationale: 'trial completion too low'
                }
              }),
              output: JSON.stringify({ decision: 'recorded', reason: 'manual_capture' }),
              verification: '{}',
              outcome: '{}'
            }
          ];
        }
        return [];
      }
    };

    const out = mindState.recomputeFromSubstrate(fakeState, { cwd: '/tmp/test' });
    assert.strictEqual(out.decisions_seen, 2, 'expected 2 mind_decision events folded in');

    const gc = out.mind_state.active_projects.find(p => p.id === 'gc');
    const ar = out.mind_state.active_projects.find(p => p.id === 'ar');
    // gc previously had no decisions; one was folded in.
    assert.strictEqual(gc.key_decisions.length, 1);
    assert.strictEqual(gc.key_decisions[0].summary, 'mind = working context, not persona');
    assert.strictEqual(gc.key_decisions[0].rationale, 'persona is wrong frame');
    // ar had pre-existing + one new fold-in.
    assert.strictEqual(ar.key_decisions.length, 2);
    assert.strictEqual(ar.key_decisions[0].decision_id, 'pre-existing');
    assert.strictEqual(ar.key_decisions[1].summary, 'pivot to guided onboarding');
  });

  test('A6.E1: hasMeaningfulChanges ignores snapshot_at-only deltas', () => {
    const a = mindState.emptyMindState('u');
    a.current_focus = 'thing';
    a.snapshot_at = '2026-04-29T20:00:00.000Z';
    const b = JSON.parse(JSON.stringify(a));
    b.snapshot_at = '2026-04-29T20:01:00.000Z';
    assert.strictEqual(mindState.hasMeaningfulChanges(a, b), false,
      'snapshot_at-only delta must NOT be a meaningful change');
  });

  test('A6.E2: hasMeaningfulChanges flags real deltas', () => {
    const a = mindState.emptyMindState('u');
    a.current_focus = 'thing';
    const b = JSON.parse(JSON.stringify(a));
    b.current_focus = 'something else';
    assert.strictEqual(mindState.hasMeaningfulChanges(a, b), true);

    const c = JSON.parse(JSON.stringify(a));
    c.active_projects = [{ id: 'p', name: 'P', stage: 'design' }];
    assert.strictEqual(mindState.hasMeaningfulChanges(a, c), true);
  });

  test('A6.E3: hasMeaningfulChanges treats missing prev as changed', () => {
    const b = mindState.emptyMindState('u');
    assert.strictEqual(mindState.hasMeaningfulChanges(null, b), true);
    assert.strictEqual(mindState.hasMeaningfulChanges(undefined, b), true);
  });

  test('A6.R6: recomputeFromSubstrate filters superseded decisions (reconsolidation)', () => {
    const prevState = mindState.emptyMindState('alex');
    prevState.snapshot_at = '2026-04-25T00:00:00.000Z';
    prevState.active_projects = [
      { id: 'gc', name: 'GC', stage: 'design',
        key_decisions: [], open_questions: [], constraints: [], collaborators: [] }
    ];

    const oldDecisionId = '019dd920-0000-7000-8000-000000000001';
    const newDecisionId = '019dd920-0000-7000-8000-000000000002';

    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') {
          return [{
            id: '019dd920-0000-7000-8000-aaaaaaaaaaaa',
            timestamp: 1714000000000,
            type: 'mind_snapshot',
            agent_id: 'a', cwd: '/tmp/r6',
            input: JSON.stringify({ schema_version: '0.1' }),
            output: JSON.stringify({ mind_state: prevState }),
            verification: '{}', outcome: '{}'
          }];
        }
        if (type === 'decision') {
          return [
            // Old decision — captured manually
            {
              id: oldDecisionId,
              timestamp: 1714000001000,
              type: 'decision',
              agent_id: 'cli', cwd: '/tmp/r6',
              input: JSON.stringify({
                kind: 'mind_decision',
                signals: { project_id: 'gc', summary: 'use Auth0 for auth', rationale: 'fastest path' }
              }),
              output: JSON.stringify({ decision: 'recorded', reason: 'manual_capture' }),
              verification: '{}', outcome: '{}'
            },
            // New decision — supersedes the old one
            {
              id: newDecisionId,
              timestamp: 1714000002000,
              type: 'decision',
              agent_id: 'cli', cwd: '/tmp/r6',
              input: JSON.stringify({
                kind: 'mind_decision',
                signals: {
                  project_id: 'gc',
                  summary: 'migrate to NextAuth',
                  rationale: 'Auth0 cost too high',
                  supersedes: [oldDecisionId]
                }
              }),
              output: JSON.stringify({ decision: 'recorded', reason: 'manual_capture' }),
              verification: '{}', outcome: '{}'
            }
          ];
        }
        return [];
      }
    };

    const out = mindState.recomputeFromSubstrate(fakeState, { cwd: '/tmp/r6' });
    const gc = out.mind_state.active_projects.find(p => p.id === 'gc');
    // Only the live one should surface; the superseded Auth0 decision
    // is filtered out at view time even though it remains in substrate.
    assert.strictEqual(gc.key_decisions.length, 1,
      'expected exactly the live decision after reconsolidation; got: ' +
      JSON.stringify(gc.key_decisions));
    assert.strictEqual(gc.key_decisions[0].decision_id, newDecisionId);
    assert.strictEqual(gc.key_decisions[0].summary, 'migrate to NextAuth');
  });

  test('A6.SC1: scoreDecisionSalience: brand-new unused → near 1.0', () => {
    const now = 1714000000000;
    const s = mindState.scoreDecisionSalience({
      recorded_at: now, retrievalCount: 0, now
    });
    // Age 0 → recency_bonus = 1, retrievals 0 → ln(1) = 0
    assert.ok(s >= 0.99 && s <= 1.01, 'expected ~1.0, got: ' + s);
  });

  test('A6.SC2: scoreDecisionSalience: usage keeps old decisions alive', () => {
    const now = 1714000000000;
    const dayMs = 24 * 60 * 60 * 1000;
    const oldStale = mindState.scoreDecisionSalience({
      recorded_at: now - 60 * dayMs, retrievalCount: 0, now
    });
    const oldUsed = mindState.scoreDecisionSalience({
      recorded_at: now - 60 * dayMs, retrievalCount: 50, now
    });
    assert.ok(oldStale < 0.05, 'old + unused should drop near 0, got: ' + oldStale);
    assert.ok(oldUsed > 3, 'old + heavily-used should stay > 3, got: ' + oldUsed);
  });

  test('A6.SC3: scoreDecisionSalience: recent + unused beats old + unused', () => {
    const now = 1714000000000;
    const dayMs = 24 * 60 * 60 * 1000;
    const recent = mindState.scoreDecisionSalience({ recorded_at: now - dayMs, retrievalCount: 0, now });
    const old    = mindState.scoreDecisionSalience({ recorded_at: now - 45 * dayMs, retrievalCount: 0, now });
    assert.ok(recent > old, 'recent > old when both unused');
  });

  test('A6.ST1: getSalienceTopK: empty substrate returns empty array', () => {
    const fakeState = { queryActions: () => [] };
    const out = mindState.getSalienceTopK(fakeState, { cwd: '/x', k: 10 });
    assert.deepStrictEqual(out, []);
  });

  test('A6.ST2: getSalienceTopK: sorts desc by salience and respects k cap', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const decisionRows = [];
    for (let i = 0; i < 5; i++) {
      decisionRows.push({
        id: '019ddc01-0000-7000-8000-' + String(i).padStart(12, '0'),
        timestamp: i === 0 ? now - 50 : now - 20 * dayMs - i * 1000, // d0 = brand-new, others old
        type: 'decision', agent_id: 'cli', cwd: '/tmp/st',
        input: JSON.stringify({
          kind: 'mind_decision',
          signals: { project_id: 'gc', summary: 'd' + i, rationale: '' }
        }),
        output: '{}', verification: '{}', outcome: '{}'
      });
    }
    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') return [];
        if (type === 'decision') return decisionRows;
        return [];
      }
    };
    const top3 = mindState.getSalienceTopK(fakeState, { cwd: '/tmp/st', k: 3 });
    assert.strictEqual(top3.length, 3, 'k cap honored');
    assert.strictEqual(top3[0].summary, 'd0', 'most-recent d0 ranks first');
    for (let i = 0; i < top3.length - 1; i++) {
      assert.ok(top3[i].salience >= top3[i + 1].salience, 'desc sort');
    }
  });

  test('A6.ST3: getSalienceTopK: filters superseded decisions', () => {
    const now = Date.now();
    const decisionRows = [
      { id: '019ddc02-0000-7000-8000-aaaaaaaaaaaa', timestamp: now - 5000,
        type: 'decision', agent_id: 'cli', cwd: '/tmp/st3',
        input: JSON.stringify({ kind: 'mind_decision',
          signals: { project_id: 'p', summary: 'old approach' } }),
        output: '{}', verification: '{}', outcome: '{}' },
      { id: '019ddc02-0000-7000-8000-bbbbbbbbbbbb', timestamp: now - 1000,
        type: 'decision', agent_id: 'cli', cwd: '/tmp/st3',
        input: JSON.stringify({ kind: 'mind_decision',
          signals: { project_id: 'p', summary: 'new approach',
                     supersedes: ['019ddc02-0000-7000-8000-aaaaaaaaaaaa'] } }),
        output: '{}', verification: '{}', outcome: '{}' }
    ];
    const fakeState = {
      queryActions: ({ type }) => type === 'decision' ? decisionRows : []
    };
    const top = mindState.getSalienceTopK(fakeState, { cwd: '/tmp/st3', k: 10 });
    assert.strictEqual(top.length, 1, 'superseded one filtered out');
    assert.strictEqual(top[0].summary, 'new approach');
  });

  test('A6.ST4: getSalienceTopK: resolves project_name from latest snapshot', () => {
    const now = Date.now();
    const snapshot = {
      schema_version: '0.1', snapshot_at: new Date().toISOString(), user_id: 'u',
      active_projects: [{ id: 'gc', name: 'troth v11', stage: 'design',
        key_decisions: [], open_questions: [], constraints: [], collaborators: [] }]
    };
    const decisionRows = [{
      id: '019ddc03-0000-7000-8000-cccccccccccc', timestamp: now - 1000,
      type: 'decision', agent_id: 'cli', cwd: '/tmp/st4',
      input: JSON.stringify({ kind: 'mind_decision',
        signals: { project_id: 'gc', summary: 's' } }),
      output: '{}', verification: '{}', outcome: '{}'
    }];
    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') return [{
          id: '019ddc03-0000-7000-8000-dddddddddddd', timestamp: now - 100,
          type: 'mind_snapshot', agent_id: 'a', cwd: '/tmp/st4',
          input: '{}', output: JSON.stringify({ mind_state: snapshot }),
          verification: '{}', outcome: '{}'
        }];
        if (type === 'decision') return decisionRows;
        return [];
      }
    };
    const top = mindState.getSalienceTopK(fakeState, { cwd: '/tmp/st4', k: 5 });
    assert.strictEqual(top.length, 1);
    assert.strictEqual(top[0].project_name, 'troth v11');
    assert.strictEqual(top[0].project_id, 'gc');
    assert.strictEqual(top[0].retrievalCount, 0);
  });

  test('A6.R8: recompute sorts decisions by salience and retains used over fresh', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const prevState = mindState.emptyMindState('u');
    prevState.snapshot_at = '2026-04-25T00:00:00.000Z';
    prevState.active_projects = [
      { id: 'gc', name: 'GC', stage: 's',
        key_decisions: [], open_questions: [], constraints: [], collaborators: [] }
    ];

    // 12 decisions, all on project gc:
    //   decisions 0..9 are old (40 days)
    //   decision 0 is the highest-retrieval one (proxy via retrieval-events for 'gc')
    //   decisions 10..11 are brand-new
    // With cap=10, naive recency sort would evict 0..1; salience sort
    // should evict the OLD UNUSED MIDDLE ones and keep highly-retrieved
    // old + recent.
    const decisionRows = [];
    for (let i = 0; i < 12; i++) {
      const tsRecorded = i < 10
        ? now - 40 * dayMs - (i * 1000)  // old
        : now - 60 * 1000 + (i * 1000);  // recent
      decisionRows.push({
        id: '019dd930-0000-7000-8000-' + String(i).padStart(12, '0'),
        timestamp: tsRecorded,
        type: 'decision',
        agent_id: 'cli', cwd: '/tmp/r8',
        input: JSON.stringify({
          kind: 'mind_decision',
          signals: { project_id: 'gc', summary: 'd' + i, rationale: '' }
        }),
        output: JSON.stringify({ decision: 'recorded', reason: 'manual_capture' }),
        verification: '{}', outcome: '{}'
      });
    }
    // Many retrieval-events for gc within decay window — boost gc usage.
    const retrievalRows = [];
    for (let r = 0; r < 50; r++) {
      retrievalRows.push({
        id: '019dd931-0000-7000-8000-' + String(r).padStart(12, '0'),
        timestamp: now - r * 1000,
        type: 'decision',
        agent_id: 'mcp', cwd: '/tmp/r8',
        input: JSON.stringify({
          kind: 'mind_retrieval',
          signals: { snapshot_id: 'sx', project_ids: ['gc'] }
        }),
        output: JSON.stringify({ decision: 'retrieved', reason: 'mind_surface' }),
        verification: '{}', outcome: '{}'
      });
    }

    const fakeState = {
      queryActions: ({ type, since }) => {
        if (type === 'mind_snapshot') return [{
          id: '019dd932-0000-7000-8000-aaaaaaaaaaaa',
          timestamp: now - 40 * dayMs - 100000,
          type: 'mind_snapshot',
          agent_id: 'a', cwd: '/tmp/r8',
          input: JSON.stringify({ schema_version: '0.1' }),
          output: JSON.stringify({ mind_state: prevState }),
          verification: '{}', outcome: '{}'
        }];
        if (type === 'decision') {
          // Recompute fetches decisions twice (mind_decisions + retrieval-events).
          // Both calls hit this branch; merge both rowsets so the test
          // simulates a substrate that has BOTH kinds of records.
          return decisionRows.concat(retrievalRows);
        }
        return [];
      }
    };

    const out = mindState.recomputeFromSubstrate(fakeState, { cwd: '/tmp/r8' });
    const gc = out.mind_state.active_projects.find(p => p.id === 'gc');
    assert.strictEqual(gc.key_decisions.length, 10, 'cap should hold');
    // With heavy retrieval boost for gc, the salience score on EVERY
    // gc decision gets +ln(50+1)=~3.93. Recent ones additionally have
    // +1 recency_bonus. Old unused ones have ~3.93 (just usage). All
    // 12 decisions are highly salient; top 10 by salience kept.
    // Specifically: the 2 RECENT decisions (d10, d11) must survive.
    const summaries = gc.key_decisions.map(d => d.summary);
    assert.ok(summaries.includes('d10'), 'recent d10 must survive: ' + summaries.join(','));
    assert.ok(summaries.includes('d11'), 'recent d11 must survive: ' + summaries.join(','));
  });

  test('A6.D6: distillProject builds prompt + parses driver response', async () => {
    let capturedPrompt = null;
    const driver = async ({ prompt, project_id }) => {
      capturedPrompt = prompt;
      assert.strictEqual(project_id, 'gc');
      return 'Project mind protocol pivoted from local LoRA to working-context portability.';
    };
    const result = await mindState.distillProject({
      project: { id: 'gc', name: 'troth v11', stage: 'design', current_focus: 'mind protocol' },
      decisions: [
        { decision_id: 'd1', summary: 'rejected local LoRA', rationale: 'dumb gatekeeper' },
        { decision_id: 'd2', summary: 'mind = working context', rationale: 'persona is wrong frame' }
      ],
      intents: [
        { goal: 'design v0.2 reconsolidation' }
      ],
      driver
    });
    assert.ok(result.ok, 'expected ok=true, got: ' + JSON.stringify(result));
    assert.ok(result.summary.startsWith('Project mind protocol'));
    assert.deepStrictEqual(result.used_decision_ids, ['d1', 'd2']);
    assert.ok(capturedPrompt.includes('rejected local LoRA'),
      'prompt must include decision summaries');
    assert.ok(capturedPrompt.includes('mind = working context'));
    assert.ok(capturedPrompt.includes('design v0.2 reconsolidation'));
  });

  test('A6.D7: distillProject refuses with no signal', async () => {
    const result = await mindState.distillProject({
      project: { id: 'gc', name: 'troth v11' },
      decisions: [],
      intents: [],
      driver: async () => 'unused'
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no_signal');
  });

  test('A6.D8: distillProject refuses without driver', async () => {
    const result = await mindState.distillProject({
      project: { id: 'gc', name: 'troth v11' },
      decisions: [{ decision_id: 'd1', summary: 's' }],
      intents: []
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no_driver');
  });

  test('A6.D9: distillProject surfaces driver failure as reason', async () => {
    const result = await mindState.distillProject({
      project: { id: 'gc', name: 'troth v11' },
      decisions: [{ decision_id: 'd1', summary: 's' }],
      intents: [],
      driver: async () => { throw new Error('boom'); }
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'driver_threw');
    assert.ok(result.detail.includes('boom'));
  });

  test('A6.B4: buildDistillationEventRecord produces a valid type=decision record', () => {
    const AR = require('../shared-core/action-record');
    const built = mindState.buildDistillationEventRecord({
      id: '019dd934-0000-7000-8000-000000000001',
      timestamp: 1714000000000,
      agent_id: 'distill',
      cwd: '/tmp/d',
      project_id: 'gc',
      summary: 'Distilled summary text.',
      used_decision_ids: ['d1', 'd2']
    });
    assert.ok(built.ok);
    const v = AR.validate(built.record);
    assert.ok(v.ok, 'validation: ' + JSON.stringify(v.errors));
    assert.strictEqual(built.record.input.kind, 'mind_distillation');
    assert.strictEqual(built.record.input.signals.project_id, 'gc');
    assert.deepStrictEqual(built.record.input.signals.used_decision_ids, ['d1', 'd2']);
    assert.strictEqual(built.record.output.summary, 'Distilled summary text.');
  });

  test('A6.R9: recompute surfaces latest distillation as project.distilled_summary', () => {
    const now = Date.now();
    const prevState = mindState.emptyMindState('u');
    prevState.snapshot_at = '2026-04-25T00:00:00.000Z';
    prevState.active_projects = [
      { id: 'gc', name: 'GC', stage: 's',
        key_decisions: [], open_questions: [], constraints: [], collaborators: [] }
    ];

    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') return [{
          id: '019dd935-0000-7000-8000-aaaaaaaaaaaa',
          timestamp: now - 10 * 60 * 1000,
          type: 'mind_snapshot',
          agent_id: 'a', cwd: '/tmp/r9',
          input: JSON.stringify({ schema_version: '0.1' }),
          output: JSON.stringify({ mind_state: prevState }),
          verification: '{}', outcome: '{}'
        }];
        if (type === 'decision') {
          return [
            // Older distillation
            {
              id: '019dd935-0000-7000-8000-000000000001',
              timestamp: now - 5 * 60 * 1000,
              type: 'decision',
              agent_id: 'distill', cwd: '/tmp/r9',
              input: JSON.stringify({
                kind: 'mind_distillation',
                signals: { project_id: 'gc', used_decision_ids: [] }
              }),
              output: JSON.stringify({ decision: 'distilled', reason: 'scheduled', summary: 'OLD summary' }),
              verification: '{}', outcome: '{}'
            },
            // Newer — should win
            {
              id: '019dd935-0000-7000-8000-000000000002',
              timestamp: now - 60 * 1000,
              type: 'decision',
              agent_id: 'distill', cwd: '/tmp/r9',
              input: JSON.stringify({
                kind: 'mind_distillation',
                signals: { project_id: 'gc', used_decision_ids: [] }
              }),
              output: JSON.stringify({ decision: 'distilled', reason: 'scheduled', summary: 'NEW summary' }),
              verification: '{}', outcome: '{}'
            }
          ];
        }
        return [];
      }
    };

    const out = mindState.recomputeFromSubstrate(fakeState, { cwd: '/tmp/r9' });
    const gc = out.mind_state.active_projects.find(p => p.id === 'gc');
    assert.strictEqual(gc.distilled_summary, 'NEW summary',
      'newest distillation should win, got: ' + gc.distilled_summary);
    assert.strictEqual(gc.distillation_id, '019dd935-0000-7000-8000-000000000002');
    assert.ok(typeof gc.distilled_at === 'string');
  });

  test('A6.AR1: buildArchiveEventRecord shapes a valid type=decision record', () => {
    const AR = require('../shared-core/action-record');
    const built = mindState.buildArchiveEventRecord({
      id: '019dd940-0000-7000-8000-000000000001',
      timestamp: 1714000000000,
      agent_id: 'cli',
      cwd: '/tmp/ar1',
      archived_snapshot_id: '019dd940-0000-7000-8000-000000000999',
      reason: 'compact'
    });
    assert.ok(built.ok);
    const v = AR.validate(built.record);
    assert.ok(v.ok, 'archive event must validate, got: ' + JSON.stringify(v.errors));
    assert.strictEqual(built.record.input.kind, 'mind_archive');
    assert.strictEqual(built.record.input.signals.archived_snapshot_id, '019dd940-0000-7000-8000-000000000999');
    assert.strictEqual(built.record.output.decision, 'archived');
  });

  test('A6.AR2: buildArchiveEventRecord refuses without archived_snapshot_id', () => {
    const built = mindState.buildArchiveEventRecord({});
    assert.strictEqual(built.ok, false);
    assert.ok(Array.isArray(built.errors));
  });

  test('A6.AR3: getArchivedSnapshotIds returns only mind_archive entries', () => {
    const fakeState = {
      queryActions: () => ([
        // Archive entry
        {
          id: 'a1', timestamp: 1, type: 'decision', agent_id: 'cli', cwd: '/tmp/x',
          input: JSON.stringify({ kind: 'mind_archive', signals: { archived_snapshot_id: 'snap-1' } }),
          output: JSON.stringify({ decision: 'archived' }), verification: '{}', outcome: '{}'
        },
        // Non-archive decision (should be ignored)
        {
          id: 'a2', timestamp: 2, type: 'decision', agent_id: 'cli', cwd: '/tmp/x',
          input: JSON.stringify({ kind: 'mind_decision', signals: { project_id: 'p', summary: 's' } }),
          output: JSON.stringify({ decision: 'recorded' }), verification: '{}', outcome: '{}'
        },
        // Another archive
        {
          id: 'a3', timestamp: 3, type: 'decision', agent_id: 'cli', cwd: '/tmp/x',
          input: JSON.stringify({ kind: 'mind_archive', signals: { archived_snapshot_id: 'snap-2' } }),
          output: JSON.stringify({ decision: 'archived' }), verification: '{}', outcome: '{}'
        }
      ])
    };
    const ids = mindState.getArchivedSnapshotIds(fakeState, '/tmp/x');
    assert.strictEqual(ids.size, 2);
    assert.ok(ids.has('snap-1'));
    assert.ok(ids.has('snap-2'));
  });

  test('A6.B3: buildRetrievalEventRecord shapes a valid type=decision record', () => {
    const AR = require('../shared-core/action-record');
    const ev = mindState.buildRetrievalEventRecord({
      id: '019dd933-0000-7000-8000-000000000001',
      timestamp: 1714000000000,
      agent_id: 'claude-code',
      cwd: '/tmp/test',
      snapshot_id: '019dd933-0000-7000-8000-aaaaaaaaaaaa',
      project_ids: ['gc', 'ar'],
      reason: 'mind_load_orientation'
    });
    const v = AR.validate(ev);
    assert.ok(v.ok, 'expected valid ActionRecord, got: ' + JSON.stringify(v.errors));
    assert.strictEqual(ev.type, 'decision');
    assert.strictEqual(ev.input.kind, 'mind_retrieval');
    assert.deepStrictEqual(ev.input.signals.project_ids, ['gc', 'ar']);
    assert.strictEqual(ev.input.signals.snapshot_id, '019dd933-0000-7000-8000-aaaaaaaaaaaa');
    assert.strictEqual(ev.output.decision, 'retrieved');
    assert.strictEqual(ev.output.reason, 'mind_load_orientation');
  });

  test('A6.R7: supersedes filters work transitively through chains', () => {
    const prevState = mindState.emptyMindState('u');
    prevState.snapshot_at = '2026-04-25T00:00:00.000Z';
    prevState.active_projects = [
      { id: 'p', name: 'P', stage: 's',
        key_decisions: [], open_questions: [], constraints: [], collaborators: [] }
    ];
    const ids = [
      '019dd921-0000-7000-8000-000000000001',
      '019dd921-0000-7000-8000-000000000002',
      '019dd921-0000-7000-8000-000000000003'
    ];
    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') return [{
          id: '019dd921-0000-7000-8000-aaaaaaaaaaaa',
          timestamp: 1714000000000,
          type: 'mind_snapshot',
          agent_id: 'a', cwd: '/tmp/r7',
          input: JSON.stringify({ schema_version: '0.1' }),
          output: JSON.stringify({ mind_state: prevState }),
          verification: '{}', outcome: '{}'
        }];
        if (type === 'decision') {
          return ids.map((id, i) => ({
            id,
            timestamp: 1714000001000 + i,
            type: 'decision',
            agent_id: 'cli', cwd: '/tmp/r7',
            input: JSON.stringify({
              kind: 'mind_decision',
              signals: {
                project_id: 'p',
                summary: 'd' + i,
                rationale: '',
                // d1 supersedes d0; d2 supersedes d1
                supersedes: i === 0 ? [] : [ids[i - 1]]
              }
            }),
            output: JSON.stringify({ decision: 'recorded', reason: 'manual_capture' }),
            verification: '{}', outcome: '{}'
          }));
        }
        return [];
      }
    };
    const out = mindState.recomputeFromSubstrate(fakeState, { cwd: '/tmp/r7' });
    const p = out.mind_state.active_projects.find(x => x.id === 'p');
    // Only d2 is alive — d0 superseded by d1, d1 superseded by d2.
    assert.strictEqual(p.key_decisions.length, 1, 'expected only the terminal-live decision');
    assert.strictEqual(p.key_decisions[0].summary, 'd2');
  });

  test('A6.R5: recomputeFromSubstrate caps key_decisions per project at MAX (salience)', () => {
    const now = Date.now();
    const prevState = mindState.emptyMindState('u');
    prevState.snapshot_at = '2026-04-25T00:00:00.000Z';
    prevState.active_projects = [
      { id: 'gc', name: 'GC', stage: 's', key_decisions: [], open_questions: [], constraints: [], collaborators: [] }
    ];
    // 15 mind_decision events spaced 1 minute apart, all recent so the
    // recency_bonus differs meaningfully across them. With usage=0 for
    // every decision, salience reduces to recency_bonus → sorted desc =
    // newest first. Cap=10 keeps the 10 most-recent (d5..d14).
    const decisionRows = [];
    for (let i = 0; i < 15; i++) {
      decisionRows.push({
        id: '019dd915-0000-7000-8000-' + String(i).padStart(12, '0'),
        timestamp: now - (15 - i) * 60 * 1000,
        type: 'decision',
        agent_id: 'a',
        cwd: '/tmp/cap',
        input: JSON.stringify({
          kind: 'mind_decision',
          signals: { project_id: 'gc', summary: 'd' + i, rationale: '' }
        }),
        output: JSON.stringify({ decision: 'recorded', reason: 'manual_capture' }),
        verification: '{}',
        outcome: '{}'
      });
    }
    const fakeState = {
      queryActions: ({ type }) => {
        if (type === 'mind_snapshot') return [{
          id: '019dd915-0000-7000-8000-aaaaaaaaaaaa',
          timestamp: now - 16 * 60 * 1000,
          type: 'mind_snapshot',
          agent_id: 'a', cwd: '/tmp/cap',
          input: JSON.stringify({ schema_version: '0.1' }),
          output: JSON.stringify({ mind_state: prevState }),
          verification: '{}', outcome: '{}'
        }];
        if (type === 'decision') return decisionRows;
        return [];
      }
    };
    const out = mindState.recomputeFromSubstrate(fakeState, { cwd: '/tmp/cap' });
    const gc = out.mind_state.active_projects.find(p => p.id === 'gc');
    // Cap holds at MAX=10.
    assert.strictEqual(gc.key_decisions.length, 10);
    // Salience sort with usage=0 → newest 10 kept. d0..d4 evicted.
    const summaries = gc.key_decisions.map(d => d.summary).sort();
    assert.deepStrictEqual(summaries, ['d10','d11','d12','d13','d14','d5','d6','d7','d8','d9']);
    // Most-recent decision (d14) sits at top of the list (highest recency).
    assert.strictEqual(gc.key_decisions[0].summary, 'd14');
  });

  // ── shapeForTask (Q3 hot/cold) ──────────────────────────────────────────
  function multiProjectState() {
    const ms = mindState.emptyMindState('alex');
    ms.current_focus = 'multi-project shaping test';
    ms.active_projects = [
      {
        id: 'gc', name: 'troth v11', stage: 'design', current_focus: 'paper done',
        audience: 'developers',
        key_decisions: [{ decision_id: 'd1', summary: 'mind = working context' }],
        open_questions: ['decay strategy'],
        constraints: ['no persona override'],
        collaborators: [{ who: 'operator', role: 'lead' }]
      },
      {
        id: 'ar', name: 'atlasforge', stage: 'GTM', current_focus: 'demo prep',
        audience: 'small studios',
        key_decisions: [{ decision_id: 'd2', summary: 'pivot to guided onboarding' }],
        open_questions: ['v6 mind integration timing'],
        constraints: ['no vendor logos in exports'],
        collaborators: []
      }
    ];
    return ms;
  }

  test('A6.S1: shapeForTask with no task_signature keeps all projects hot', () => {
    const ms = multiProjectState();
    const out = mindState.shapeForTask(ms, null);
    assert.strictEqual(out.shape_info.hot_projects, 2);
    assert.strictEqual(out.shape_info.cold_projects, 0);
    assert.strictEqual(out.shape_info.matched, false);
    // Hot projects keep full detail.
    assert.ok(Array.isArray(out.mind_state.active_projects[0].key_decisions));
    assert.ok(out.mind_state.active_projects[0].key_decisions.length === 1);
    assert.ok(!out.mind_state.active_projects[0]._cold);
    assert.ok(!out.mind_state.active_projects[1]._cold);
  });

  test('A6.S2: shapeForTask with matching project_id makes that one HOT and others COLD', () => {
    const ms = multiProjectState();
    const out = mindState.shapeForTask(ms, { project_id: 'gc', domain: 'code', subgoal: 'spec' });
    assert.strictEqual(out.shape_info.hot_projects, 1);
    assert.strictEqual(out.shape_info.cold_projects, 1);
    assert.strictEqual(out.shape_info.matched, true);

    const gc = out.mind_state.active_projects.find(p => p.id === 'gc');
    const ar = out.mind_state.active_projects.find(p => p.id === 'ar');
    // gc hot — full detail preserved
    assert.ok(Array.isArray(gc.key_decisions) && gc.key_decisions.length === 1);
    assert.ok(Array.isArray(gc.collaborators));
    assert.ok(!gc._cold);
    // ar cold — detail stripped, _cold marker set
    assert.strictEqual(ar._cold, true);
    assert.strictEqual(ar.key_decisions, undefined);
    assert.strictEqual(ar.open_questions, undefined);
    assert.strictEqual(ar.constraints, undefined);
    assert.strictEqual(ar.collaborators, undefined);
    // Skeleton fields present
    assert.strictEqual(ar.id, 'ar');
    assert.strictEqual(ar.name, 'atlasforge');
    assert.strictEqual(ar.stage, 'GTM');
    assert.strictEqual(ar.current_focus, 'demo prep');
  });

  test('A6.S3: shapeForTask with a non-matching project_id collapses every project to cold', () => {
    const ms = multiProjectState();
    const out = mindState.shapeForTask(ms, { project_id: 'unknown-project' });
    // No match → no project gets the matched-flag, so all stay hot per
    // the v0.1 rule (matched=false in shape_info).
    assert.strictEqual(out.shape_info.matched, false);
    assert.strictEqual(out.shape_info.hot_projects, 0);
    assert.strictEqual(out.shape_info.cold_projects, 2);
    // All projects collapse to cold form when targeted but unmatched —
    // the user expressed an intent to focus on something specific that
    // isn't here. Keeping everything hot would defeat the targeting.
    for (const p of out.mind_state.active_projects) {
      assert.strictEqual(p._cold, true);
    }
  });

  test('A6.S4: shapeForTask does not mutate the input state', () => {
    const ms = multiProjectState();
    const originalLength = ms.active_projects[1].key_decisions.length;
    const out = mindState.shapeForTask(ms, { project_id: 'gc' });
    // The input state's ar project still has its decisions.
    assert.strictEqual(ms.active_projects[1].key_decisions.length, originalLength);
    assert.ok(!ms.active_projects[1]._cold);
    // The output's ar is the cold form.
    const outAr = out.mind_state.active_projects.find(p => p.id === 'ar');
    assert.strictEqual(outAr._cold, true);
  });

  test('A6.S5: shapeForTask suppresses cross-scope current_intent', () => {
    // Live bug we hit: mind_surface returned an intent recorded under a
    // DIFFERENT project, contaminating the requesting task's context. The
    // shape pass must drop intents that do not match the requested scope.
    const ms = multiProjectState();
    ms.current_intent = {
      what: 'unrelated-task',
      why: 'from another conversation',
      task_signature: { project_id: 'ar', domain: 'ops' }
    };
    const out = mindState.shapeForTask(ms, { project_id: 'gc', domain: 'code' });
    assert.strictEqual(out.mind_state.current_intent, null,
      'cross-scope intent must be filtered out');
    assert.strictEqual(out.shape_info.intent_scope_filtered, true,
      'shape_info must flag the suppression so callers can detect it');
    // Input must remain untouched.
    assert.ok(ms.current_intent && ms.current_intent.what === 'unrelated-task');
  });

  test('A6.S6: shapeForTask preserves matching-scope current_intent', () => {
    const ms = multiProjectState();
    ms.current_intent = {
      what: 'paper draft',
      why: 'design work',
      task_signature: { project_id: 'gc', domain: 'design' }
    };
    const out = mindState.shapeForTask(ms, { project_id: 'gc', domain: 'design' });
    assert.ok(out.mind_state.current_intent,
      'matching-scope intent must be preserved');
    assert.strictEqual(out.mind_state.current_intent.what, 'paper draft');
    assert.strictEqual(out.shape_info.intent_scope_filtered, false);
  });

  test('A6.S7: shapeForTask preserves current_intent when no project scope is requested', () => {
    // Without a target project the shape pass has no basis to filter.
    // Cross-scope detection only applies when the caller asked for a scope.
    const ms = multiProjectState();
    ms.current_intent = {
      what: 'general work',
      task_signature: { project_id: 'ar' }
    };
    const out = mindState.shapeForTask(ms, null);
    assert.ok(out.mind_state.current_intent,
      'no-scope request must not filter intents');
    assert.strictEqual(out.shape_info.intent_scope_filtered, false);
  });

  // ── deriveTaskSignature heuristic ───────────────────────────────────────
  test('A6.D1: deriveTaskSignature returns null for empty inputs', () => {
    assert.strictEqual(mindState.deriveTaskSignature('', multiProjectState()), null);
    assert.strictEqual(mindState.deriveTaskSignature('whatever', null), null);
    assert.strictEqual(mindState.deriveTaskSignature('whatever',
      mindState.emptyMindState('u')), null);
  });

  test('A6.D2: deriveTaskSignature picks the project whose name appears in prompt', () => {
    const ms = multiProjectState();
    const sig = mindState.deriveTaskSignature(
      'lets work on the marketing copy for atlasforge landing page', ms
    );
    assert.ok(sig);
    assert.strictEqual(sig.project_id, 'ar');
    assert.strictEqual(sig.domain, 'marketing');
    assert.ok(sig.subgoal.includes('marketing'));
  });

  test('A6.D3: deriveTaskSignature classifies coding domain by default', () => {
    const ms = multiProjectState();
    const sig = mindState.deriveTaskSignature(
      'debug the troth v11 paging code', ms
    );
    assert.ok(sig);
    assert.strictEqual(sig.project_id, 'gc');
    assert.strictEqual(sig.domain, 'code');
  });

  test('A6.D4: deriveTaskSignature returns null when no project name overlaps', () => {
    const ms = multiProjectState();
    const sig = mindState.deriveTaskSignature(
      'plant tomatoes in the garden', ms
    );
    assert.strictEqual(sig, null);
  });

  test('A6.X1: findCrossProjectRelevance returns empty when no overlap', () => {
    const ms = multiProjectState();
    const hits = mindState.findCrossProjectRelevance({
      mind_state: ms,
      current_project_id: 'gc',
      message: 'plant tomatoes in the garden'
    });
    assert.deepStrictEqual(hits, []);
  });

  test('A6.X2: findCrossProjectRelevance excludes the current project', () => {
    const ms = multiProjectState();
    // gc has decision "mind = working context" with token overlap to
    // "working context strategy"; current_project_id=gc should exclude it.
    const hits = mindState.findCrossProjectRelevance({
      mind_state: ms,
      current_project_id: 'gc',
      message: 'mind working context strategy'
    });
    for (const h of hits) {
      assert.notStrictEqual(h.project_id, 'gc');
    }
  });

  test('A6.X3: findCrossProjectRelevance surfaces decisions from other projects', () => {
    const ms = multiProjectState();
    const hits = mindState.findCrossProjectRelevance({
      mind_state: ms,
      current_project_id: 'gc', // working on gc, looking for cross-pollination from ar
      message: 'plan the guided onboarding onboarding workflow for atlasforge'
    });
    assert.ok(hits.length >= 1, 'expected cross-project hits, got none');
    const ar = hits.find(h => h.project_id === 'ar');
    assert.ok(ar, 'ar project should appear in hits');
    const summaries = ar.hits.map(h => h.text).join(' | ');
    assert.ok(summaries.includes('guided onboarding'),
      'expected ar decision about guided onboarding to surface; got: ' + summaries);
  });

  test('A6.X4: findCrossProjectRelevance topK + minOverlap honored', () => {
    const ms = multiProjectState();
    const hits = mindState.findCrossProjectRelevance({
      mind_state: ms,
      current_project_id: null,
      message: 'mind context working',
      topK: 1,
      minOverlap: 1
    });
    assert.ok(hits.length <= 1, 'topK=1 enforced');
  });

  test('A6.X5: formatCrossProjectRelevance produces a readable snippet', () => {
    const fake = [{
      project_id: 'p1', project_name: 'Project One', max_overlap: 3,
      hits: [
        { kind: 'decision', text: 'do X because Y', overlap: 3 },
        { kind: 'open_question', text: 'is Z still relevant?', overlap: 2 }
      ]
    }];
    const out = mindState.formatCrossProjectRelevance(fake);
    assert.ok(out.includes('DMN push'));
    assert.ok(out.includes('Project One'));
    assert.ok(out.includes('decision'));
    assert.ok(out.includes('do X because Y'));
    assert.ok(out.includes('open question'));
    assert.ok(out.includes('is Z still relevant'));
  });

  test('A6.X6: formatCrossProjectRelevance returns empty for empty hits', () => {
    assert.strictEqual(mindState.formatCrossProjectRelevance([]), '');
    assert.strictEqual(mindState.formatCrossProjectRelevance(null), '');
  });

  test('A6.D5: deriveTaskSignature classifies testing domain on test keywords', () => {
    const ms = multiProjectState();
    const sig = mindState.deriveTaskSignature(
      'add unit test coverage for the troth substrate', ms
    );
    assert.ok(sig);
    assert.strictEqual(sig.project_id, 'gc');
    assert.strictEqual(sig.domain, 'testing');
  });

  // ── formatTopicShiftReorientation focused block ────────────────────────
  test('A6.O1: formatTopicShiftReorientation returns empty when nothing matched', () => {
    const ms = multiProjectState();
    const shaped = mindState.shapeForTask(ms, null); // no signature → nothing matched per shape_info
    const out = mindState.formatTopicShiftReorientation(shaped.mind_state, shaped.shape_info);
    assert.strictEqual(out, '');
  });

  test('A6.O2: formatTopicShiftReorientation produces focused block for matched project', () => {
    const ms = multiProjectState();
    const shaped = mindState.shapeForTask(ms, { project_id: 'gc' });
    const out = mindState.formatTopicShiftReorientation(shaped.mind_state, shaped.shape_info);
    assert.ok(typeof out === 'string' && out.length > 0);
    assert.ok(out.includes('Topic shift detected'));
    assert.ok(out.includes('troth v11'));
    assert.ok(out.includes('Recent decisions'));
    assert.ok(out.includes('mind = working context'));
    assert.ok(out.includes('Open questions'));
    assert.ok(out.includes('decay strategy'));
    assert.ok(out.includes('Constraints'));
    assert.ok(out.includes('no persona override'));
    // atlasforge must NOT appear since it's cold here.
    assert.ok(!out.includes('atlasforge'));
  });

  // ── Topic-shift detector (P5 / Q6) ──────────────────────────────────────
  const topicShift = require('../shared-core/topic-shift');

  test('A6.T1: cold start — no recent messages, no shift fires by default', () => {
    const out = topicShift.scoreTopicShift({
      current_message: 'let us start working on the marketing for atlasforge',
      recent_messages: []
    });
    assert.strictEqual(typeof out.score, 'number');
    // Empty window vs current → similarity 0 → embedding_drop = 1.
    // With default weights (0.6 emb, 0.4 intent), score = 0.6.
    // Default threshold raised to 0.7 after measured 57%
    // per-prompt fire rate in real workflow — cold-start no longer
    // fires noisily on every session boot. Caller can override.
    assert.strictEqual(out.fired, false);
    assert.strictEqual(out.intent_change_signal, 0);
    assert.ok(out.score >= 0.5 && out.score <= 0.7,
      'score should sit between old/new thresholds, got: ' + out.score);
  });

  test('A6.T2: same-topic continuation — no shift fires', () => {
    const out = topicShift.scoreTopicShift({
      current_message: 'continue working on the marketing copy for atlasforge',
      recent_messages: [
        'lets work on the marketing copy for atlasforge',
        'i think the headline needs work for the atlasforge marketing site',
        'the marketing message for atlasforge should emphasize automation'
      ]
    });
    assert.strictEqual(out.fired, false,
      'same-topic continuation must not fire (score=' + out.score + ')');
    // High similarity → low embedding_drop.
    assert.ok(out.embedding_drop < 0.5,
      'expected low embedding drop, got: ' + out.embedding_drop);
  });

  test('A6.T3: hard topic switch — high embedding drop signal', () => {
    const out = topicShift.scoreTopicShift({
      current_message: 'now lets debug the JWT race condition in the auth middleware',
      recent_messages: [
        'lets work on the marketing copy for atlasforge',
        'i think the headline needs work for the atlasforge marketing site',
        'the marketing message should emphasize automation'
      ]
    });
    // Embedding drop must register the topic switch (high value).
    assert.ok(out.embedding_drop >= 0.6,
      'expected high embedding drop, got: ' + out.embedding_drop);
    // With default weights (emb 0.6, intent 0.4) and intent_change=0
    // because no intent records were provided, embedding-only fires
    // only if drop > 0.833 (since 0.6 * 0.833 ≈ 0.5 = threshold).
    // Real-world topic shifts almost always co-occur with intent change,
    // so this is acceptable v0.1 behavior. This test asserts that the
    // mechanism produces the right SIGNAL even when the policy weights
    // hold off the trigger; T5 tests the combined-signal firing case.
    if (out.embedding_drop > 0.834) {
      assert.strictEqual(out.fired, true, 'high enough drop must fire alone');
    }
  });

  test('A6.T4: intent project_pointer change reinforces shift', () => {
    const out = topicShift.scoreTopicShift({
      current_message: 'next we work on auth',
      recent_messages: ['next we work on auth'],
      prev_intent:    { input: { project_pointer: 'atlasforge', goal: 'marketing' } },
      current_intent: { input: { project_pointer: 'troth',   goal: 'auth flow' } }
    });
    // Same text → embedding_drop ≈ 0; intent_change=1 → score = 0.4
    // Default threshold 0.5 → does NOT fire on intent alone.
    // This is intentional: weights say embedding carries main signal.
    assert.strictEqual(out.intent_change_signal, 1);
    assert.ok(out.score >= 0.39 && out.score <= 0.41,
      'expected score ~0.4 from intent alone, got: ' + out.score);
    assert.strictEqual(out.fired, false);
  });

  test('A6.T5: intent change + partial embedding drop crosses threshold', () => {
    const out = topicShift.scoreTopicShift({
      current_message: 'lets pivot to the auth flow now',
      recent_messages: [
        'atlasforge marketing copy needs polish',
        'one more pass on the marketing site copy'
      ],
      prev_intent:    { input: { project_pointer: 'atlasforge' } },
      current_intent: { input: { project_pointer: 'troth'   } }
    });
    // Embedding drop should be high-ish (different topic words),
    // intent_change=1 → score should comfortably exceed 0.5.
    assert.strictEqual(out.fired, true,
      'shift+partial-drop must fire (score=' + out.score + ')');
    assert.strictEqual(out.intent_change_signal, 1);
  });

  test('A6.T6: similarity override skips Jaccard and uses caller value', () => {
    const out = topicShift.scoreTopicShift({
      current_message: 'anything',
      recent_messages: ['anything'],
      similarity: 0.95 // caller injected (e.g. real embedding cosine)
    });
    // 1 - 0.95 = 0.05 drop → 0.6 * 0.05 = 0.03 score.
    assert.ok(out.embedding_drop < 0.06,
      'similarity override should drive embedding_drop, got: ' + out.embedding_drop);
    assert.strictEqual(out.fired, false);
  });

  test('A6.T7: similarityFn pluggable for future embedding sources', () => {
    let calls = 0;
    const out = topicShift.scoreTopicShift({
      current_message: 'B',
      recent_messages: ['A'],
      similarityFn: (a, b) => { calls++; return 0.1; } // very different
    });
    assert.strictEqual(calls, 1, 'similarityFn must be called exactly once');
    assert.ok(out.embedding_drop >= 0.85,
      'low similarity → high drop, got: ' + out.embedding_drop);
  });

  test('A6.T8: custom weights and threshold honored', () => {
    const out = topicShift.scoreTopicShift({
      // Multi-char tokens so the >=2-char filter doesn't strip them.
      current_message: 'auth flows debugging',
      recent_messages: ['marketing copywriting site'],
      weights: { embedding: 1.0, intent: 0.0 },
      threshold: 0.99
    });
    assert.strictEqual(out.weights.embedding, 1.0);
    assert.strictEqual(out.threshold, 0.99);
    // Overlap = 0 (disjoint tokens) → drop = 1.0 → score = 1.0 > 0.99.
    assert.strictEqual(out.fired, true);
  });

  test('A6.T9: token Jaccard internal helper handles empties symmetrically', () => {
    const { tokenize, jaccard } = topicShift._internal;
    assert.strictEqual(jaccard([], []), 1.0, 'empty vs empty = identical');
    assert.strictEqual(jaccard(['a'], []), 0.0, 'empty side = disjoint');
    assert.strictEqual(jaccard([], ['a']), 0.0, 'empty side = disjoint');
    assert.strictEqual(jaccard(tokenize('foo bar'), tokenize('foo bar')), 1.0);
    const partial = jaccard(tokenize('foo bar baz'), tokenize('foo qux'));
    assert.ok(partial > 0 && partial < 1, 'partial overlap must be in (0,1)');
  });

  // ── Hook integration (spawn subprocess, verify stdout + writes) ─────────
  // Same pattern as the hook-migration tests — spawns each hook with a payload via stdin,
  // captures emit() output, then loads state.js with the same data dir to
  // assert what the hook wrote.
  const childA6 = require('child_process');
  const pA6 = require('path');
  const fA6 = require('fs');
  const REPO_A6 = pA6.resolve(__dirname, '..');
  const PLUGIN_A6 = pA6.join(REPO_A6, 'plugin');

  function runHookA6(script, payload, dataDir) {
    const out = childA6.execFileSync('node', [pA6.join(PLUGIN_A6, 'hooks', script)], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, {
        CLAUDE_PLUGIN_ROOT: PLUGIN_A6,
        CLAUDE_PLUGIN_DATA: dataDir
      }),
      encoding: 'utf8'
    });
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  function loadStateForDir(dataDir) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    delete require.cache[require.resolve('../shared-core/state')];
    return require('../shared-core/state');
  }

  test('A6.H1: pre-compact hook persists a mind_snapshot for the cwd', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h1-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    runHookA6('pre-compact.mjs', {
      session_id: 'a6h1-' + Date.now(),
      cwd: REPO_A6
    }, TMP);
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'mind_snapshot', cwd: REPO_A6, limit: 1, order: 'desc' });
    assert.ok(rows.length >= 1, 'pre-compact must persist a mind_snapshot record');
    const rec = require('../shared-core/action-record').fromRow(rows[0]);
    assert.strictEqual(rec.input.trigger, 'pre_compact');
    assert.ok(rec.output.mind_state, 'snapshot output must contain mind_state');
    assert.strictEqual(rec.output.mind_state.schema_version, '0.1');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H2: session-start emits additionalContext with orientation when snapshot exists', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h2-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwd = REPO_A6;
    // Seed a mind_snapshot with a meaningful focus + project so the
    // formatter has something to render.
    {
      const s = loadStateForDir(TMP);
      const ms = mindState.emptyMindState('alex');
      ms.current_focus = 'shipping mind protocol v0.1';
      ms.active_projects = [
        { id: 'gc', name: 'troth v11', stage: 'design', current_focus: 'paper done' }
      ];
      const built = mindState.buildSnapshotRecord({
        id: '019dd920-0000-7000-8000-000000000001',
        timestamp: Date.now(),
        agent_id: 'claude-code',
        cwd,
        mind_state: ms,
        trigger: 'seed'
      });
      assert.ok(built.ok, 'seed snapshot must build');
      const wrote = s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
      assert.ok(wrote, 'seed snapshot must write to state');
    }

    const out = runHookA6('session-start.mjs', {
      session_id: 'a6h2-' + Date.now(),
      cwd,
      reason: 'startup'
    }, TMP);

    const ac = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert.ok(typeof ac === 'string' && ac.length > 0, 'additionalContext must be a non-empty string');
    assert.ok(ac.includes('Session orientation'), 'orientation block must be present, got: ' + ac.slice(0, 200));
    assert.ok(ac.includes('shipping mind protocol v0.1'), 'current_focus must be in output');
    assert.ok(ac.includes('troth v11'), 'project name must be in output');
    assert.ok(ac.includes('cached_read'), 'existing cache tip must still be appended');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H3: session-start emits cache tip only when no snapshot exists', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h3-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const out = runHookA6('session-start.mjs', {
      session_id: 'a6h3-' + Date.now(),
      cwd: '/tmp/no-such-cwd-' + Date.now(),
      reason: 'startup'
    }, TMP);
    const ac = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert.ok(typeof ac === 'string' && ac.length > 0);
    assert.ok(!ac.includes('Session orientation'),
      'no orientation should appear when no snapshot exists; got: ' + ac.slice(0, 200));
    assert.ok(ac.includes('cached_read'), 'cache tip must still be present');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  function runHookWithEnv(script, payload, dataDir, extraEnv) {
    const out = childA6.execFileSync('node', [pA6.join(PLUGIN_A6, 'hooks', script)], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, {
        CLAUDE_PLUGIN_ROOT: PLUGIN_A6,
        CLAUDE_PLUGIN_DATA: dataDir
      }, extraEnv || {}),
      encoding: 'utf8'
    });
    return out.trim() ? JSON.parse(out.trim()) : {};
  }

  test('A6.H_VOICE: session-start adds voice greeting directive when TROTH_VOICE_MODE=1 AND substrate has content', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6hvoice-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwd = REPO_A6;
    // Seed a mind_snapshot so the orientation block has content. The
    // voice-greeting directive only fires when there's something for the
    // agent to lead with — empty orientation/drift/auto-resume = no nudge.
    {
      const s = loadStateForDir(TMP);
      const ms = mindState.emptyMindState('alex');
      ms.current_focus = 'voice greeting wiring';
      ms.active_projects = [
        { id: 'gc', name: 'troth v11', stage: 'design', current_focus: 'voice path' }
      ];
      const built = mindState.buildSnapshotRecord({
        id: '019dd920-0000-7000-8000-000000000077',
        timestamp: Date.now(),
        agent_id: 'claude-code',
        cwd,
        mind_state: ms,
        trigger: 'seed'
      });
      assert.ok(built.ok, 'seed snapshot must build');
      const wrote = s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
      assert.ok(wrote, 'seed snapshot must write');
    }

    const out = runHookWithEnv('session-start.mjs', {
      session_id: 'a6hvoice-' + Date.now(),
      cwd,
      reason: 'startup'
    }, TMP, { TROTH_VOICE_MODE: '1' });

    const ac = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert.ok(typeof ac === 'string' && ac.length > 0, 'additionalContext required');
    assert.ok(ac.includes('[troth/voice]'), 'voice greeting directive must appear; got: ' + ac.slice(0, 400));
    assert.ok(ac.includes('LEAD your first response'), 'directive text must mention leading the first response');
    assert.ok(ac.includes('Session orientation'), 'orientation block must still be present');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H_VOICE_OFF: session-start does NOT add voice greeting directive when TROTH_VOICE_MODE is unset', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6hvoiceoff-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwd = REPO_A6;
    // Seed snapshot so orientation has content — confirms the gating is
    // strictly env-based, not "no content available".
    {
      const s = loadStateForDir(TMP);
      const ms = mindState.emptyMindState('alex');
      ms.current_focus = 'terminal default behavior';
      ms.active_projects = [{ id: 'gc', name: 'troth v11', stage: 'design' }];
      const built = mindState.buildSnapshotRecord({
        id: '019dd920-0000-7000-8000-000000000078',
        timestamp: Date.now(),
        agent_id: 'claude-code',
        cwd,
        mind_state: ms,
        trigger: 'seed'
      });
      assert.ok(built.ok, 'seed snapshot must build');
      const s2 = loadStateForDir(TMP);
      s2.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
    }

    const out = runHookA6('session-start.mjs', {
      session_id: 'a6hvoiceoff-' + Date.now(),
      cwd,
      reason: 'startup'
    }, TMP);

    const ac = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert.ok(typeof ac === 'string' && ac.length > 0);
    assert.ok(!ac.includes('[troth/voice]'),
      'voice greeting directive must NOT appear in terminal mode; got: ' + ac.slice(0, 400));
    assert.ok(ac.includes('Session orientation'), 'orientation must still be present for terminal use');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H4: topic-shift-detect is a no-op when TROTH_TOPIC_SHIFT is not set', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h4-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const sessId = 'a6h4-' + Date.now();
    runHookA6('topic-shift-detect.mjs', {
      session_id: sessId,
      cwd: REPO_A6,
      user_prompt: 'completely unrelated thing about debugging auth'
    }, TMP);
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', session_id: sessId });
    const shifts = rows
      .map(r => require('../shared-core/action-record').fromRow(r))
      .filter(p => p && p.input && p.input.kind === 'topic_shift_detected');
    assert.strictEqual(shifts.length, 0,
      'no shift records expected when env flag is off');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H5: topic-shift-detect writes a decision record on hard topic switch', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h5-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const sessId = 'a6h5-' + Date.now();
    const cwdHere = REPO_A6;
    // Seed several prior intent records so the rolling window has content.
    {
      const s = loadStateForDir(TMP);
      const seedPrompts = [
        'lets work on the marketing copy for atlasforge landing page',
        'atlasforge headline rewrite needs to feel more professional',
        'add atlasforge marketing cta about automation features'
      ];
      for (const goal of seedPrompts) {
        const intentRec = {
          id: require('crypto').randomUUID(),
          timestamp: Date.now() - (1000 * (seedPrompts.length - seedPrompts.indexOf(goal))),
          type: 'intent',
          agent_id: 'claude-code',
          cwd: cwdHere,
          input: { goal, source_message_hash: require('crypto').randomBytes(8).toString('hex') },
          output: { chosen_path: 'manual' },
          verification: {},
          outcome: {}
        };
        s.recordAction(intentRec, require('../shared-core/action-record').toSearchText(intentRec));
      }
    }
    // Run the hook with the env flag enabled and a clearly different
    // current prompt — auth/JWT/middleware vs marketing/atlasforge.
    runHookWithEnv('topic-shift-detect.mjs', {
      session_id: sessId,
      cwd: cwdHere,
      user_prompt: 'now lets debug the JWT race condition in the auth middleware code'
    }, TMP, { TROTH_TOPIC_SHIFT: '1' });

    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', session_id: sessId });
    const shifts = rows
      .map(r => require('../shared-core/action-record').fromRow(r))
      .filter(p => p && p.input && p.input.kind === 'topic_shift_detected');
    assert.ok(shifts.length >= 1,
      'expected at least one topic_shift_detected decision, got: ' + JSON.stringify(rows));
    const shift = shifts[0];
    assert.strictEqual(shift.output.decision, 'topic_shift');
    assert.ok(typeof shift.input.signals.embedding_drop === 'number');
    assert.ok(shift.input.signals.embedding_drop > 0.5,
      'high drop expected for marketing→auth shift, got: ' + shift.input.signals.embedding_drop);
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H7: topic-shift-detect emits re-orientation additionalContext when shift fires', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h7-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const sessId = 'a6h7-' + Date.now();
    const cwdHere = REPO_A6;

    // Seed (a) prior intent records establishing a topic, AND (b) a
    // mind_snapshot with active_projects so deriveTaskSignature has
    // something to match against.
    {
      const s = loadStateForDir(TMP);
      const seedPrompts = [
        'lets work on the marketing copy for atlasforge landing page',
        'atlasforge headline rewrite needs to feel more professional',
        'add atlasforge marketing cta about automation features'
      ];
      for (const goal of seedPrompts) {
        const intentRec = {
          id: require('crypto').randomUUID(),
          timestamp: Date.now() - (1000 * (seedPrompts.length - seedPrompts.indexOf(goal))),
          type: 'intent',
          agent_id: 'claude-code',
          cwd: cwdHere,
          input: { goal, source_message_hash: require('crypto').randomBytes(8).toString('hex') },
          output: { chosen_path: 'manual' },
          verification: {},
          outcome: {}
        };
        s.recordAction(intentRec, require('../shared-core/action-record').toSearchText(intentRec));
      }
      // Seed snapshot with two projects so deriveTaskSignature has matches.
      const ms = mindState.emptyMindState('alex');
      ms.current_focus = 'shifting topics';
      ms.active_projects = [
        {
          id: 'atlasforge',
          name: 'atlasforge',
          stage: 'GTM',
          current_focus: 'weekly demo prep',
          audience: 'small studios',
          key_decisions: [{ decision_id: 'ar-d1', summary: 'pivot to guided onboarding' }],
          open_questions: ['v6 mind integration timing'],
          constraints: [],
          collaborators: []
        },
        {
          id: 'troth',
          name: 'troth v11',
          stage: 'design',
          current_focus: 'mind protocol paper',
          audience: 'developers',
          key_decisions: [{ decision_id: 'gc-d1', summary: 'mind = working context' }],
          open_questions: ['decay strategy'],
          constraints: ['no persona override'],
          collaborators: [{ who: 'operator', role: 'lead' }]
        }
      ];
      const built = mindState.buildSnapshotRecord({
        id: require('crypto').randomUUID(),
        timestamp: Date.now(),
        agent_id: 'claude-code',
        cwd: cwdHere,
        mind_state: ms,
        trigger: 'seed'
      });
      assert.ok(built.ok);
      s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
    }

    // Run the hook with topic-shift enabled and a prompt that pivots to
    // troth — different from the marketing/atlasforge recent context.
    const out = runHookWithEnv('topic-shift-detect.mjs', {
      session_id: sessId,
      cwd: cwdHere,
      user_prompt: 'pivot now: lets debug the troth paging logic in the substrate'
    }, TMP, { TROTH_TOPIC_SHIFT: '1' });

    // Hook must emit additionalContext with the re-orientation block.
    const ac = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert.ok(typeof ac === 'string' && ac.length > 0,
      'expected additionalContext from re-orientation, got: ' + JSON.stringify(out));
    assert.ok(ac.includes('Topic shift detected'),
      'expected re-orientation header, got: ' + ac.slice(0, 200));
    assert.ok(ac.includes('troth v11'),
      'expected matched project name (troth), got: ' + ac.slice(0, 300));
    assert.ok(!ac.includes('atlasforge'),
      'atlasforge should be cold and not appear in focused re-orientation');

    // And the substrate decision record must still have been written.
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', session_id: sessId });
    const shifts = rows
      .map(r => require('../shared-core/action-record').fromRow(r))
      .filter(p => p && p.input && p.input.kind === 'topic_shift_detected');
    assert.ok(shifts.length >= 1, 'shift decision must still be written');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H8: stop-mind-persist writes a mind_snapshot with trigger=stop', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h8-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    runHookA6('stop-mind-persist.mjs', {
      session_id: 'a6h8-' + Date.now(),
      cwd: REPO_A6
    }, TMP);
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'mind_snapshot', cwd: REPO_A6, limit: 1, order: 'desc' });
    assert.ok(rows.length >= 1, 'stop hook must persist a mind_snapshot');
    const rec = require('../shared-core/action-record').fromRow(rows[0]);
    assert.strictEqual(rec.input.trigger, 'stop');
    assert.ok(rec.output.mind_state, 'snapshot must contain mind_state');
    assert.strictEqual(rec.output.mind_state.schema_version, '0.1');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H12: dmn-push is a no-op when TROTH_DMN_PUSH is not set', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h12-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const out = runHookA6('dmn-push.mjs', {
      session_id: 'a6h12-' + Date.now(),
      cwd: REPO_A6,
      user_prompt: 'anything'
    }, TMP);
    // No env flag → allow() emits {}.
    assert.deepStrictEqual(out, {});
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H13: dmn-push emits cross-project relevance addContext', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h13-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = REPO_A6;
    // Seed snapshot with two projects; ar has a guided onboarding decision
    // that should be surfaced when prompt mentions guided onboarding while
    // working on gc.
    {
      const s = loadStateForDir(TMP);
      const ms = mindState.emptyMindState('alex');
      ms.active_projects = [
        { id: 'gc', name: 'GC', stage: 'design',
          key_decisions: [{ decision_id: 'gd1', summary: 'mind = working context' }],
          open_questions: [], constraints: [], collaborators: [] },
        { id: 'ar', name: 'atlasforge', stage: 'GTM',
          key_decisions: [{ decision_id: 'ad1', summary: 'pivot to guided onboarding' }],
          open_questions: ['v6 mind integration timing'],
          constraints: [], collaborators: [] }
      ];
      const built = mindState.buildSnapshotRecord({
        id: require('crypto').randomUUID(),
        timestamp: Date.now(),
        agent_id: 'claude-code',
        cwd: cwdHere,
        mind_state: ms,
        trigger: 'seed'
      });
      assert.ok(built.ok);
      s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
    }

    const out = runHookWithEnv('dmn-push.mjs', {
      session_id: 'a6h13-' + Date.now(),
      cwd: cwdHere,
      user_prompt: 'should we add a guided onboarding style onboarding to troth v11 too?'
    }, TMP, { TROTH_DMN_PUSH: '1' });

    const ac = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert.ok(typeof ac === 'string' && ac.length > 0,
      'expected DMN push additionalContext, got: ' + JSON.stringify(out));
    assert.ok(ac.includes('DMN push'));
    assert.ok(ac.includes('atlasforge'));
    assert.ok(ac.includes('guided onboarding'));
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H14: dmn-push rate-limits within window', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h14-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = REPO_A6;
    // Same setup as H13.
    {
      const s = loadStateForDir(TMP);
      const ms = mindState.emptyMindState('alex');
      ms.active_projects = [
        { id: 'gc', name: 'GC', stage: 'design',
          key_decisions: [], open_questions: [], constraints: [], collaborators: [] },
        { id: 'ar', name: 'atlasforge', stage: 'GTM',
          key_decisions: [{ decision_id: 'ad1', summary: 'pivot to guided onboarding' }],
          open_questions: [], constraints: [], collaborators: [] }
      ];
      const built = mindState.buildSnapshotRecord({
        id: require('crypto').randomUUID(),
        timestamp: Date.now(),
        agent_id: 'claude-code',
        cwd: cwdHere,
        mind_state: ms,
        trigger: 'seed'
      });
      s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
    }
    // First call fires.
    const out1 = runHookWithEnv('dmn-push.mjs', {
      session_id: 'a6h14a-' + Date.now(),
      cwd: cwdHere,
      user_prompt: 'guided onboarding onboarding for troth'
    }, TMP, { TROTH_DMN_PUSH: '1' });
    assert.ok(out1.hookSpecificOutput && out1.hookSpecificOutput.additionalContext,
      'first call must emit additionalContext');

    // Second call within rate-limit window → no addContext.
    const out2 = runHookWithEnv('dmn-push.mjs', {
      session_id: 'a6h14b-' + Date.now(),
      cwd: cwdHere,
      user_prompt: 'guided onboarding onboarding for troth'
    }, TMP, { TROTH_DMN_PUSH: '1', TROTH_DMN_PUSH_RATELIMIT_MS: '60000' });
    assert.deepStrictEqual(out2, {},
      'second call within window should be rate-limited (allow with empty), got: ' + JSON.stringify(out2));
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H10: stop-mind-persist deduplicates back-to-back no-change runs', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h10-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = REPO_A6;
    // First run: writes one snapshot.
    runHookA6('stop-mind-persist.mjs', {
      session_id: 'a6h10a-' + Date.now(),
      cwd: cwdHere
    }, TMP);
    let s = loadStateForDir(TMP);
    let rows = s.queryActions({ type: 'mind_snapshot', cwd: cwdHere });
    assert.strictEqual(rows.length, 1,
      'first stop run must create exactly one snapshot');

    // Second run with no substrate changes between → must skip.
    runHookA6('stop-mind-persist.mjs', {
      session_id: 'a6h10b-' + Date.now(),
      cwd: cwdHere
    }, TMP);
    s = loadStateForDir(TMP);
    rows = s.queryActions({ type: 'mind_snapshot', cwd: cwdHere });
    assert.strictEqual(rows.length, 1,
      'second stop run with no changes must NOT add a duplicate snapshot');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI1: troth mind list reports empty when no snapshots exist', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli1-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const out = childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'list'], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });
    assert.ok(out.includes('No mind snapshots yet'),
      'expected empty-state message, got: ' + out.slice(0, 200));
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI2: troth mind list shows snapshots after persist', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli2-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-test-' + Date.now();
    // Persist via the hook so the schema validates end-to-end.
    runHookA6('stop-mind-persist.mjs', {
      session_id: 'a6cli2-' + Date.now(),
      cwd: cwdHere
    }, TMP);
    const out = childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'list', '--cwd', cwdHere], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });
    assert.ok(out.includes('snapshot_id'), 'header expected: ' + out.slice(0, 200));
    assert.ok(out.includes('stop'), 'trigger=stop expected for snapshot from stop hook');
    assert.ok(out.includes(cwdHere), 'cwd expected in row: ' + cwdHere);
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI4: troth mind set-project bootstraps a project then list shows it', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli4-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-bootstrap-' + Date.now();
    childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'set-project',
        '--id', 'gc', '--name', 'troth v11',
        '--stage', 'design', '--focus', 'mind protocol',
        '--cwd', cwdHere], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });
    const showOut = childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'show', '--cwd', cwdHere], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });
    const parsed = JSON.parse(showOut);
    assert.ok(parsed.mind_state, 'mind_state must be present');
    const proj = parsed.mind_state.active_projects.find(p => p.id === 'gc');
    assert.ok(proj, 'gc project must be in active_projects');
    assert.strictEqual(proj.name, 'troth v11');
    assert.strictEqual(proj.stage, 'design');
    assert.strictEqual(proj.current_focus, 'mind protocol');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI5: troth mind set-project upserts existing project', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli5-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-upsert-' + Date.now();
    // First call: create.
    childA6.execFileSync('node', [pA6.join(REPO_A6, 'bin', 'troth.js'),
      'mind', 'set-project', '--id', 'p', '--name', 'V1', '--stage', 's1', '--cwd', cwdHere],
      { env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }), encoding: 'utf8' });
    // Second call: same id, different name + stage.
    childA6.execFileSync('node', [pA6.join(REPO_A6, 'bin', 'troth.js'),
      'mind', 'set-project', '--id', 'p', '--name', 'V2', '--stage', 's2', '--cwd', cwdHere],
      { env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }), encoding: 'utf8' });
    const showOut = childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'show', '--cwd', cwdHere],
      { env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }), encoding: 'utf8' });
    const parsed = JSON.parse(showOut);
    const projects = parsed.mind_state.active_projects.filter(p => p.id === 'p');
    assert.strictEqual(projects.length, 1, 'must upsert, not duplicate');
    assert.strictEqual(projects[0].name, 'V2');
    assert.strictEqual(projects[0].stage, 's2');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI6: troth mind decision writes a mind_decision substrate record', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli6-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-dec-' + Date.now();
    childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'decision',
        '--project', 'gc', '--summary', 'lock decision X',
        '--rationale', 'because Y', '--cwd', cwdHere], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', cwd: cwdHere });
    const minds = rows
      .map(r => require('../shared-core/action-record').fromRow(r))
      .filter(p => p && p.input && p.input.kind === 'mind_decision');
    assert.ok(minds.length >= 1, 'mind_decision record must be written');
    assert.strictEqual(minds[0].input.signals.project_id, 'gc');
    assert.strictEqual(minds[0].input.signals.summary, 'lock decision X');
    assert.strictEqual(minds[0].input.signals.rationale, 'because Y');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI9: troth mind compact archives old snapshots beyond keep-last', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli9-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-compact-' + Date.now();
    // Seed 8 snapshots, oldest first; we'll then compact with keep-last=2
    // and older-than-days=0 so everything past the keep set is eligible.
    {
      const s = loadStateForDir(TMP);
      for (let i = 0; i < 8; i++) {
        const ms = mindState.emptyMindState('alex');
        ms.current_focus = 'snap-' + i;
        const built = mindState.buildSnapshotRecord({
          id: require('crypto').randomUUID(),
          timestamp: Date.now() - (8 - i) * 60 * 1000,
          agent_id: 'seed',
          cwd: cwdHere,
          mind_state: ms,
          trigger: 'seed'
        });
        s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
      }
    }
    childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'compact',
        '--cwd', cwdHere, '--keep-last', '2', '--older-than-days', '0'], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });
    const s = loadStateForDir(TMP);
    const archived = mindState.getArchivedSnapshotIds(s, cwdHere);
    // 8 seeded - 2 kept = 6 archived (assuming all are old enough; --older-than-days=0 → eligible immediately).
    assert.strictEqual(archived.size, 6,
      'expected 6 archived snapshots (8 seeded - 2 keep-last), got: ' + archived.size);
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI10: troth mind list filters out archived snapshots', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli10-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-list-archived-' + Date.now();
    // Seed 4 snapshots and archive 2 of them.
    let snapIds = [];
    {
      const s = loadStateForDir(TMP);
      for (let i = 0; i < 4; i++) {
        const ms = mindState.emptyMindState('u');
        ms.current_focus = 's' + i;
        const built = mindState.buildSnapshotRecord({
          id: require('crypto').randomUUID(),
          timestamp: Date.now() - (4 - i) * 60 * 1000,
          agent_id: 'seed',
          cwd: cwdHere,
          mind_state: ms,
          trigger: 'seed'
        });
        s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
        snapIds.push(built.record.id);
      }
      // Archive snap 0 and snap 1 (the oldest two).
      for (const archIdx of [0, 1]) {
        const arch = mindState.buildArchiveEventRecord({
          id: require('crypto').randomUUID(),
          timestamp: Date.now(),
          agent_id: 'test',
          cwd: cwdHere,
          archived_snapshot_id: snapIds[archIdx],
          reason: 'test'
        });
        s.recordAction(arch.record, require('../shared-core/action-record').toSearchText(arch.record));
      }
    }
    // load_orientation must return the most-recent LIVE snapshot (s3),
    // not an archived one.
    const s = loadStateForDir(TMP);
    // Manually invoke through MCP server semantics: pull live snapshots.
    const rows = s.queryActions({ type: 'mind_snapshot', cwd: cwdHere, limit: 50, order: 'desc' });
    const archivedIds = mindState.getArchivedSnapshotIds(s, cwdHere);
    const liveRow = rows.find(r => !archivedIds.has(r.id));
    assert.ok(liveRow, 'a live snapshot must exist after archiving 2 of 4');
    const rec = require('../shared-core/action-record').fromRow(liveRow);
    assert.strictEqual(rec.output.mind_state.current_focus, 's3',
      'expected newest live (s3), got: ' + rec.output.mind_state.current_focus);
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI8: troth mind distill exits 2 when no LLM endpoint is configured', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli8-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-distill-' + Date.now();
    // Bootstrap project so distill has something to find.
    childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'set-project',
        '--id', 'p', '--name', 'P', '--cwd', cwdHere], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });

    let exited = 0;
    let stderr = '';
    try {
      childA6.execFileSync('node',
        [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'distill',
          '--project', 'p', '--cwd', cwdHere], {
          env: Object.assign({}, process.env, {
            CLAUDE_PLUGIN_DATA: TMP,
            // Ensure endpoint var is unset for this child process.
            TROTH_MIND_DISTILL_ENDPOINT: ''
          }),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (e) {
      exited = e.status || 1;
      stderr = (e.stderr && e.stderr.toString()) || '';
    }
    assert.strictEqual(exited, 2, 'expected exit 2 when no endpoint, got: ' + exited);
    assert.ok(stderr.includes('TROTH_MIND_DISTILL_ENDPOINT'),
      'expected guidance to set env, got stderr: ' + stderr.slice(0, 200));
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI7: troth mind set-project rejects missing required args', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli7-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    let exited = 0;
    try {
      childA6.execFileSync('node',
        [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'set-project', '--id', 'x'], {
          env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (e) {
      exited = e.status || 1;
    }
    assert.ok(exited !== 0, 'must exit non-zero when --name missing');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.CLI3: troth mind show emits JSON containing the mind_state', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6cli3-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = require('os').tmpdir() + '/gc-cli-show-' + Date.now();
    runHookA6('stop-mind-persist.mjs', {
      session_id: 'a6cli3-' + Date.now(),
      cwd: cwdHere
    }, TMP);
    const out = childA6.execFileSync('node',
      [pA6.join(REPO_A6, 'bin', 'troth.js'), 'mind', 'show', '--cwd', cwdHere], {
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: TMP }),
        encoding: 'utf8'
      });
    const parsed = JSON.parse(out);
    assert.ok(parsed.snapshot_id);
    assert.ok(parsed.mind_state);
    assert.strictEqual(parsed.mind_state.schema_version, '0.1');
    assert.strictEqual(parsed.trigger, 'stop');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H11: stop-mind-persist DOES persist when there is a real delta', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h11-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwdHere = REPO_A6;
    // First run: empty substrate → writes one snapshot (empty content).
    runHookA6('stop-mind-persist.mjs', {
      session_id: 'a6h11a-' + Date.now(),
      cwd: cwdHere
    }, TMP);

    // Now record a mind_decision (real content delta) BEFORE second
    // stop. The next recompute should fold it in, producing different
    // content and triggering a fresh persist.
    {
      const s = loadStateForDir(TMP);
      // The recompute will only fold the decision if there's a project
      // matching the project_id. Inject a fake "active project" via a
      // direct mind_snapshot write so recompute has somewhere to fold.
      const ms = mindState.emptyMindState('alex');
      ms.active_projects = [{
        id: 'gc', name: 'GC', stage: 'design',
        key_decisions: [], open_questions: [], constraints: [], collaborators: []
      }];
      const seedSnap = mindState.buildSnapshotRecord({
        id: require('crypto').randomUUID(),
        timestamp: Date.now(),
        agent_id: 'claude-code',
        cwd: cwdHere,
        mind_state: ms,
        trigger: 'seed'
      });
      assert.ok(seedSnap.ok);
      s.recordAction(seedSnap.record, require('../shared-core/action-record').toSearchText(seedSnap.record));

      // Now write a mind_decision against gc — this is the real delta.
      const decRec = {
        id: require('crypto').randomUUID(),
        timestamp: Date.now() + 1,
        type: 'decision',
        agent_id: 'claude-code',
        cwd: cwdHere,
        input: {
          kind: 'mind_decision',
          signals: { project_id: 'gc', summary: 'lock decision X', rationale: 'because Y' }
        },
        output: { decision: 'recorded', reason: 'manual_capture' },
        verification: {},
        outcome: {}
      };
      s.recordAction(decRec, require('../shared-core/action-record').toSearchText(decRec));
    }

    // Re-run stop hook. recompute folds the decision in → content diff
    // vs latest snapshot → persist new one.
    runHookA6('stop-mind-persist.mjs', {
      session_id: 'a6h11b-' + Date.now(),
      cwd: cwdHere
    }, TMP);

    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'mind_snapshot', cwd: cwdHere, order: 'desc' });
    // We expect: the seed snapshot + at least 1 stop snapshot from
    // step 1 + 1 stop snapshot from step 3. Step 2 is the seed write.
    // The exact count depends on whether the first stop wrote
    // (empty substrate; recompute may have produced empty mind_state
    // identical to its base). Important assertion: the LATEST snapshot
    // contains the folded decision in active_projects[gc].key_decisions.
    const latest = require('../shared-core/action-record').fromRow(rows[0]);
    const gcInLatest = latest.output.mind_state.active_projects.find(p => p.id === 'gc');
    assert.ok(gcInLatest, 'gc project must be present in latest');
    assert.ok(gcInLatest.key_decisions.length >= 1,
      'latest snapshot must contain folded decision; got: ' + JSON.stringify(gcInLatest.key_decisions));
    assert.ok(gcInLatest.key_decisions.some(d => d.summary === 'lock decision X'),
      'specific decision must be in folded list');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H9: stop-mind-persist no-ops when TROTH_STOP_MIND_PERSIST=0', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h9-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    runHookWithEnv('stop-mind-persist.mjs', {
      session_id: 'a6h9-' + Date.now(),
      cwd: REPO_A6
    }, TMP, { TROTH_STOP_MIND_PERSIST: '0' });
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'mind_snapshot', cwd: REPO_A6 });
    assert.strictEqual(rows.length, 0,
      'no snapshot expected when TROTH_STOP_MIND_PERSIST=0');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  // ── Q-DECISION-PATTERNS — pure detector unit tests ───────────────────
  const detector = require('../shared-core/decision-patterns');

  test('A6.DC1: detector catches T1 lock markers (P1:, Decision:, Locked:)', () => {
    const cases = [
      'P1: Mind = working context, persona is wrong frame',
      'Decision: use SQLite for the substrate',
      'Locked: dropping the LoRA path entirely',
      'Q5: append-only event substrate honored everywhere'
    ];
    for (const prompt of cases) {
      const out = detector.detectDecision({ prompt, projects: [{ id: 'p', name: 'P' }] });
      assert.ok(out, 'expected match for: ' + prompt);
      assert.strictEqual(out.kind, 'lock');
      assert.ok(out.confidence >= 0.9);
    }
  });

  test('A6.DC2: detector catches T2 commit phrase + summarizes from prior assistant', () => {
    const out = detector.detectDecision({
      prompt: 'ok do it',
      prior_assistant: 'I recommend going with option B (the kind-filter approach) — it scales to high-volume substrates without clipping.',
      projects: [{ id: 'gc', name: 'troth' }]
    });
    assert.ok(out, 'should match commit phrase');
    assert.strictEqual(out.kind, 'commit');
    assert.ok(out.summary.startsWith('Committed:'),
      'summary should be commit-framed, got: ' + out.summary);
    assert.ok(out.summary.includes('option B') || out.summary.includes('kind-filter'),
      'should pull proposal text from prior assistant turn');
  });

  test('A6.DC3: detector catches T3 rejection but skips error strings', () => {
    const ok = detector.detectDecision({
      prompt: 'reject the LoRA path because it ties identity to one runtime',
      projects: [{ id: 'p', name: 'P' }]
    });
    assert.ok(ok, 'real rejection should match');
    assert.strictEqual(ok.kind, 'reject');
    assert.ok(ok.summary.startsWith('Rejected:'));
    assert.ok(ok.rationale.includes('runtime'), 'rationale extracted from "because" tail');

    const noise = detector.detectDecision({
      prompt: 'API Error: Request rejected (429) · All accounts rate-limited.',
      projects: [{ id: 'p', name: 'P' }]
    });
    assert.strictEqual(noise, null, 'error strings must be filtered');
  });

  test('A6.DC4: detector filters system reminders + slash commands + tool noise', () => {
    const cases = [
      '<system-reminder>do this thing</system-reminder>',
      '/clear',
      '   ',
      'a', // too short
      'rate-limited; not going with this attempt'
    ];
    for (const prompt of cases) {
      const out = detector.detectDecision({ prompt, projects: [{ id: 'p', name: 'P' }] });
      assert.strictEqual(out, null, 'should skip noise: ' + JSON.stringify(prompt));
    }
  });

  test('A6.DC5: detector dedups against recent_summaries set', () => {
    // Simulate state where this exact decision was already captured.
    // Detector normalizes summaries to lowercase + collapsed-whitespace
    // before checking the dedup set.
    const recent = new Set(['committed: option a']);
    const out = detector.detectDecision({
      prompt: 'going with option A',
      projects: [{ id: 'p', name: 'P' }],
      recent_summaries: recent
    });
    assert.strictEqual(out, null, 'duplicate must be skipped via dedup set');
  });

  test('A6.DC6: pickProject — single project shortcut', () => {
    const id = detector._internal.pickProject(
      [{ id: 'only', name: 'Only' }], 'irrelevant prompt', ''
    );
    assert.strictEqual(id, 'only');
  });

  test('A6.DC7: pickProject — multi-project vote on name mentions', () => {
    const projects = [
      { id: 'gc', name: 'troth' },
      { id: 'ark', name: 'AtlasForge' }
    ];
    const id = detector._internal.pickProject(
      projects,
      'lets refactor the AtlasForge landing page hero',
      'sure, the AtlasForge copy needs work'
    );
    assert.strictEqual(id, 'ark', 'AtlasForge should win on 2 mentions vs 0');
  });

  test('A6.DC8: detector returns null when commit phrase has no prior context', () => {
    const out = detector.detectDecision({
      prompt: 'ok do it',
      prior_assistant: '', // no proposal context
      projects: [{ id: 'p', name: 'P' }]
    });
    assert.strictEqual(out, null,
      'commit-without-context is too noisy to capture');
  });

  // ── Hook integration: decision-capture spawn tests ───────────────────

  test('A6.H15: decision-capture is no-op when TROTH_DECISION_CAPTURE not set', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h15-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    runHookA6('decision-capture.mjs', {
      session_id: 'a6h15', cwd: REPO_A6,
      user_prompt: 'P1: lock this decision'
    }, TMP);
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', cwd: REPO_A6, kind: 'mind_decision' });
    assert.strictEqual(rows.length, 0,
      'no mind_decision should be written without the env flag');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H16: decision-capture writes mind_decision on lock marker', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h16-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwd = REPO_A6;
    // Seed a snapshot with a project so resolution succeeds.
    {
      const s = loadStateForDir(TMP);
      const ms = mindState.emptyMindState('alex');
      ms.active_projects = [{
        id: 'gc', name: 'troth v11', stage: 'build',
        current_focus: '', audience: '', key_decisions: [],
        open_questions: [], constraints: [], collaborators: []
      }];
      const built = mindState.buildSnapshotRecord({
        id: '019dd9aa-0000-7000-8000-000000000001',
        timestamp: Date.now(), agent_id: 'cli', cwd,
        mind_state: ms, trigger: 'seed'
      });
      s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
    }
    runHookWithEnv('decision-capture.mjs', {
      session_id: 'a6h16', cwd,
      user_prompt: 'P1: Mind = working context, persona is wrong frame'
    }, TMP, { TROTH_DECISION_CAPTURE: '1' });

    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', cwd, kind: 'mind_decision' });
    assert.strictEqual(rows.length, 1, 'lock marker must produce exactly one mind_decision');
    const rec = require('../shared-core/action-record').fromRow(rows[0]);
    assert.strictEqual(rec.input.signals.project_id, 'gc');
    assert.ok(rec.input.signals.summary.toLowerCase().includes('p1'),
      'summary should preserve the lock marker, got: ' + rec.input.signals.summary);
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H17: decision-capture skips when no project resolvable from snapshot', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h17-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    runHookWithEnv('decision-capture.mjs', {
      session_id: 'a6h17',
      cwd: '/tmp/no-project-here-' + Date.now(),
      user_prompt: 'Decision: use the new approach'
    }, TMP, { TROTH_DECISION_CAPTURE: '1' });
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', kind: 'mind_decision' });
    assert.strictEqual(rows.length, 0,
      'must NOT write a mind_decision without a resolvable project');
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H18: decision-capture dedups identical lock markers within 24h window', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h18-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwd = REPO_A6;
    {
      const s = loadStateForDir(TMP);
      const ms = mindState.emptyMindState('alex');
      ms.active_projects = [{
        id: 'gc', name: 'troth', stage: 'build', current_focus: '',
        audience: '', key_decisions: [], open_questions: [],
        constraints: [], collaborators: []
      }];
      const built = mindState.buildSnapshotRecord({
        id: '019dd9bb-0000-7000-8000-000000000001',
        timestamp: Date.now(), agent_id: 'cli', cwd,
        mind_state: ms, trigger: 'seed'
      });
      s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));
    }
    const payload = {
      session_id: 'a6h18', cwd,
      user_prompt: 'Decision: ship the salience scoreboard panel today'
    };
    runHookWithEnv('decision-capture.mjs', payload, TMP, { TROTH_DECISION_CAPTURE: '1' });
    runHookWithEnv('decision-capture.mjs', payload, TMP, { TROTH_DECISION_CAPTURE: '1' });
    runHookWithEnv('decision-capture.mjs', payload, TMP, { TROTH_DECISION_CAPTURE: '1' });

    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', cwd, kind: 'mind_decision' });
    assert.strictEqual(rows.length, 1,
      'three identical captures should dedup to one row, got: ' + rows.length);
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  // ── intent-decisions (v2 action-sequence detector) ──────────────────
  const intentDec = require('../shared-core/intent-decisions');

  function intentRow(id, ts, goal) {
    return {
      id, timestamp: ts,
      input: { goal, source_message_hash: 'h' + id },
      output: { chosen_path: 'manual' }
    };
  }

  test('A6.ID1: tokenize drops stopwords and very short tokens', () => {
    const t = intentDec._internal.tokenize('add JWT auth to the api server please');
    assert.ok(t.has('jwt') && t.has('auth') && t.has('api') && t.has('server'),
      'meaningful tokens kept: ' + Array.from(t).join(','));
    assert.ok(!t.has('the') && !t.has('to') && !t.has('please'),
      'stopwords dropped: ' + Array.from(t).join(','));
  });

  test('A6.ID2: jaccard returns 0/1 bounds + sensible overlap', () => {
    const a = new Set(['jwt', 'auth', 'middleware']);
    const b = new Set(['jwt', 'auth', 'middleware']);
    const c = new Set(['oauth', 'session', 'cookie']);
    assert.strictEqual(intentDec._internal.jaccard(a, b), 1);
    assert.strictEqual(intentDec._internal.jaccard(a, c), 0);
    const d = new Set(['jwt', 'auth', 'cookie']);
    const o = intentDec._internal.jaccard(a, d);
    assert.ok(o > 0 && o < 1, 'partial overlap is fractional, got: ' + o);
  });

  test('A6.ID3: supersession captures BOTH chosen + rejected when marker + overlap present', () => {
    const now = Date.now();
    const intents = [
      intentRow('i1', now - 1000, 'add JWT authentication middleware to the api'),
      intentRow('i2', now - 500,  'no actually use OAuth instead of JWT for the api authentication')
    ];
    const out = intentDec.detectFromIntents(intents, { now });
    const sup = out.filter(o => o.kind === 'super_chosen');
    const rej = out.filter(o => o.kind === 'super_rejected');
    assert.strictEqual(sup.length, 1, 'one super_chosen expected, got: ' + JSON.stringify(out));
    assert.strictEqual(rej.length, 1, 'one super_rejected expected');
    assert.deepStrictEqual(sup[0].supersedes, ['i1']);
    assert.ok(sup[0].summary.startsWith('Chose:'));
    assert.ok(rej[0].summary.startsWith('Rejected:'));
  });

  test('A6.ID4: no supersession when overlap below threshold', () => {
    const now = Date.now();
    const intents = [
      intentRow('a', now - 1000, 'add JWT authentication middleware'),
      intentRow('b', now - 500,  'no actually rewrite the marketing landing page hero')
    ];
    const out = intentDec.detectFromIntents(intents, { now, promote_after_ms: 24 * 3600 * 1000 });
    assert.strictEqual(out.filter(o => o.kind.startsWith('super')).length, 0,
      'unrelated topics must not trigger supersession');
  });

  test('A6.ID5: no supersession when marker absent (refinement, not contradiction)', () => {
    const now = Date.now();
    const intents = [
      intentRow('a', now - 1000, 'add JWT auth middleware to api endpoints'),
      intentRow('b', now - 500,  'also add JWT auth to the websocket endpoints')
    ];
    const out = intentDec.detectFromIntents(intents, { now, promote_after_ms: 24 * 3600 * 1000 });
    assert.strictEqual(out.filter(o => o.kind.startsWith('super')).length, 0,
      'high-overlap follow-up without marker is refinement, not supersession');
  });

  test('A6.ID6: durability confirmation promotes old intents that have a follow-up', () => {
    const now = Date.now();
    const intents = [
      intentRow('old1', now - 20 * 60 * 1000, 'design the substrate schema for action records'),
      intentRow('new1', now - 10 * 60 * 1000, 'wire up the action_records FTS5 index now')
    ];
    const out = intentDec.detectFromIntents(intents, { now, promote_after_ms: 15 * 60 * 1000 });
    const confirms = out.filter(o => o.kind === 'confirm');
    assert.strictEqual(confirms.length, 1, 'one confirmation expected for old1');
    assert.strictEqual(confirms[0].intent_id, 'old1');
  });

  test('A6.ID7: captured_intent_ids set dedups so we don\'t re-emit', () => {
    const now = Date.now();
    const intents = [
      intentRow('i1', now - 1000, 'add JWT auth middleware'),
      intentRow('i2', now - 500,  'no actually use OAuth instead of JWT auth middleware')
    ];
    const captured = new Set(['i2']);
    const out = intentDec.detectFromIntents(intents, { now, captured_intent_ids: captured });
    const supChosen = out.filter(o => o.kind === 'super_chosen');
    assert.strictEqual(supChosen.length, 0,
      'i2 was already captured, must not re-emit');
  });

  test('A6.H19: intent-decisions hook is no-op when env not set', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h19-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    runHookA6('intent-decisions.mjs', { session_id: 'a6h19', cwd: REPO_A6 }, TMP);
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', cwd: REPO_A6, kind: 'mind_decision' });
    assert.strictEqual(rows.length, 0);
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H20: intent-decisions writes mind_decision pair on supersession', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h20-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const cwd = REPO_A6;
    {
      const s = loadStateForDir(TMP);
      // Seed project so resolution succeeds.
      const ms = mindState.emptyMindState('alex');
      ms.active_projects = [{
        id: 'gc', name: 'troth', stage: 'build', current_focus: '',
        audience: '', key_decisions: [], open_questions: [],
        constraints: [], collaborators: []
      }];
      const built = mindState.buildSnapshotRecord({
        id: '019dd9cc-0000-7000-8000-000000000001',
        timestamp: Date.now(), agent_id: 'cli', cwd,
        mind_state: ms, trigger: 'seed'
      });
      s.recordAction(built.record, require('../shared-core/action-record').toSearchText(built.record));

      // Two intents — second supersedes first via marker + overlap.
      const now = Date.now();
      s.recordAction({
        id: require('crypto').randomUUID(),
        timestamp: now - 30000, type: 'intent', agent_id: 'claude-code', cwd,
        input: { goal: 'add JWT authentication middleware to api', source_message_hash: 'h1' },
        output: { chosen_path: 'manual' }, verification: {}, outcome: {}
      });
      s.recordAction({
        id: require('crypto').randomUUID(),
        timestamp: now - 5000, type: 'intent', agent_id: 'claude-code', cwd,
        input: { goal: 'no actually use OAuth instead of JWT for api authentication', source_message_hash: 'h2' },
        output: { chosen_path: 'manual' }, verification: {}, outcome: {}
      });
    }
    runHookWithEnv('intent-decisions.mjs', { session_id: 'a6h20', cwd }, TMP,
      { TROTH_INTENT_DECISIONS: '1' });
    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', cwd, kind: 'mind_decision' });
    assert.strictEqual(rows.length, 2, 'expected chosen + rejected pair, got: ' + rows.length);
    const recs = rows.map(r => require('../shared-core/action-record').fromRow(r));
    const chosen   = recs.find(r => r.input.signals.capture_tier === 'super_chosen');
    const rejected = recs.find(r => r.input.signals.capture_tier === 'super_rejected');
    assert.ok(chosen,   'super_chosen recorded');
    assert.ok(rejected, 'super_rejected recorded');
    assert.ok(chosen.input.signals.summary.startsWith('Chose:'));
    assert.ok(rejected.input.signals.summary.startsWith('Rejected:'));
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  test('A6.H6: topic-shift-detect does NOT fire when prompt is on-topic', () => {
    const TMP = pA6.join(require('os').tmpdir(), 'gc-a6h6-' + Date.now());
    fA6.mkdirSync(TMP, { recursive: true });
    const sessId = 'a6h6-' + Date.now();
    const cwdHere = REPO_A6;
    {
      const s = loadStateForDir(TMP);
      const seedPrompts = [
        'lets work on the marketing copy for atlasforge landing page',
        'atlasforge headline rewrite needs to feel more professional',
        'add atlasforge marketing cta about automation features'
      ];
      for (const goal of seedPrompts) {
        const intentRec = {
          id: require('crypto').randomUUID(),
          timestamp: Date.now() - (1000 * (seedPrompts.length - seedPrompts.indexOf(goal))),
          type: 'intent',
          agent_id: 'claude-code',
          cwd: cwdHere,
          input: { goal, source_message_hash: require('crypto').randomBytes(8).toString('hex') },
          output: { chosen_path: 'manual' },
          verification: {},
          outcome: {}
        };
        s.recordAction(intentRec, require('../shared-core/action-record').toSearchText(intentRec));
      }
    }
    runHookWithEnv('topic-shift-detect.mjs', {
      session_id: sessId,
      cwd: cwdHere,
      user_prompt: 'continue refining the atlasforge marketing copy with better headline'
    }, TMP, { TROTH_TOPIC_SHIFT: '1' });

    const s = loadStateForDir(TMP);
    const rows = s.queryActions({ type: 'decision', session_id: sessId });
    const shifts = rows
      .map(r => require('../shared-core/action-record').fromRow(r))
      .filter(p => p && p.input && p.input.kind === 'topic_shift_detected');
    assert.strictEqual(shifts.length, 0,
      'no shift expected when prompt is on-topic; got: ' + JSON.stringify(shifts));
    try { fA6.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
})();

};
