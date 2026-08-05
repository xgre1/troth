// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// suite-18: MCP hands - governed external-MCP surface ( audit +
// operator design). The partner's "extra hands" (external MCP servers) used
// to run UNGOVERNED: mcp_call spawned a downstream and ran tools/call outside
// the STVC intent system. This suite pins the governed replacement end to end:
//   MCPH-1 workspace-layered registry (global + project .mcp.json, project wins)
//   MCPH-2 $vault env resolution (resolves when unlocked+authorized; locked
//          vault SKIPS with a warning and never throws / never leaks the value)
//   MCPH-3 http-transport entry translates to an npx mcp-remote stdio bridge
//   MCPH-4 governed REFUSAL: mcp_call with no sealed capability fails closed and
//          the downstream is NEVER contacted (asserted via the mock)
//   MCPH-5 governed SUCCESS: seal capability:mcp:testsrv, mcp_call succeeds and
//          an observation engram exists (queried from the hermetic DB)
//   MCPH-6 wildcard capability:mcp:* covers any server; exact-name does NOT
//          cover a different server (adapter defense-in-depth)
//   MCPH-7 backbone gateway: flag OFF => no troth_mcp_* in tools/list; ON => present
//   MCPH-8 self-authorization still blocked: path-policy refuses writing the
//          ~/.troth/mcp-clients.json registry (regression pin)
//
// Conversational registration flow (: paste in chat -> partner
// stages via mcp_register_request -> operator approves once):
//   MCPH-9  mcp_register_request validates strictly and stages into the
//           pending file (atomic, 0600, registry shape, $vault verbatim)
//   MCPH-10 INERTNESS: a pending-only server never resolves (loadDownstream,
//           mcp_list, governed mcp_call all refuse it)
//   MCPH-11 duplicate pending name overwrites (latest wins); a name already
//           ACTIVE refuses with already_active (global AND workspace layers)
//   MCPH-12 policy split: pending file (+ .tmp) partner-WRITABLE, active
//           registry still blocked (path-policy AND bash-safety, both ways)
//   MCPH-13 `troth mcp approve <name>` (headless passphrase) moves the entry
//           pending -> active + seals capability:mcp:<name>; server resolves
//   MCPH-13b after approval the governed mcp_call succeeds via the CLI-sealed
//           capability (mock transport)
//   MCPH-14 `troth mcp pending` lists staged entries; `troth mcp reject`
//           removes one (single-JSON-line CLI contract)
//   MCPH-15 audio system prompt with the FULL unified tool surface carries
//           the registration sentence and stays under the 3400 cap untruncated
//
// The MCPH- prefix is deliberate: suite-12 already owns MH-* (MCP HOSTS), and
// these are MCP HANDS - a name collision would tangle the two in the runner
// output and let one suite's failure masquerade as the other's.
//
// Hermetic: tests/hermetic-db.js has already redirected HOME before this file
// loads (test-all.js requires it first). Registry/vault fixtures live under
// throwaway tmpdirs; the MCP-server tests (MCPH-7) spawn against their own
// throwaway HOME exactly like suite-17. The governed tests (MCPH-4/5/6) need an
// operator signer; if an earlier suite already sealed the shared hermetic DB's
// operator_key:active they self-skip (same discipline as suite-07's L4 dispatch
// block) - run this suite standalone for the full governed assertions.
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mcpClient = require('../shared-core/tools/mcp-client.js');
const intentMod = require('../shared-core/intent.js');
const eng       = require('../shared-core/engram.js');
const opKey     = require('../shared-core/operator-key.js');
const boot      = require('../shared-core/bootstrap.js');
const dispatcher = require('../shared-core/dispatcher.js');
const pathPolicy = require('../shared-core/tools/path-policy.js');
const bashSafety = require('../shared-core/tools/bash-safety.js');
const vault     = require('../shared-core/vault.js');

const SERVER = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-substrate', 'server.mjs');

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s18-' + (tag || '') + '-')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj), 'utf8'); }

// Drive the substrate MCP server over stdio (suite-17 pattern) with a
// throwaway HOME so the real ~/.troth is never touched.
function rpcServer(requests, extraEnv) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s18-home-'));
  try {
    const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const r = spawnSync(process.execPath, [SERVER], {
      input, timeout: 15000, killSignal: 'SIGKILL', encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: tmpHome }, extraEnv || {})
    });
    const byId = {};
    for (const line of (r.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && typeof msg.id !== 'undefined') byId[msg.id] = msg;
    }
    return byId;
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } };
function toolNames(res, id) {
  const msg = res[id];
  assert(msg && msg.result && Array.isArray(msg.result.tools), 'tools/list answered with a tools array');
  return msg.result.tools.map((t) => t.name);
}

// ── Daemon-wire E2E helper (suite-11 pattern) ────────────────────────────
// Boot the REAL entity daemon (bin/troth-entity.js) over stdin and collect
// every emitted JSON frame. Unlike suite-11's runDaemon (fire-all-then-close),
// this variant keeps stdin OPEN and lets the caller (a) send lines lazily and
// (b) resolve as soon as a predicate matches a frame — the watcher frame is
// asynchronous (fs.watch + 150ms debounce) and would race a stdin-EOF drain.
const { spawn } = require('child_process');
const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');

// Custom transport that, on the FIRST (non-tool) turn, issues one
// mcp_register_request tool_call with the given name/config, then echoes the
// tool result on the follow-up. Drives the REAL native-pane staging path
// (model -> runner -> stagePendingServer -> pending file -> watcher).
function stagingTransportSrc(name, config, note) {
  const arg = JSON.stringify({ name, config, note: note || undefined });
  return [
    "'use strict';",
    "module.exports = {",
    "  stream: async function* (req) {",
    "    const messages = Array.isArray(req && req.messages) ? req.messages : [];",
    "    const last = messages[messages.length - 1] || {};",
    "    if (last.role === 'tool') {",
    "      yield { delta: 'STAGED' };",
    "      yield { done: true };",
    "      return;",
    "    }",
    "    yield { tool_calls: [{ id: 'stage_1', function: { name: 'mcp_register_request', arguments: " + JSON.stringify(arg) + " } }] };",
    "    yield { done: true };",
    "  },",
    "  abort: () => {}",
    "};",
    ""
  ].join('\n');
}

// Boot the daemon; call onFrame for each emitted frame. Resolves with the
// full frame list once stopFn() is invoked and the process closes, or rejects
// on timeout. extraEnv layers over the hermetic defaults.
function bootDaemon({ lines, extraEnv, onFrame, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTITY], {
      cwd: process.cwd(),
      env: { ...process.env, TROTH_ENTITY_LLM: 'echo', TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch', ...(extraEnv || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = [];
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error('daemon E2E timed out; stderr tail: ' + err.slice(-400))); }, timeoutMs || 60000);
    const api = {
      send: (obj) => { try { child.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'); } catch (_) {} },
      stop: () => { try { child.stdin.end(); } catch (_) {} },
    };
    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        let ev = null;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        events.push(ev);
        try { if (onFrame) onFrame(ev, api); } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      const tail = out.trim();
      if (tail) { try { events.push(JSON.parse(tail)); } catch (_) {} }
      resolve({ events, stderr: err });
    });
    for (const l of (lines || [])) api.send(l);
  });
}

module.exports = function run({ test, skip }) {
  console.log('\nMCP hands (governed external-MCP surface):');

  // ── E2E daemon-wire harness (suite-11 pattern) ───────────────────────────
  // The conversational-registration UX rides two new surfaces:
  //   * a pending-file watcher in the entity daemon that emits an
  //     {kind:'mcp_pending_request', server, transport, note} frame the app
  //     listens for (covers BOTH native panes and the claude-cli backbone, since
  //     the pending file is the one cross-process fact both share), and
  //   * a /mcps slash command that lists ACTIVE + PENDING servers with no secrets.
  // Both are only observable end to end by driving the REAL daemon over stdin,
  // exactly like suite-11. spawn (not spawnSync) so the watcher's async frame
  // can arrive while the process is live.
  const { spawn } = require('child_process');
  const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');

  // A transport that, on the FIRST model turn, calls mcp_register_request with
  // the config parsed out of a [stage:<json>] directive in the user text, then
  // (turn 2, seeing the tool result) echoes it. This exercises the REAL native-
  // pane staging path: model calls the tool -> runner stages the pending file
  // -> the daemon watcher emits mcp_pending_request. Mirrors suite-11's
  // CONC_TRANSPORT_SRC shape (a stdio module exporting stream + abort).
  const STAGE_TRANSPORT_SRC = [
    "'use strict';",
    "module.exports = {",
    "  stream: async function* (req) {",
    "    const messages = Array.isArray(req && req.messages) ? req.messages : [];",
    "    const last = messages[messages.length - 1] || {};",
    "    if (last.role === 'tool') {",
    "      yield { delta: 'STAGED' };",
    "      yield { done: true };",
    "      return;",
    "    }",
    "    let userText = '';",
    "    for (let i = messages.length - 1; i >= 0; i--) {",
    "      const m = messages[i];",
    "      if (m && m.role === 'user' && typeof m.content === 'string') { userText = m.content; break; }",
    "    }",
    "    const mt = userText.match(/\\[stage:(.+)\\]/);",
    "    if (mt) {",
    "      const spec = JSON.parse(mt[1]);",
    "      yield { tool_calls: [{ id: 'stage_1', function: { name: 'mcp_register_request', arguments: JSON.stringify(spec) } }] };",
    "      yield { done: true };",
    "      return;",
    "    }",
    "    yield { delta: 'NOSTAGE' };",
    "    yield { done: true };",
    "  },",
    "  abort: () => {}",
    "};",
    ""
  ].join('\n');

  // Boot the daemon; run `feed(child, helpers)` once 'ready' arrives so the
  // caller can write lines / close stdin around live frames; collect every
  // JSON frame until close. Returns { events, stderr, code }.
  function driveDaemon({ lines, timeoutMs, extraEnv, onReady }) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [ENTITY], {
        cwd: process.cwd(),
        env: { ...process.env, TROTH_ENTITY_LLM: 'echo', TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch', ...(extraEnv || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const events = [];
      let out = '', err = '', readyFired = false;
      const onEvent = (ev) => {
        events.push(ev);
        if (!readyFired && ev.kind === 'ready') {
          readyFired = true;
          if (typeof onReady === 'function') {
            try { onReady(child, ev, events); } catch (e) { reject(e); }
          }
        }
      };
      child.stdout.on('data', (d) => {
        out += d.toString();
        let nl;
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch (_) { /* non-JSON log noise */ }
        }
      });
      child.stderr.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('daemon E2E timed out after ' + timeoutMs + 'ms; stderr tail: ' + err.slice(-400)));
      }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const tail = out.trim();
        if (tail) { try { events.push(JSON.parse(tail)); } catch (_) {} }
        resolve({ events, stderr: err, code });
      });
      if (Array.isArray(lines) && lines.length) {
        child.stdin.write(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
      }
      // The caller closes stdin (via onReady) when it wants shutdown; if no
      // onReady is given, close now so a plain fire-and-collect test works.
      if (typeof onReady !== 'function') child.stdin.end();
    });
  }

  // A private HOME for a spawned daemon so its state.db + default ~/.troth
  // never contend with the SHARED hermetic home the tool-level tests
  // (MCPH-9/10/11) read-modify-write concurrently. The harness starts every
  // async test body immediately (serializing only at await points), so a slow
  // daemon boot in the shared home shifts the timing enough to expose that
  // pre-existing race; a per-daemon home decouples it entirely. Mirrors
  // suite-11 SR-1 / CONC-5. Returns { home, env } where env pins HOME + a
  // per-home STATE_DB_PATH (the suite pins a shared one via hermetic-db).
  // Serialization gate for the daemon-wire tests. The harness starts every
  // async body synchronously at require time (up to its first await), and the
  // pre-existing in-process staging tests (MCPH-9/10/11/13/14) are SYNCHRONOUS
  // per tool call: they drain in a tight MICROTASK burst that never yields to a
  // macrotask, so they never clobber each other's read-modify-write on the
  // SHARED hermetic pending file. Any macrotask a daemon test schedules at
  // require time (a spawn's socket I/O, a setImmediate poll, a timer) would
  // split that burst and expose the latent race. So these tests must stay
  // purely in the microtask queue (scheduling NO macrotask) until the burst
  // has drained. `_e2eGate` is a single module-level timer scheduled ONCE that
  // fires on the first macrotask tick (after the microtask burst empties); the
  // daemon tests all await it before touching the filesystem or spawning. They
  // are also chained so they never overlap EACH OTHER.
  let _e2eGate = null;
  function _e2eGateReady() {
    if (!_e2eGate) {
      // One timer, scheduled lazily on the first daemon test's turn. Because it
      // is a setTimeout (macrotask), its callback runs only after the current
      // microtask queue (including the whole in-process staging batch) drains.
      _e2eGate = new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    return _e2eGate;
  }
  let _e2eChain = Promise.resolve();
  function e2eReady() {
    const mine = _e2eChain.then(() => _e2eGateReady());
    _e2eChain = mine.catch(() => {});
    return mine;
  }

  function makeDaemonHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s18-home-e2e-'));
    fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
    return { home, env: { HOME: home, STATE_DB_PATH: path.join(home, '.troth', 'state.db') } };
  }

  // Write the staging transport into a throwaway file + return an isolated home
  // and a hermetic pending-file path under a fresh tmp dir. Caller cleans up.
  function makeStageFixtures() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s18-e2e-'));
    const txPath = path.join(dir, 'stage-transport.js');
    fs.writeFileSync(txPath, STAGE_TRANSPORT_SRC);
    const pendingPath = path.join(dir, 'mcp-pending.json');
    const daemonHome = makeDaemonHome();
    const cleanup = () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(daemonHome.home, { recursive: true, force: true }); } catch (_) {}
    };
    return { dir, txPath, pendingPath, homeEnv: daemonHome.env, cleanup };
  }

  // ── MCPH-1: workspace-layered registry ───────────────────────────────────
  test('MCPH-1: loadDownstream merges global + project .mcp.json (project wins collisions; absent files fine)', () => {
    // Absent-both: no global path, no workspace → {} (never throws).
    assert.deepStrictEqual(mcpClient.loadDownstream('/no/such/global.json', '/no/such/workspace'), {},
      'absent global + absent project → empty object');

    const gdir = tmpDir('g'); const wdir = tmpDir('w');
    try {
      const globalPath = path.join(gdir, 'mcp-clients.json');
      writeJson(globalPath, { mcpServers: {
        shared:  { command: 'global-cmd', args: ['g'] },
        onlyglobal: { command: 'gonly' }
      } });
      // Project registry lives at <workspace>/.mcp.json.
      writeJson(path.join(wdir, '.mcp.json'), { mcpServers: {
        shared:  { command: 'project-cmd', args: ['p'] },   // collision - project must win
        onlyproj: { command: 'ponly' }
      } });

      // Global only.
      const gOnly = mcpClient.loadDownstream(globalPath, null);
      assert.strictEqual(gOnly.shared.command, 'global-cmd', 'global-only sees global entry');
      assert.ok(!gOnly.onlyproj, 'global-only does not see project entry');

      // Merged: project wins the collision, both uniques present.
      const merged = mcpClient.loadDownstream(globalPath, wdir);
      assert.strictEqual(merged.shared.command, 'project-cmd', 'project entry wins the name collision');
      assert.ok(merged.onlyglobal, 'global-only entry survives the merge');
      assert.ok(merged.onlyproj, 'project-only entry is present after merge');

      // Malformed project file must not brick global discovery.
      writeJson(path.join(wdir, '.mcp.json'), '{ this is not json');
      const stillGlobal = mcpClient.loadDownstream(globalPath, wdir);
      assert.strictEqual(stillGlobal.shared.command, 'global-cmd', 'broken project file → falls back to global');
    } finally {
      fs.rmSync(gdir, { recursive: true, force: true });
      fs.rmSync(wdir, { recursive: true, force: true });
    }
  });

  // ── MCPH-2: $vault env resolution (pure helper, no real spawn) ────────────
  test('MCPH-2: $vault env resolves when authorized; locked/unauthorized SKIPS with a warning and never throws or leaks the value', () => {
    const SECRET = 'sk-super-secret-value-do-not-leak';
    // Locked/absent vault: a $vault ref must be SKIPPED with a warning, the
    // resolved map must NOT contain the key, and nothing may throw.
    // (Vault is locked here - no unlock() was called.)
    try { vault.lock(); } catch (_) {}
    const locked = mcpClient._resolveEnvSpec({
      PLAIN: 'plainval',
      TOKEN: { $vault: 'TESTSRV_TOKEN' },
      ALT:   '$vault:TESTSRV_TOKEN'
    }, 'testsrv');
    assert.strictEqual(locked.env.PLAIN, 'plainval', 'plain env value passes through');
    assert.ok(!('TOKEN' in locked.env), 'locked vault → $vault object ref skipped, key absent');
    assert.ok(!('ALT' in locked.env), 'locked vault → $vault string ref skipped, key absent');
    assert.ok(locked.warnings.length >= 2, 'a warning is recorded per skipped $vault ref');
    // The warning names the KEY but must NEVER contain the secret value.
    assert.ok(locked.warnings.every(w => w.indexOf(SECRET) === -1), 'warnings never contain the resolved secret');

    // Now unlock a hermetic vault, store a value scoped to capability:mcp:testsrv,
    // and confirm the $vault ref resolves into the spawned env spec.
    const vdir = tmpDir('vault');
    const vaultPath = path.join(vdir, 'vault.bin');
    const savedVaultEnv = process.env.TROTH_VAULT_BIN_PATH;
    process.env.TROTH_VAULT_BIN_PATH = vaultPath;
    try {
      vault.unlock('vault-test-passphrase', { vault_path: vaultPath, scrypt_n: 1024 });
      const w = vault.writeEntry({
        key: 'TESTSRV_TOKEN',
        value: SECRET,
        capability_scope_glob: 'capability:mcp:testsrv',
        injection: { kind: 'env', name: 'TOKEN' }
      });
      assert.strictEqual(w.ok, true, 'vault write must succeed; got ' + JSON.stringify(w));
      const ok = mcpClient._resolveEnvSpec({ TOKEN: { $vault: 'TESTSRV_TOKEN' } }, 'testsrv');
      assert.strictEqual(ok.env.TOKEN, SECRET, 'authorized $vault ref resolves into the env spec');
      assert.strictEqual(ok.warnings.length, 0, 'no warnings when the ref resolves');

      // Scope gate: the SAME key requested for a DIFFERENT server (capability:mcp:other)
      // must NOT resolve - the entry is scoped to capability:mcp:testsrv.
      const wrong = mcpClient._resolveEnvSpec({ TOKEN: { $vault: 'TESTSRV_TOKEN' } }, 'other');
      assert.ok(!('TOKEN' in wrong.env), 'entry scoped to testsrv does not resolve for a different server');
      assert.ok(wrong.warnings.length >= 1, 'scope mismatch records a warning');
      assert.ok(wrong.warnings.every(x => x.indexOf(SECRET) === -1), 'scope-mismatch warning never leaks the value');
    } finally {
      try { vault.lock(); } catch (_) {}
      if (savedVaultEnv === undefined) delete process.env.TROTH_VAULT_BIN_PATH;
      else process.env.TROTH_VAULT_BIN_PATH = savedVaultEnv;
      fs.rmSync(vdir, { recursive: true, force: true });
    }
  });

  // ── MCPH-3: http/sse entry translates to the npx mcp-remote stdio bridge ──
  test('MCPH-3: http/sse transport entry translates to an npx mcp-remote stdio bridge spec', () => {
    const httpSpec = mcpClient._toSpawnSpec('remote', { type: 'http', url: 'https://mcp.example.com/v1' });
    assert.strictEqual(httpSpec.command, 'npx', 'http entry bridges via npx');
    assert.deepStrictEqual(httpSpec.args, ['-y', 'mcp-remote', 'https://mcp.example.com/v1'],
      'args are the mcp-remote bridge invocation with the url');

    // The alternate `transport` key + sse type both take the bridge path.
    const sseSpec = mcpClient._toSpawnSpec('remote2', { transport: 'sse', url: 'https://sse.example.com' });
    assert.strictEqual(sseSpec.command, 'npx', 'sse entry also bridges via npx');
    assert.strictEqual(sseSpec.args[2], 'https://sse.example.com', 'sse url carried into the bridge');

    // A plain stdio entry is passed through UNCHANGED (no bridge).
    const stdioSpec = mcpClient._toSpawnSpec('local', { command: 'node', args: ['server.js'] });
    assert.strictEqual(stdioSpec.command, 'node', 'stdio entry keeps its command');
    assert.deepStrictEqual(stdioSpec.args, ['server.js'], 'stdio entry keeps its args');
  });

  // ── Shared operator-key bootstrap for the governed tests (MH-4/5/6) ───────
  // Same discipline as suite-07's L4 dispatch suite: bootstrap a throwaway
  // operator key so writeCapability can seal operator-tier capabilities. If
  // the substrate already carries an operator key from an earlier suite, we
  // skip the signing-dependent assertions rather than fight it.
  const SUITE_PASS = 'mcp-hands-suite-passphrase';
  const SUITE_DIR  = tmpDir('opkey');
  const _savedKeyDir = process.env.TROTH_OPERATOR_KEY_DIR;
  process.env.TROTH_OPERATOR_KEY_DIR = SUITE_DIR;
  let _suiteSigner = null;
  let _suiteSkip   = null;
  const _existingKey = eng.listEngrams({ principal: null, audience: 'all', scope: 'operator_key:active', limit: 1 }) || [];
  if (_existingKey.length) {
    _suiteSkip = 'substrate already has operator_key:active from an earlier suite';
  } else {
    const _r = boot.runInit({ passphrase: SUITE_PASS, key_dir: SUITE_DIR, scrypt_n: 1024 });
    if (!_r.ok) _suiteSkip = 'shared bootstrap failed: ' + _r.error;
    else _suiteSigner = opKey.unlock(SUITE_PASS, { key_dir: SUITE_DIR });
  }

  // Seal an operator-tier capability. CRITICAL: the signed canonical body's
  // extra_output must EXACTLY equal what writeCapability persists - that means
  // the FULL base shape (payload_schema, max_irreversibility, expiry, revoked,
  // scope_glob, parent_capability_id), same as bin/cmd-cap.js. A partial
  // extra_output silently fails signature verification (recordEngram returns
  // falsy → capability_write_refused).
  function _sealCap(scope, max) {
    const extra = {
      payload_schema: null,
      max_irreversibility: max || 'medium',
      expiry: null,
      revoked: false,
      scope_glob: scope,
      parent_capability_id: null
    };
    const canon = opKey.canonicalEngramBody({
      statement: 'cap ' + scope, scope,
      source_authority: 'operator_confirmed', extra_output: extra
    });
    return intentMod.writeCapability({
      scope, statement: 'cap ' + scope,
      max_irreversibility: max || 'medium',
      signature: _suiteSigner.sign(canon),
      extra_output: extra
    });
  }
  // A sealed grounding engram so grounded_in_sealed is satisfiable. scope
  // presence_proof is one of the auto-resolver's preferred grounding scopes.
  function _sealGrounding() {
    const canon = opKey.canonicalEngramBody({
      statement: 'mcp-hands suite grounding', scope: 'presence_proof',
      source_authority: 'operator_confirmed', extra_output: {}
    });
    return eng.recordEngram({
      agent_id: 'l4-mcp-hands-suite', user_id: 'operator', cwd: null,
      statement: 'mcp-hands suite grounding', source: 'test fixture',
      source_authority: 'operator_confirmed', scope: 'presence_proof',
      signature: _suiteSigner.sign(canon), auto_verify: false
    });
  }

  // ── MCPH-4: governed REFUSAL - no sealed cap, downstream never contacted ──
  test('MCPH-4: mcp_call WITHOUT a sealed capability fails closed (STVC refusal) and NEVER contacts the downstream', async () => {
    if (_suiteSkip) skip(_suiteSkip);
    let contacted = false;
    const res = await mcpClient.REGISTRY.mcp_call.run(
      { server: 'unsealed_server_xyz', tool: 'anything', args: { a: 1 } },
      { agent_id: 'mh4', user_id: 'operator', _mcp_mock: () => { contacted = true; return { ok: true }; } }
    );
    // Fail-closed: not a crash, not a success, explicitly refused at the write wall.
    assert.strictEqual(res.ok, false, 'refused, not ok');
    assert.strictEqual(res.refused, true, 'flagged as a governance refusal');
    assert.strictEqual(res.stage, 'write', 'refused at the write-time STVC wall');
    assert.strictEqual(res.reason, 'intent_refused_at_write', 'refusal reason is the STVC write wall');
    assert.strictEqual(contacted, false, 'the downstream MCP was NEVER contacted (mock never fired)');
    assert.ok(/troth cap mint capability:mcp:unsealed_server_xyz/.test(res.hint || ''),
      'hint guides the operator to seal a capability; got ' + res.hint);
  });

  // ── MCPH-5: governed SUCCESS - sealed cap, mock succeeds, observation exists
  test('MCPH-5: sealing capability:mcp:testsrv makes mcp_call succeed (via mock) and writes an observation engram', async () => {
    if (_suiteSkip) skip(_suiteSkip);
    const cap = _sealCap('capability:mcp:testsrv', 'medium');
    assert.strictEqual(cap.ok, true, 'capability seal must succeed; got ' + JSON.stringify(cap));
    _sealGrounding();

    let mockSaw = null;
    const res = await mcpClient.REGISTRY.mcp_call.run(
      { server: 'testsrv', tool: 'echo', args: { msg: 'hi' } },
      { agent_id: 'mh5', user_id: 'operator', _mcp_mock: (x) => { mockSaw = x; return { content: [{ type: 'text', text: 'pong' }] }; } }
    );
    assert.strictEqual(res.ok, true, 'governed call must succeed; got ' + JSON.stringify(res));
    assert.strictEqual(res.auto_resolved, true, 'substrate auto-resolved the sealed capability');
    assert.strictEqual(res.capability_ref, cap.id, 'auto-selected the sealed capability:mcp:testsrv');
    assert.ok(mockSaw && mockSaw.server === 'testsrv' && mockSaw.tool === 'echo', 'mock saw the right server/tool');
    assert.ok(res.observation_id, 'an observation engram id is returned');

    // Query the hermetic DB: the observation engram exists and points back at
    // the intent (same assertion shape as suite-07 L4-DISP-2).
    const obs = eng.listEngrams({ principal: null, audience: 'all', scope: 'observation', limit: 50 }) || [];
    const hit = obs.find(e => e.id === res.observation_id);
    assert.ok(hit, 'observation engram is listable from the hermetic DB');
    assert.strictEqual(hit.observes_intent, res.intent_id, 'observation.observes_intent points back at the intent');
  });

  // ── MCPH-6: wildcard covers any server; exact-name does not cover another ─
  test('MCPH-6: capability:mcp:* covers any server; an exact-name capability does NOT cover a different server', async () => {
    if (_suiteSkip) skip(_suiteSkip);
    // Pure mapping-level assertions (used by both the STVC wall and auto-resolve).
    assert.strictEqual(intentMod.mcpCapabilityCoversIntent('capability:mcp:*', 'intent:mcp:call:whatever'), true,
      'wildcard covers any server');
    assert.strictEqual(intentMod.mcpCapabilityCoversIntent('capability:mcp:alpha', 'intent:mcp:call:alpha'), true,
      'exact-name covers its own server');
    assert.strictEqual(intentMod.mcpCapabilityCoversIntent('capability:mcp:alpha', 'intent:mcp:call:beta'), false,
      'exact-name does NOT cover a different server');
    assert.strictEqual(intentMod.mcpCapabilityCoversIntent('capability:http:do:x', 'intent:mcp:call:alpha'), false,
      'a non-mcp capability never covers an mcp intent');

    // End-to-end: a wildcard seal lets a brand-new, never-sealed server through.
    const capW = _sealCap('capability:mcp:*', 'medium');
    assert.strictEqual(capW.ok, true, 'wildcard capability seal must succeed');
    _sealGrounding();
    const res = await mcpClient.REGISTRY.mcp_call.run(
      { server: 'never_sealed_before_' + Date.now(), tool: 't', args: {} },
      { agent_id: 'mh6', user_id: 'operator', _mcp_mock: () => ({ ok: true, result: { done: 1 } }) }
    );
    assert.strictEqual(res.ok, true, 'wildcard capability authorizes an arbitrary server; got ' + JSON.stringify(res));

    // Adapter-level defense-in-depth (dispatch-time re-check).
    const mcpDo = require('../shared-core/dispatchers/mcp-do.js');
    assert.strictEqual(mcpDo._capabilityCoversServer('capability:mcp:alpha', 'alpha'), true);
    assert.strictEqual(mcpDo._capabilityCoversServer('capability:mcp:alpha', 'beta'), false);
    assert.strictEqual(mcpDo._capabilityCoversServer('capability:mcp:*', 'anything'), true);
  });

  // ── Conversational registration flow (paste -> stage -> approve once) ────

  // ── MCPH-9: mcp_register_request validates strictly and stages ───────────
  test('MCPH-9: mcp_register_request validates strictly and stages into the pending file (atomic, 0600, registry shape, $vault verbatim)', async () => {
    const tool = mcpClient.REGISTRY.mcp_register_request;
    // Bad names refuse before anything touches disk.
    for (const bad of ['', 'UPPER', 'has space', 'x'.repeat(65), 'semi;colon']) {
      const r = await tool.run({ name: bad, config: { command: 'x' } }, {});
      assert.strictEqual(r.ok, false, 'bad name "' + bad + '" refused');
      assert.ok(r.error === 'bad_name' || r.error === 'bad_args', 'bad name flagged; got ' + JSON.stringify(r));
    }
    // Bad configs refuse with a paste-back-able detail (strict normalizer:
    // only the shapes _toSpawnSpec understands, nothing rides along).
    const badConfigs = [
      { headers: { A: 'b' }, type: 'http', url: 'https://x.example' },  // unsupported remote key
      { type: 'http' },                                                 // missing url
      { type: 'websocket', url: 'https://x.example' },                  // unsupported transport
      { command: 'x', args: [1] },                                      // non-string args
      { command: 'x', env: { TOKEN: { $vault: 'K', extra: 1 } } },      // malformed $vault ref
      { command: '' },                                                  // empty command
      { command: 'x', cwd: '/tmp' }                                     // unsupported stdio key
    ];
    for (const cfg of badConfigs) {
      const r = await tool.run({ name: 'regstage', config: cfg }, {});
      assert.strictEqual(r.ok, false, 'bad config refused: ' + JSON.stringify(cfg));
      assert.strictEqual(r.error, 'bad_config', 'flagged bad_config; got ' + JSON.stringify(r));
    }
    // Good stdio entry with a $vault env ref stages; the ref stays VERBATIM
    // (resolution happens only at spawn time, after activation).
    const ok = await tool.run({
      name: 'regstage',
      config: { command: 'npx', args: ['-y', 'some-mcp'], env: { TOKEN: { $vault: 'REGSTAGE_TOKEN' }, PLAIN: 'v' } },
      note: 'staged by MCPH-9'
    }, {});
    assert.strictEqual(ok.ok, true, 'valid request stages; got ' + JSON.stringify(ok));
    assert.strictEqual(ok.pending, true, 'result is flagged pending');
    assert.ok(/Registered for approval/.test(ok.hint) && ok.hint.indexOf('regstage') !== -1,
      'hint tells the partner to ask the operator; got ' + ok.hint);
    const p = mcpClient._pendingPath();
    assert.ok(fs.existsSync(p), 'pending file exists at ' + p);
    assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600, 'pending file is 0600');
    assert.ok(!fs.existsSync(p + '.tmp'), 'atomic temp file did not linger');
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const entry = obj.mcpServers && obj.mcpServers.regstage;
    assert.ok(entry, 'entry landed under mcpServers (registry shape)');
    assert.deepStrictEqual(entry.env.TOKEN, { $vault: 'REGSTAGE_TOKEN' }, '$vault ref stored verbatim, never resolved');
    assert.ok(obj.notes && obj.notes.regstage && obj.notes.regstage.note === 'staged by MCPH-9',
      'note kept for the operator surfaces');
    // A remote entry normalizes to the clean {type, url} shape.
    const okHttp = await tool.run({ name: 'reghttp', config: { transport: 'sse', url: 'https://mcp.example.com/v1' } }, {});
    assert.strictEqual(okHttp.ok, true, 'http/sse request stages; got ' + JSON.stringify(okHttp));
    const obj2 = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(obj2.mcpServers.reghttp, { type: 'sse', url: 'https://mcp.example.com/v1' },
      'remote entry normalized to {type, url}');
  });

  // ── MCPH-10: INERTNESS - a pending-only server never resolves ────────────
  test('MCPH-10: INERTNESS - a pending-only server never resolves for loadDownstream / mcp_list / governed mcp_call', async () => {
    const reg = await mcpClient.REGISTRY.mcp_register_request.run(
      { name: 'ghostpending', config: { command: 'definitely-not-a-real-binary' } }, {});
    assert.strictEqual(reg.ok, true, 'staging succeeds; got ' + JSON.stringify(reg));
    // The resolver merges ONLY global + project files; the pending file is
    // not an input, so the staged name must not appear.
    const resolved = mcpClient.loadDownstream(null, null);
    assert.ok(!Object.prototype.hasOwnProperty.call(resolved, 'ghostpending'),
      'loadDownstream never reads the pending file');
    // mcp_list: unknown server (nothing is ever spawned for an unknown name).
    const listed = await mcpClient.REGISTRY.mcp_list.run({ server: 'ghostpending' }, {});
    assert.strictEqual(listed.error, 'spawn_failed', 'mcp_list refuses the pending-only name');
    assert.ok(/unknown downstream server/.test(String(listed.detail)),
      'refusal names the unknown server; got ' + listed.detail);
    // Governed mcp_call: NEVER ok. Depending on what earlier tests sealed it
    // dies at the write wall (no capability) or at dispatch (unknown
    // downstream) - both fail closed, and neither path spawns anything.
    const called = await mcpClient.REGISTRY.mcp_call.run(
      { server: 'ghostpending', tool: 'anything', args: {} },
      { agent_id: 'mh10', user_id: 'operator' });
    assert.strictEqual(called.ok, false,
      'governed call on a pending-only server is never ok; got ' + JSON.stringify(called));
    if (called.stage === 'dispatch') {
      assert.ok(/unknown downstream server/.test(String(called.reason)),
        'dispatch failed on registry resolution, not a spawn; got ' + called.reason);
    } else {
      assert.strictEqual(called.stage, 'write', 'otherwise refused at the write-time STVC wall');
    }
  });

  // ── MCPH-11: overwrite semantics + already_active refusal ────────────────
  test('MCPH-11: duplicate pending name overwrites (latest wins); a name already ACTIVE refuses with already_active', async () => {
    const tool = mcpClient.REGISTRY.mcp_register_request;
    const p = mcpClient._pendingPath();
    const first = await tool.run({ name: 'dupwin', config: { command: 'old-cmd' }, note: 'v1' }, {});
    assert.strictEqual(first.ok, true, 'first staging succeeds');
    const second = await tool.run({ name: 'dupwin', config: { command: 'new-cmd' } }, {});
    assert.strictEqual(second.ok, true, 'restaging the same name succeeds (overwrite)');
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(obj.mcpServers.dupwin.command, 'new-cmd', 'latest staging wins');
    assert.ok(!obj.notes || !obj.notes.dupwin, 'stale note from the overwritten request is gone');

    // ACTIVE in the workspace .mcp.json layer -> refused.
    const ws = tmpDir('ws-active');
    try {
      writeJson(path.join(ws, '.mcp.json'), { mcpServers: { wsactive: { command: 'x' } } });
      const r = await tool.run({ name: 'wsactive', config: { command: 'y' } }, { cwd: ws });
      assert.strictEqual(r.ok, false, 'workspace-active name refused');
      assert.strictEqual(r.reason, 'already_active', 'refusal reason is already_active; got ' + JSON.stringify(r));
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }

    // ACTIVE in the global mcp-clients.json layer -> refused. Save/restore
    // the hermetic global file so this test leaves no trace.
    const activePath = mcpClient._activeGlobalPath();
    const hadActive = fs.existsSync(activePath);
    const savedActive = hadActive ? fs.readFileSync(activePath, 'utf8') : null;
    try {
      fs.mkdirSync(path.dirname(activePath), { recursive: true });
      fs.writeFileSync(activePath, JSON.stringify({ mcpServers: { globactive: { command: 'x' } } }));
      const r = await tool.run({ name: 'globactive', config: { command: 'y' } }, {});
      assert.strictEqual(r.ok, false, 'globally-active name refused');
      assert.strictEqual(r.reason, 'already_active', 'refusal reason is already_active; got ' + JSON.stringify(r));
      const pend = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.ok(!pend.mcpServers.globactive, 'nothing was staged for the refused name');
    } finally {
      if (hadActive) fs.writeFileSync(activePath, savedActive);
      else { try { fs.unlinkSync(activePath); } catch (_) {} }
    }
  });

  // ── MCPH-12: policy split - pending writable, active blocked ─────────────
  test('MCPH-12: policy split - pending file (+.tmp) partner-WRITABLE (inert), active registry still blocked (path-policy + bash-safety)', () => {
    // Tilde form for the same HOME-immunity reason as MCPH-8.
    const pw = pathPolicy.isWritablePath('~/.troth/mcp-pending.json', {});
    assert.strictEqual(pw.allowed, true, 'pending file is partner-writable (inert staging target)');
    const pt = pathPolicy.isWritablePath('~/.troth/mcp-pending.json.tmp', {});
    assert.strictEqual(pt.allowed, true, 'pending atomic temp file is partner-writable');
    // The active registry stays blocked - approval is the security boundary.
    const av = pathPolicy.isWritablePath('~/.troth/mcp-clients.json', {});
    assert.strictEqual(av.allowed, false, 'active registry stays blocked');
    assert.strictEqual(av.pattern, 'mcp_clients', 'blocked by the mcp_clients rule');
    // bash-safety: same split for shell writes.
    assert.strictEqual(bashSafety.isCommandSafe('echo "{}" > ~/.troth/mcp-pending.json', {}).allowed, true,
      'shell write to the pending file is not a dangerous pattern');
    assert.strictEqual(bashSafety.isCommandSafe('cat cfg.json | tee $HOME/.troth/mcp-pending.json', {}).allowed, true,
      'tee to the pending file is allowed too');
    const blocked = bashSafety.isCommandSafe('echo "{}" >> ~/.troth/mcp-clients.json', {});
    assert.strictEqual(blocked.allowed, false, 'shell write to the ACTIVE registry stays blocked');
    assert.strictEqual(blocked.pattern, 'rewrite_mcp_clients', 'blocked by the registry rewrite rule');
  });

  // ── MCPH-13: operator approval moves + seals (headless CLI) ──────────────
  test('MCPH-13: `troth mcp approve` (headless passphrase) moves pending -> active and seals capability:mcp:<name>; the server then resolves', () => {
    if (_suiteSkip) skip(_suiteSkip);
    const TROTH_BIN = path.join(__dirname, '..', 'bin', 'troth.js');
    const NAME = 'convflow';
    const activePath = mcpClient._activeGlobalPath();
    const hadActive = fs.existsSync(activePath);
    const savedActive = hadActive ? fs.readFileSync(activePath, 'utf8') : null;
    mcpClient.stagePendingServer(NAME, { command: 'node', args: ['fake-mcp.js'] }, 'staged by MCPH-13');
    try {
      const r = spawnSync(process.execPath, [TROTH_BIN, 'mcp', 'approve', NAME], {
        encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
        env: Object.assign({}, process.env, {
          TROTH_OPERATOR_PASSPHRASE: SUITE_PASS,
          TROTH_MCP_PENDING_CONFIG:  mcpClient._pendingPath(),
          TROTH_MCP_CLIENTS_CONFIG:  activePath
        })
      });
      assert.strictEqual(r.status, 0, 'approve exits 0; stdout=' + r.stdout + ' stderr=' + r.stderr);
      // Machine-friendly contract: ONE parseable JSON line on stdout (the
      // desktop app invokes this headlessly and parses it).
      const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 1, 'exactly one stdout line; got ' + JSON.stringify(lines));
      const out = JSON.parse(lines[0]);
      assert.strictEqual(out.ok, true, 'approve reports ok');
      assert.strictEqual(out.approved, NAME, 'approve names the server');
      assert.strictEqual(out.capability_scope, 'capability:mcp:' + NAME, 'sealed the per-server scope');
      assert.ok(out.capability_id, 'capability engram id returned');
      // Moved: active has it, pending does not.
      const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      assert.ok(active.mcpServers && active.mcpServers[NAME], 'entry landed in the ACTIVE registry');
      const pend = JSON.parse(fs.readFileSync(mcpClient._pendingPath(), 'utf8'));
      assert.ok(!pend.mcpServers[NAME], 'entry left the pending file');
      assert.ok(!pend.notes || !pend.notes[NAME], 'note cleaned up with it');
      // Sealed: the capability engram is in the shared hermetic DB and its
      // scope covers the server's intent scope under the mcp mapping.
      const caps = eng.listEngrams({ principal: null, audience: 'all', limit: 2000 }) || [];
      const cap = caps.find(e => e.id === out.capability_id);
      assert.ok(cap, 'capability engram listable from the hermetic DB');
      assert.strictEqual(cap.scope, 'capability:mcp:' + NAME, 'capability scope matches');
      assert.strictEqual(intentMod.mcpCapabilityCoversIntent(cap.scope, 'intent:mcp:call:' + NAME), true,
        'sealed capability covers the server\'s call scope');
      // The server NOW resolves for discovery.
      const resolved = mcpClient.loadDownstream(activePath, null);
      assert.ok(resolved[NAME] && resolved[NAME].command === 'node',
        'approved server resolves from the active registry');
    } finally {
      // Leave the hermetic global registry as found (MCPH-15 measures the
      // prompt against a deterministic global state).
      if (hadActive) fs.writeFileSync(activePath, savedActive);
      else { try { fs.unlinkSync(activePath); } catch (_) {} }
    }
  });

  // ── MCPH-13b: end-to-end - staged, approved, then governed call works ────
  test('MCPH-13b: after approval the governed mcp_call succeeds (paste -> stage -> approve -> call, mock transport)', async () => {
    if (_suiteSkip) skip(_suiteSkip);
    let mockSaw = null;
    const res = await mcpClient.REGISTRY.mcp_call.run(
      { server: 'convflow', tool: 'ping', args: { a: 1 } },
      { agent_id: 'mh13b', user_id: 'operator', _mcp_mock: (x) => { mockSaw = x; return { content: [{ type: 'text', text: 'pong' }] }; } }
    );
    assert.strictEqual(res.ok, true, 'governed call after approval succeeds; got ' + JSON.stringify(res));
    assert.strictEqual(res.auto_resolved, true, 'substrate auto-resolved operator-sealed authority');
    assert.ok(mockSaw && mockSaw.server === 'convflow', 'dispatch reached the (mock) downstream');
  });

  // ── MCPH-14: pending list + reject (operator hygiene, no signer needed) ──
  test('MCPH-14: `troth mcp pending` lists staged entries; `troth mcp reject` removes one (single-JSON-line CLI)', () => {
    const TROTH_BIN = path.join(__dirname, '..', 'bin', 'troth.js');
    mcpClient.stagePendingServer('rejectme', { command: 'x' }, 'do not want');
    const cliEnv = Object.assign({}, process.env, { TROTH_MCP_PENDING_CONFIG: mcpClient._pendingPath() });
    const listed = spawnSync(process.execPath, [TROTH_BIN, 'mcp', 'pending'],
      { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', env: cliEnv });
    assert.strictEqual(listed.status, 0, 'pending exits 0; stderr=' + listed.stderr);
    const listLines = (listed.stdout || '').trim().split('\n').filter(Boolean);
    assert.strictEqual(listLines.length, 1, 'one JSON line; got ' + JSON.stringify(listLines));
    const listOut = JSON.parse(listLines[0]);
    assert.strictEqual(listOut.ok, true, 'pending reports ok');
    const row = (listOut.pending || []).find((x) => x.name === 'rejectme');
    assert.ok(row, 'staged entry listed');
    assert.strictEqual(row.note, 'do not want', 'note surfaces to the operator');
    const rej = spawnSync(process.execPath, [TROTH_BIN, 'mcp', 'reject', 'rejectme'],
      { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', env: cliEnv });
    assert.strictEqual(rej.status, 0, 'reject exits 0; stderr=' + rej.stderr);
    assert.strictEqual(JSON.parse((rej.stdout || '').trim()).rejected, 'rejectme', 'reject names the entry');
    const pend = JSON.parse(fs.readFileSync(mcpClient._pendingPath(), 'utf8'));
    assert.ok(!pend.mcpServers.rejectme, 'entry removed from the pending file');
    // Rejecting an unknown name refuses with exit 2 + one stderr JSON line.
    const rej2 = spawnSync(process.execPath, [TROTH_BIN, 'mcp', 'reject', 'rejectme'],
      { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', env: cliEnv });
    assert.strictEqual(rej2.status, 2, 'second reject exits 2');
    const errOut = JSON.parse((rej2.stderr || '').trim().split('\n').pop());
    assert.strictEqual(errOut.ok, false, 'stderr line is machine-parseable');
    assert.strictEqual(errOut.error, 'not_pending', 'names the refusal');
  });

  // ── MCPH-15: audio prompt stays under the cap with the new sentence ──────
  test('MCPH-15: audio system prompt with the full unified tool surface carries the registration sentence and never truncates', () => {
    const sp = require('../shared-core/tools/system-prompt.js');
    const toolRunner = require('../shared-core/tools/runner.js');
    const names = toolRunner.unifiedToolsArray().map((t) => t.function && t.function.name).filter(Boolean);
    assert.ok(names.includes('mcp_register_request'), 'the staging tool is on the unified surface');
    // Deterministic global layer: point the resolver at an absent file for
    // the duration of the two builds.
    const savedCfg = process.env.TROTH_MCP_CLIENTS_CONFIG;
    process.env.TROTH_MCP_CLIENTS_CONFIG = path.join(os.tmpdir(), 'no-such-mcp-clients-' + Date.now() + '.json');
    const ws = tmpDir('sp-ws');
    try {
      writeJson(path.join(ws, '.mcp.json'), { mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } });
      for (const [label, cwd] of [['no hands', '/no/such/workspace-xyz'], ['one hand', ws]]) {
        const out = sp.buildSystemPrompt({ agent_id: 'partner', cwd, available_tools: names, audio: true });
        assert.ok(out.length <= sp.DEFAULT_MAX_CHARS,
          label + ' prompt fits the cap; ' + out.length + ' > ' + sp.DEFAULT_MAX_CHARS);
        assert.ok(out.indexOf('(truncated)') === -1, label + ' prompt is not truncated');
        assert.ok(out.indexOf('call mcp_register_request with it') !== -1,
          label + ' prompt carries the registration sentence');
        assert.ok(out.indexOf('AUDIO MODE') !== -1, label + ' prompt keeps the audio tail (nothing sliced)');
      }
    } finally {
      if (savedCfg === undefined) delete process.env.TROTH_MCP_CLIENTS_CONFIG;
      else process.env.TROTH_MCP_CLIENTS_CONFIG = savedCfg;
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // async ON PURPOSE. The harness runs a synchronous body the moment it is
  // declared and queues an async one to run in declaration order afterwards.
  // This teardown locks the signer that MCPH-5 and MCPH-6 need, and those two
  // are async, so as a sync test it fired first and left them failing with
  // "operator-key.signer: already locked" whenever the suite ran on its own.
  // Being async puts it back behind the tests it is cleaning up after.
  test('MCPH-DISP-CLEANUP', async () => {
    try { if (_suiteSigner) _suiteSigner.lock(); } catch (_) {}
    try { fs.rmSync(SUITE_DIR, { recursive: true, force: true }); } catch (_) {}
    if (_savedKeyDir === undefined) delete process.env.TROTH_OPERATOR_KEY_DIR;
    else process.env.TROTH_OPERATOR_KEY_DIR = _savedKeyDir;
  });

  // ── MCPH-7: backbone gateway visibility follows the flag ──────────────────
  test('MCPH-7: backbone gateway - flag OFF hides all troth_mcp_*; flag ON exposes list/describe/call', () => {
    const off = rpcServer([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { TROTH_MCP_ACTIONS: '' });
    const offNames = toolNames(off, 2);
    // troth_image_generate rides the SAME flag: the backbone MCP
    // gateway never exposed the worldly image_generate, so claude-cli panes (the
    // product default) could not create images. Flag OFF must hide it too.
    for (const n of ['troth_mcp_list', 'troth_mcp_describe', 'troth_mcp_call', 'troth_mcp_register_request', 'troth_image_generate']) {
      assert.ok(!offNames.includes(n), n + ' absent when flag off');
    }
    const on = rpcServer([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { TROTH_MCP_ACTIONS: '1' });
    const onNames = toolNames(on, 2);
    // register_request included: the system
    // prompt tells the partner to stage pasted configs via
    // mcp_register_request, but the backbone tools/list never carried it -
    // so on claude-cli panes the conversational-registration flow was dead.
    // troth_image_generate is the same class of gap (image creation was dead on
    // the backbone), wired under the same flag.
    for (const n of ['troth_mcp_list', 'troth_mcp_describe', 'troth_mcp_call', 'troth_mcp_register_request', 'troth_image_generate']) {
      assert.ok(onNames.includes(n), n + ' present when flag on');
    }
    // troth_image_generate carries the prompt property on its inputSchema and
    // states it uses the ChatGPT plan + saves a PNG locally. We assert SHAPE
    // only - never firing a real image call (no network in tests).
    const img = on[2].result.tools.find((t) => t.name === 'troth_image_generate');
    assert.ok(img && img.inputSchema && img.inputSchema.properties && img.inputSchema.properties.prompt,
      'troth_image_generate advertises a prompt property');
    assert.ok(/ChatGPT plan/.test(img.description || '') && /PNG/.test(img.description || ''),
      'description states it uses the ChatGPT plan and saves a PNG locally; got ' + img.description);
    // The pre-existing action tools are still there (we EXTENDED the block).
    assert.ok(onNames.includes('troth_intent_emit') && onNames.includes('troth_browser_do'),
      'extending the block must not drop the existing action tools');
    // troth_mcp_call advertises the governed contract, not a raw passthrough.
    const call = on[2].result.tools.find((t) => t.name === 'troth_mcp_call');
    assert.ok(call && call.inputSchema && call.inputSchema.properties && call.inputSchema.properties.server,
      'troth_mcp_call takes {server, tool, args}');
    assert.ok(/GOVERNED|intent:mcp:call/.test(call.description || ''), 'description states it is governed');
  });

  // ── MCPH-8: self-authorization stays blocked (regression pin) ─────────────
  test('MCPH-8: path-policy refuses writing the ~/.troth/mcp-clients.json registry (self-authorization block)', () => {
    // Authoritative check via the TILDE form: path-policy expands ~ on BOTH
    // the blocklist prefix and this input using its own captured HOME, so the
    // assertion is immune to earlier suites mutating process.env.HOME (several
    // do - suite-12/13/14). An absolute-path check that read live HOME could
    // mismatch path-policy's captured HOME and spuriously pass.
    const vh = pathPolicy.isWritablePath('~/.troth/mcp-clients.json', {});
    assert.strictEqual(vh.allowed, false, 'partner may not write the MCP registry (tilde form)');
    assert.strictEqual(vh.pattern, 'mcp_clients', 'blocked by the mcp_clients rule');
    // The atomic-write temp target is blocked too (no sneaking via .tmp). It is
    // caught by the mcp_clients prefix rule first (first-match-wins, since the
    // .tmp path starts with mcp-clients.json); the pin is that the write is
    // refused, by an mcp-registry rule.
    const vt = pathPolicy.isWritablePath('~/.troth/mcp-clients.json.tmp', {});
    assert.strictEqual(vt.allowed, false, 'the atomic-write temp path is also blocked');
    assert.ok(/^mcp_clients/.test(vt.pattern || ''), 'blocked by an mcp-registry rule; got ' + vt.pattern);
    // The rule is present in the exported blocklist with the audit citation.
    const rule = pathPolicy.BLOCKED_PREFIXES.find(e => e.name === 'mcp_clients');
    assert.ok(rule && /self-authorization/.test(rule.why), 'mcp_clients rule documents the self-authorization risk');
  });

  // ── Conversational-registration UX: pending-file watcher + /mcps

  // ── MCPH-16: staging a server over the DAEMON WIRE emits mcp_pending_request
  // The partner (model) calls mcp_register_request in the agentic loop -> the
  // runner stages ~/.troth/mcp-pending.json -> the daemon's pending-file watcher
  // emits {kind:'mcp_pending_request', server, transport, note}. This is the
  // signal the app listens for to raise its Accept/Reject popup. The watcher is
  // the ONE mechanism that covers both native panes (tool in-process) and the
  // claude-cli backbone (tool in the separate troth-substrate MCP process):
  // the file is the only cross-process fact both share. Frame is UNTAGGED (fires
  // outside any turn context), correct for a global, cross-pane approval popup.
  test('MCPH-16: staging over the daemon wire emits an untagged mcp_pending_request frame with {server, transport, note}', async () => {
    await e2eReady();
    const fx = makeStageFixtures();
    try {
      const spec = { name: 'e2estage', config: { command: 'npx', args: ['-y', 'some-mcp'] }, note: 'staged over the wire' };
      const { events, stderr, code } = await driveDaemon({
        timeoutMs: 90000,
        extraEnv: {
          ...fx.homeEnv,
          TROTH_ENTITY_LLM: fx.txPath,
          TROTH_ENTITY_LLM_PIN: '1',
          TROTH_MCP_PENDING_CONFIG: fx.pendingPath,
        },
        onReady: (child) => {
          // Drive one staging turn, then close stdin so the daemon drains +
          // shuts down cleanly. drainAndStop waits for the in-flight turn, and
          // the watcher's debounced frame lands before/while it drains.
          child.stdin.write(JSON.stringify({
            type: 'user_input',
            input: { text: 'please add this server [stage:' + JSON.stringify(spec) + ']' },
            options: { conversation_id: 'stage-pane' }
          }) + '\n');
          // Give the tool run + fs.watch debounce (150ms) time to fire before EOF.
          setTimeout(() => { try { child.stdin.end(); } catch (_) {} }, 4000);
        }
      });
      const kinds = events.map((e) => e.kind);
      assert(kinds.includes('ready'), 'daemon must reach ready; stderr tail: ' + String(stderr || '').slice(-300));
      assert(kinds.includes('stopped'), 'clean shutdown (exit ' + code + ')');
      // The staging actually wrote the pending file (native-pane path exercised).
      const staged = JSON.parse(fs.readFileSync(fx.pendingPath, 'utf8'));
      assert.ok(staged.mcpServers && staged.mcpServers.e2estage, 'the tool staged the entry into the hermetic pending file');
      // The watcher emitted the app-facing frame.
      const frame = events.find((e) => e.kind === 'mcp_pending_request' && e.server === 'e2estage');
      assert.ok(frame, 'watcher emitted mcp_pending_request for the staged server; kinds: ' + kinds.join(','));
      assert.strictEqual(frame.transport, 'stdio', 'stdio config surfaces transport=stdio; got ' + frame.transport);
      assert.strictEqual(frame.note, 'staged over the wire', 'note carried into the frame; got ' + frame.note);
      // Cross-pane broadcast: the pending frame is UNTAGGED even though the
      // staging turn was on a tagged pane (a global popup, not a pane reply).
      assert.ok(!('conversation_id' in frame), 'pending-request frame must be untagged (global approval signal)');
    } finally { fx.cleanup(); }
  });

  // ── MCPH-17: /mcps lists ACTIVE (planted registry) + PENDING (planted file) ──
  test('MCPH-17: /mcps over the wire returns text naming an active server (planted registry) and a pending one (planted file)', async () => {
    await e2eReady();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s18-mcp17-'));
    const activePath = path.join(dir, 'mcp-clients.json');
    const pendingPath = path.join(dir, 'mcp-pending.json');
    const dh = makeDaemonHome();
    try {
      // Planted ACTIVE registry: one stdio, one http server.
      writeJson(activePath, { mcpServers: {
        activestdio: { command: 'node', args: ['s.js'] },
        activehttp:  { type: 'http', url: 'https://mcp.example.com/v1' }
      } });
      // Planted PENDING file (registry shape + notes sibling).
      writeJson(pendingPath, {
        mcpServers: { pendingsrv: { command: 'npx', args: ['-y', 'x'] } },
        notes: { pendingsrv: { note: 'from the docs', requested_at: Date.now() } }
      });
      const { events, stderr } = await driveDaemon({
        lines: [{ type: 'user_input', input: { text: '/mcps' }, options: { conversation_id: 'mcp17-pane' } }],
        timeoutMs: 90000,
        extraEnv: {
          ...dh.env,
          TROTH_MCP_CLIENTS_CONFIG: activePath,
          TROTH_MCP_PENDING_CONFIG: pendingPath,
        }
      });
      const kinds = events.map((e) => e.kind);
      assert(kinds.includes('ready'), 'daemon must reach ready; stderr tail: ' + String(stderr || '').slice(-300));
      const resp = events.find((e) => e.kind === 'response' && e.conversation_id === 'mcp17-pane');
      assert.ok(resp, 'a tagged response frame must come back for /mcps; kinds: ' + kinds.join(','));
      assert.strictEqual(resp.faculty, 'deterministic', '/mcps is a deterministic slash reply; got ' + resp.faculty);
      const text = String(resp.text || '');
      assert.ok(/ACTIVE/.test(text), 'lists an ACTIVE section; text: ' + text.slice(0, 300));
      assert.ok(text.indexOf('activestdio') !== -1, 'names the active stdio server; text: ' + text.slice(0, 300));
      assert.ok(text.indexOf('activehttp') !== -1, 'names the active http server');
      assert.ok(/PENDING/.test(text), 'lists a PENDING section');
      assert.ok(text.indexOf('pendingsrv') !== -1, 'names the pending server');
      assert.ok(/awaiting your approval/.test(text), 'marks the pending server as awaiting approval');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.rmSync(dh.home, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── MCPH-18: /mcps output NEVER contains a secret ($vault value or env/url) ──
  test('MCPH-18: /mcps output masks all secrets: no $vault value, no env secret, no remote url leaks', async () => {
    await e2eReady();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s18-mcp18-'));
    const activePath = path.join(dir, 'mcp-clients.json');
    const pendingPath = path.join(dir, 'mcp-pending.json');
    const dh = makeDaemonHome();
    const ENV_SECRET   = 'sk-active-env-secret-DO-NOT-LEAK';
    const VAULT_VALUE  = 'VAULTKEY_pending_DO_NOT_LEAK';   // the $vault ref NAME (also must not surface)
    const REMOTE_URL   = 'https://secret-host.example.com/private/mcp?token=abc123';
    try {
      // Active server carrying a plaintext env secret AND a credential-bearing url.
      writeJson(activePath, { mcpServers: {
        secretsrv: { type: 'http', url: REMOTE_URL, env: { API_KEY: ENV_SECRET } }
      } });
      // Pending server carrying a $vault ref + a plaintext env secret.
      writeJson(pendingPath, {
        mcpServers: { pendsecret: { command: 'node', env: { TOKEN: { $vault: VAULT_VALUE }, PLAIN: ENV_SECRET } } },
        notes: { pendsecret: { note: 'needs the api key', requested_at: Date.now() } }
      });
      const { events, stderr } = await driveDaemon({
        lines: [{ type: 'user_input', input: { text: '/mcps' }, options: { conversation_id: 'mcp18-pane' } }],
        timeoutMs: 90000,
        extraEnv: {
          ...dh.env,
          TROTH_MCP_CLIENTS_CONFIG: activePath,
          TROTH_MCP_PENDING_CONFIG: pendingPath,
        }
      });
      const kinds = events.map((e) => e.kind);
      assert(kinds.includes('ready'), 'daemon must reach ready; stderr tail: ' + String(stderr || '').slice(-300));
      const resp = events.find((e) => e.kind === 'response' && e.conversation_id === 'mcp18-pane');
      assert.ok(resp, 'a response frame must come back for /mcps; kinds: ' + kinds.join(','));
      const text = String(resp.text || '');
      // The server NAMES still show (the operator needs them), but NO secret does.
      assert.ok(text.indexOf('secretsrv') !== -1, 'active server name still listed; text: ' + text.slice(0, 300));
      assert.ok(text.indexOf('pendsecret') !== -1, 'pending server name still listed');
      assert.ok(text.indexOf(ENV_SECRET) === -1, 'env secret value must never appear in /mcps output');
      assert.ok(text.indexOf(VAULT_VALUE) === -1, 'the $vault ref value must never appear in /mcps output');
      assert.ok(text.indexOf(REMOTE_URL) === -1, 'a remote url (may carry a token) must never appear in /mcps output');
      assert.ok(text.indexOf('$vault') === -1, 'no $vault ref of any kind is surfaced');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.rmSync(dh.home, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── MCPH-19: /mcps deterministic handler unit (read-only, secret-masked) ────
  // A cheap in-process pin (no daemon spawn) that the handler itself never
  // leaks a secret and never spawns a server, so a regression is caught fast.
  test('MCPH-19: the /mcps deterministic handler lists names + transports, masks secrets, and never spawns', async () => {
    // Gate before mutating process.env: this test flips TROTH_MCP_CLIENTS_CONFIG
    // + TROTH_MCP_PENDING_CONFIG (both process-global), and the harness runs
    // async bodies interleaved. Without the gate, the flip would land mid-flight
    // in a concurrent in-process staging test (MCPH-11) and redirect its
    // _pendingPath() to this test's isolated file. e2eReady() holds until the
    // synchronous staging burst has drained (see the gate note above).
    await e2eReady();
    const slashParser = require('../shared-core/slash/parser.js');
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    assert.ok(typeof DETERMINISTIC_HANDLERS.mcps === 'function', '/mcps is a registered deterministic handler');
    const parsed = slashParser.parse('/mcps');
    assert.strictEqual(parsed.is_slash, true, '/mcps parses as a slash command');
    assert.strictEqual(parsed.name, 'mcps', 'the command name is mcps');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-s18-mcp19-'));
    const activePath = path.join(dir, 'mcp-clients.json');
    const pendingPath = path.join(dir, 'mcp-pending.json');
    const savedActive = process.env.TROTH_MCP_CLIENTS_CONFIG;
    const savedPending = process.env.TROTH_MCP_PENDING_CONFIG;
    process.env.TROTH_MCP_CLIENTS_CONFIG = activePath;
    process.env.TROTH_MCP_PENDING_CONFIG = pendingPath;
    try {
      writeJson(activePath, { mcpServers: { u19active: { command: 'never-spawn-this-binary', env: { K: 'sk-unit-secret' } } } });
      writeJson(pendingPath, { mcpServers: { u19pending: { type: 'sse', url: 'https://x.example/tok?s=zzz' } }, notes: {} });
      const res = await DETERMINISTIC_HANDLERS.mcps(parsed, { agent_id: 'u19', cwd: null, user_id: 'operator' });
      assert.strictEqual(res.ok, true, 'handler returns ok; got ' + JSON.stringify(res));
      const text = String(res.text || '');
      assert.ok(text.indexOf('u19active') !== -1 && text.indexOf('[stdio]') !== -1, 'active stdio server named with its transport');
      assert.ok(text.indexOf('u19pending') !== -1, 'pending server named');
      assert.ok(text.indexOf('sk-unit-secret') === -1, 'no env secret leaks');
      assert.ok(text.indexOf('https://x.example/tok?s=zzz') === -1, 'no remote url leaks');
      // sse normalizes to the http label (one remote transport family).
      assert.ok(/awaiting your approval/.test(text), 'pending entry marked awaiting approval');
    } finally {
      if (savedActive === undefined) delete process.env.TROTH_MCP_CLIENTS_CONFIG; else process.env.TROTH_MCP_CLIENTS_CONFIG = savedActive;
      if (savedPending === undefined) delete process.env.TROTH_MCP_PENDING_CONFIG; else process.env.TROTH_MCP_PENDING_CONFIG = savedPending;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
