// SPDX-License-Identifier: AGPL-3.0-only
// suite-20 - Kimi Code membership as a NATIVE faculty (operator design
// correction,: "Kimi must play with BOTH depending on your
// choices"). The Kimi Code endpoint (https://api.kimi.com/coding/) is
// Anthropic-compatible, so kimi_sub runs through the shared anthropic
// transport WITHOUT the claude CLI harness when the backbone is the troth
// loop. This suite pins:
//   KIMI-TX-1   the native transport is wired to the Kimi base URL + key +
//               model (unit; inspects the outbound request, no network).
//   KIMI-TX-2   the base-URL join preserves Kimi's /coding/ path prefix and
//               is byte-identical for the Anthropic default (unit).
//   KIMI-WIRE-1 the REGRESSION GUARD for the dead-panel incident: a hard pin
//               (TROTH_ENTITY_LLM=kimi_sub + PIN=1 + a fake key) cold-boots to
//               ready and the turn FAILS HONESTLY - a transport error with
//               non-empty text and status != 'ok'. Never a silent blank, never
//               "no faculties available".
//   MODEL-KIMI-1 /engine kimi with the faculty wired (key present) sets a
//               per-pane override that dispatches to kimi_sub.
//   MODEL-KIMI-2 /engine kimi WITHOUT the key gives the honest Settings reply
//               and sets NO faculty override (fail closed).
'use strict';

module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

console.log('\nKimi native faculty (both backbones):');

const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');

// -- KIMI-TX-1 / KIMI-TX-2 - unit, no network -----------------------------
// Inspect the outbound request the transport BUILDS without letting it leave
// the machine: stub https.request to capture the options, then abort. This is
// the "inspect config without network" contract from the task.
test('KIMI-TX-1: the kimi_sub transport targets the Kimi endpoint with the membership key + model', () => {
  const https = require('https');
  const kimi = require('../shared-core/transports/kimi-sub.js');
  const orig = https.request;
  let captured = null;
  https.request = function (opts, _cb) {
    captured = opts;
    // Return a minimal request stub so stream() does not throw; we never
    // fire a callback, so no response is parsed and nothing hits the network.
    return { on() { return this; }, write() {}, end() {}, destroy() {}, destroyed: false };
  };
  try {
    const tx = kimi.makeKimiSubTransport({ api_key: 'k-fake', model: 'kimi-for-coding' });
    // Drive one stream() so the request is built. We do not iterate it.
    tx.stream({ system: 's', user: 'hi', options: {} });
    assert.ok(captured, 'the transport must open an outbound request');
    assert.strictEqual(captured.hostname, 'api.kimi.com', 'host must be api.kimi.com; got ' + captured.hostname);
    // Path preserves the /coding/ prefix (the join gotcha this whole lane hinges on).
    assert.strictEqual(captured.path, '/coding/v1/messages', 'path must keep the /coding/ prefix; got ' + captured.path);
    // The membership key rides x-api-key (same header the anthropic transport sets).
    assert.strictEqual(captured.headers['x-api-key'], 'k-fake', 'the Kimi key must ride x-api-key');
    // The key must never appear anywhere except that header (no logging leak).
    const dump = JSON.stringify({ hostname: captured.hostname, path: captured.path, method: captured.method });
    assert.ok(dump.indexOf('k-fake') === -1, 'the key must not leak into host/path/method');
  } finally {
    https.request = orig;
  }
});

test('KIMI-TX-2: the base-URL join preserves the /coding/ prefix and is byte-identical for the Anthropic default', () => {
  // The join contract the native lane depends on: an absolute-path URL drops a
  // path prefix; the relative join keeps it. This mirrors the fix in
  // anthropic.js so a regression there is caught here too.
  const { URL } = require('url');
  const join = (base) => new URL('v1/messages', base.endsWith('/') ? base : base + '/').href;
  assert.strictEqual(join('https://api.kimi.com/coding/'), 'https://api.kimi.com/coding/v1/messages');
  assert.strictEqual(join('https://api.kimi.com/coding'), 'https://api.kimi.com/coding/v1/messages');
  assert.strictEqual(join('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
});

// -- ORCH-START-FAIL - pre-stream honest-failure synthesis (unit) ---------
// The gap the p10 phase-C profile found RED: when a transport's stream()
// THROWS before producing any chunk (a BYOK/membership lane with no key), the
// orchestrator's fatalReturn used to carry EMPTY text - a silent dead panel.
// It now synthesizes an honest, engine-named, key-safe line. Faculty-agnostic.
const orchestrator = require('../shared-core/llm-orchestrator.js');

test('ORCH-START-FAIL-1: a transport that throws on start yields an aborted turn with NON-EMPTY text naming the engine', async () => {
  const throwing = {
    stream() { const e = new Error('kimi_sub transport: TROTH_KIMI_SUB_KEY not set'); e.code = 'no_api_key'; throw e; },
    abort() {},
  };
  const orch = orchestrator.makeOrchestrator({ transport: throwing, faculty_label: 'kimi_sub' });
  const res = await orch.composeAgentic(
    { prompt: 'hi', messages: [{ role: 'user', content: 'hi' }] },
    { tool_runner: function () { return { tools: [] }; } }
  );
  assert.strictEqual(res.status, 'aborted', 'a start failure must abort, not report ok; got ' + res.status);
  assert.strictEqual(res.reason, 'transport_error', 'reason must be transport_error; got ' + res.reason);
  assert(typeof res.text === 'string' && res.text.trim().length > 0, 'the aborted turn must carry non-empty text (never a silent panel); got ' + JSON.stringify(res.text));
  assert(res.text.indexOf('kimi') !== -1, 'the honest text must NAME the engine; got ' + JSON.stringify(res.text));
});

test('ORCH-START-FAIL-2: the synthesized text NEVER echoes key material (sanitized), even when the error embeds a secret', () => {
  // An error message that happens to embed a key-shaped token must be redacted
  // so the honest line can never leak a secret onto a surface or into a log.
  const secret = 'sk-ant-DEADBEEF0123456789abcdefABCDEF0123456789';
  const line = orchestrator._honestStartFailure('anthropic', new Error('auth rejected token ' + secret + ' for org'));
  assert(line.indexOf(secret) === -1, 'the key must be redacted from the honest line; got ' + line);
  assert(line.indexOf('[redacted]') !== -1, 'a redaction marker must stand in for the key; got ' + line);
  assert(line.indexOf('anthropic') !== -1, 'the engine is still named; got ' + line);
  // A long bearer/base64 run is also redacted by the sanitizer directly.
  const s = orchestrator._sanitizeStartError('Bearer eyJhbGciPADDINGPADDINGPADDINGPADDING0123456789');
  assert(s.indexOf('eyJhbGciPADDING') === -1, 'a long bearer token must be redacted; got ' + s);
  // A benign short reason (no secret) must survive - we do not scrub ordinary words.
  const c = orchestrator._honestStartFailure('kimi_sub', new Error('TROTH_KIMI_SUB_KEY not set'));
  assert(/not set/.test(c), 'a benign reason (no secret) must survive; got ' + JSON.stringify(c));
});

// -- daemon-wire tests ----------------------------------------------------
// Same driver shape as suite-11: boot the real daemon, drive it over stdin,
// collect every emitted JSON frame until it exits.
function runDaemon(lines, timeoutMs, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTITY], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Pin an absent llama binary so a virgin test home never network-fetches
        // one (same guard suite-11 uses).
        TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch',
        ...(extraEnv || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = [];
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch (_) { /* non-JSON log noise */ }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('kimi daemon E2E timed out after ' + timeoutMs + 'ms; stderr tail: ' + err.slice(-400)));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.trim();
      if (tail) { try { events.push(JSON.parse(tail)); } catch (_) { /* non-JSON noise */ } }
      resolve({ events, stderr: err, code });
    });
    child.stdin.write(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    child.stdin.end();
  });
}

test('KIMI-WIRE-1: a kimi_sub hard pin with a fake key reaches ready and FAILS HONESTLY (regression guard: no dead panel)', async () => {
  // The dead-panel incident: a kimi_sub pin fell to the
  // hard-pin branch, set TROTH_ENTITY_LLM="kimi_sub" (a non-faculty), wired
  // ZERO orchestrators, and the daemon died with "no faculties available".
  // Now kimi_sub is a REAL faculty, so the daemon must reach ready and - with
  // an unreachable endpoint - surface an HONEST transport error, never silence
  // and never the fatal "no faculties" line.
  //
  // Determinism: point the Kimi base at a black-hole address (TCP connect to
  // 127.0.0.1:1 refuses instantly) with a fake key, and cap the per-call LLM
  // timeout, so the turn aborts fast with zero network dependency.
  const { events, stderr, code } = await runDaemon([
    { type: 'user_input', input: { text: 'Say anything at all please.' }, options: { conversation_id: 'kimi-fail' } },
  ], 60000, {
    TROTH_ENTITY_LLM: 'kimi_sub',
    TROTH_ENTITY_LLM_PIN: '1',
    TROTH_KIMI_SUB_KEY: 'fake-key-for-honest-failure',
    TROTH_KIMI_SUB_BASE: 'https://127.0.0.1:1/coding/',
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  // Reached ready: the faculty wired. This is the core of the regression.
  assert(kinds.includes('ready'), 'daemon must reach ready with a kimi_sub hard pin; kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));
  // NEVER the dead-panel fatal.
  assert(!events.some((e) => e.kind === 'fatal'), 'kimi_sub must NOT emit fatal "no faculties"; got ' + JSON.stringify(events.filter((e) => e.kind === 'fatal')));
  assert(!events.some((e) => e.kind === 'fatal' && String(e.error || '').indexOf('no faculties') !== -1), 'the dead-panel "no faculties" line must never appear');

  // The turn produced a response frame that FAILS HONESTLY: status != ok, with
  // non-empty text (never a silent blank). This is the exact regression guard.
  const resp = events.find((e) => e.kind === 'response' && e.conversation_id === 'kimi-fail');
  assert(resp, 'the pinned turn must emit a response frame (honest failure, not silence); events: ' + kinds.join(','));
  assert.notStrictEqual(resp.status, 'ok', 'a fake-key kimi_sub turn must NOT report status ok; got ' + resp.status);
  assert(typeof resp.text === 'string' && resp.text.trim().length > 0, 'the honest failure must carry non-empty text; got ' + JSON.stringify(resp.text));
  assert(resp.faculty === 'kimi_sub', 'the failing turn must be attributed to the kimi_sub faculty; got ' + resp.faculty);
  void code;
});

test('KIMI-WIRE-2: a kimi_sub hard pin with NO key reaches ready and the turn fails with honest ENGINE-NAMED text (orchestrator synthesis)', async () => {
  // The pre-stream START-failure path: with no TROTH_KIMI_SUB_KEY, the kimi_sub
  // transport's stream() THROWS no_api_key before any chunk. The faculty still
  // WIRES (the factory does not need the key), so the daemon reaches ready; the
  // TURN then fails, and the orchestrator must synthesize honest, engine-named,
  // key-safe text instead of an empty silent panel. This is the exact gap the
  // p10 phase-C profile found red; this asserts it green over the real wire.
  const { events, stderr, code } = await runDaemon([
    { type: 'user_input', input: { text: 'Say anything at all please.' }, options: { conversation_id: 'kimi-nokey-pin' } },
  ], 60000, {
    TROTH_ENTITY_LLM: 'kimi_sub',
    TROTH_ENTITY_LLM_PIN: '1',
    TROTH_KIMI_SUB_KEY: '', // intentionally absent => stream() throws no_api_key
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon must reach ready even with no key (faculty wires lazily); kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));
  assert(!events.some((e) => e.kind === 'fatal'), 'a no-key kimi_sub pin must NOT emit a fatal "no faculties" frame');

  const resp = events.find((e) => e.kind === 'response' && e.conversation_id === 'kimi-nokey-pin');
  assert(resp, 'the no-key turn must emit a response frame (honest failure, not silence); events: ' + kinds.join(','));
  assert.notStrictEqual(resp.status, 'ok', 'a no-key kimi_sub turn must NOT report status ok; got ' + resp.status);
  assert(typeof resp.text === 'string' && resp.text.trim().length > 0, 'the honest failure must carry NON-EMPTY text (this was the silent-panel gap); got ' + JSON.stringify(resp.text));
  // The synthesized line names the engine and points the operator at a fix.
  assert(resp.text.indexOf('kimi') !== -1, 'the honest text must NAME the kimi engine; got ' + JSON.stringify(resp.text));
  assert(/settings|key/i.test(resp.text), 'the honest text must point at the key/Settings; got ' + JSON.stringify(resp.text));
  void code;
});

test('MODEL-KIMI-1: /engine kimi with the faculty wired sets a per-pane override that dispatches to kimi_sub', async () => {
  // With the key present, /engine kimi is a REAL per-pane engine override (not
  // the honest backbone punt). The deterministic /engine reply confirms the
  // faculty, and the NEXT plain turn's dispatch frame must show kimi_sub. The
  // (unreachable) endpoint then aborts cleanly - we only probe the dispatch
  // choice, which is emitted before the transport streams.
  const A = 'kimi-model-A';
  const { events, stderr } = await runDaemon([
    { type: 'user_input', input: { text: '/engine kimi' }, options: { conversation_id: A } },
    { type: 'user_input', input: { text: 'Say something in pane A please.' }, options: { conversation_id: A } },
  ], 60000, {
    // Primary faculty is echo so the daemon boots without a real key; kimi_sub
    // is reachable via the /engine override. Key present => faculty is wired.
    TROTH_ENTITY_LLM: 'echo',
    TROTH_KIMI_SUB_KEY: 'fake-key-wired',
    TROTH_KIMI_SUB_BASE: 'https://127.0.0.1:1/coding/',
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon reached ready; kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));
  assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');

  // The /engine kimi command is deterministic and names the kimi_sub faculty
  // (a real per-pane override, not the Settings punt).
  const modelReply = events.find((e) => e.kind === 'response' && e.conversation_id === A
    && typeof e.text === 'string' && e.text.indexOf('✓') !== -1);
  assert(modelReply, 'the /engine kimi command replied naming the kimi_sub faculty (wired path); responses: '
    + JSON.stringify(events.filter((e) => e.kind === 'response' && e.conversation_id === A).map((e) => e.text)));

  // The next plain turn's dispatch frame must show kimi_sub with the override.
  const dispatchA = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
  assert(dispatchA.some((e) => e.faculty === 'kimi_sub'),
    'pane A next turn dispatched to kimi_sub; got ' + JSON.stringify(dispatchA));
});

test('MODEL-KIMI-2: /engine kimi WITHOUT the key gives the honest Settings reply and sets NO faculty override', async () => {
  // Fail closed: with no membership key the native faculty cannot wire, so
  // /engine kimi keeps the honest backbone reply pointing at Settings and does
  // NOT pin an unwired faculty. The next plain turn must therefore dispatch to
  // the default (echo), never kimi_sub.
  const A = 'kimi-nokey-A';
  const { events, stderr } = await runDaemon([
    { type: 'user_input', input: { text: '/engine kimi' }, options: { conversation_id: A } },
    { type: 'user_input', input: { text: 'Say something in pane A please.' }, options: { conversation_id: A } },
  ], 60000, {
    TROTH_ENTITY_LLM: 'echo',
    // TROTH_KIMI_SUB_KEY intentionally UNSET => faculty unwired.
    TROTH_KIMI_SUB_KEY: '',
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon reached ready; kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));

  // The /engine kimi reply is the honest backbone/Settings punt (names Settings,
  // does NOT claim kimi_sub is pinned).
  const modelReply = events.find((e) => e.kind === 'response' && e.conversation_id === A
    && typeof e.text === 'string' && /settings/i.test(e.text));
  assert(modelReply, 'unwired /engine kimi must reply honestly pointing at Settings; responses: '
    + JSON.stringify(events.filter((e) => e.kind === 'response' && e.conversation_id === A).map((e) => e.text)));
  assert(modelReply.text.indexOf('kimi_sub') === -1, 'the unwired reply must NOT claim a kimi_sub override was set');

  // No override => the next plain turn dispatches to the default faculty, not kimi_sub.
  const dispatchA = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
  assert(dispatchA.length >= 1, 'pane A produced a dispatch frame; got ' + JSON.stringify(dispatchA));
  assert(dispatchA.every((e) => e.faculty !== 'kimi_sub'), 'unwired /engine kimi must NOT route the pane to kimi_sub; got ' + JSON.stringify(dispatchA));
});

// -- ensemble-membership tests ----------------
// A linked-but-not-pinned Kimi membership must be a FULL Auto ensemble member:
// its faculty sits in BOTH boot priority lists with the other subscription
// faculties, so the transport-abort rescue walk can rescue THROUGH it, and its
// absence (no key) leaves every path unchanged.

test('KIMI-ENS-1a: with the key and no pin, kimi_sub is a priority_default ensemble member (selectable, not just pinnable)', async () => {
  // Hosted-prefer Auto (no pin) => FACULTY_PRIORITY = claude_cli, codex_oauth,
  // kimi_sub, anthropic, router, ... . claude_cli/codex_oauth are NOT wired
  // here, so with the membership key present kimi_sub is the TOP wired hosted
  // faculty and priority_default must select it for a plain turn. Pre-fix,
  // kimi_sub was absent from FACULTY_PRIORITY, so priority_default could never
  // pick it (it was reachable only via /engine kimi or a hard pin). The endpoint
  // is black-holed (connect refused instantly, network-free) so the turn then
  // fails honestly - we assert only the PICK, emitted before the transport runs.
  const { events, stderr } = await runDaemon([
    { type: 'user_input', input: { text: 'Say anything at all please.' }, options: { conversation_id: 'kimi-ens-pick' } },
  ], 60000, {
    TROTH_ENTITY_LLM: 'echo',                  // boots without a real key; not a hosted faculty
    TROTH_ENTITY_DISPATCH_PREFER: 'hosted',
    TROTH_KIMI_SUB_KEY: 'fake-key-ensemble',   // membership present => kimi_sub WIRES
    // This test pins the ENSEMBLE layer below coherence derivation: a
    // kimi-only machine legitimately derives the claude_cli harness shape
    // (DERIVE-2 owns that contract), which would swallow the native-lane
    // mechanics asserted here. Declare the layer explicitly.
    TROTH_DERIVE: '0',
    TROTH_KIMI_SUB_BASE: 'https://127.0.0.1:1/coding/',
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon reached ready; kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));
  assert(!events.some((e) => e.kind === 'fatal'), 'no fatal frame; got ' + JSON.stringify(events.filter((e) => e.kind === 'fatal')));

  const dispatch = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === 'kimi-ens-pick');
  const primary = dispatch.find((e) => e.rule === 'priority_default');
  assert(primary, 'the plain turn produced a priority_default pick; dispatch frames: ' + JSON.stringify(dispatch.map((e) => ({ f: e.faculty, r: e.rule }))));
  assert.strictEqual(primary.faculty, 'kimi_sub', 'priority_default must select the wired kimi_sub over echo (it now sits in FACULTY_PRIORITY); got ' + primary.faculty);
});

test('KIMI-ENS-1b: with the key and no pin, a dead PRIMARY above kimi_sub rescues THROUGH it (the walk reaches the Kimi rung)', async () => {
  // The transport-abort rescue walk. local-first order =
  //   llamacpp, router, claude_cli, codex_oauth, kimi_sub, ollama, anthropic
  // Pin the primary to llamacpp (so AUTO_BACKSTOP is OFF and llamacpp keeps its
  // index-0 selection slot) and black-hole its server (TROTH_LLAMACPP_HOST at a
  // connect-refused address, plus a missing autostart binary): the primary turn
  // aborts fast with a transport_ reason and ZERO streamed output - WALKABLE.
  // The walk then steps local-first order and, because kimi_sub is now a member
  // sitting AFTER the local/CLI tiers, MUST emit a fallback dispatch frame
  // naming it. kimi_sub is also black-holed, so the turn ultimately fails - the
  // regression under test is purely "did the walk rescue THROUGH kimi_sub",
  // which the frame proves. Pre-fix, kimi_sub was absent so the walk skipped it.
  const { events, stderr } = await runDaemon([
    { type: 'user_input', input: { text: 'Say anything at all please.' }, options: { conversation_id: 'kimi-ens-walk' } },
  ], 60000, {
    TROTH_ENTITY_LLM: 'llamacpp',              // primary at index 0 of local-first (AUTO_BACKSTOP off)
    // local-first is the default (DISPATCH_PREFER unset) - stated explicitly for clarity.
    TROTH_ENTITY_DISPATCH_PREFER: '',
    TROTH_LLAMACPP_HOST: 'http://127.0.0.1:1', // connect refused => transport abort, zero output
    TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-autostart',
    TROTH_KIMI_SUB_KEY: 'fake-key-ensemble',   // membership present => kimi_sub WIRES as a walk rung
    TROTH_DERIVE: '0',                         // ensemble-layer test; see KIMI-ENS-1a
    TROTH_KIMI_SUB_BASE: 'https://127.0.0.1:1/coding/',
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon reached ready; kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));
  assert(!events.some((e) => e.kind === 'fatal'), 'no fatal frame; got ' + JSON.stringify(events.filter((e) => e.kind === 'fatal')));

  const dispatch = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === 'kimi-ens-walk');
  // Primary pick is llamacpp (index 0 of local-first, explicitly wired).
  assert(dispatch.some((e) => e.faculty === 'llamacpp' && e.rule === 'priority_default'), 'primary turn dispatched to llamacpp; got ' + JSON.stringify(dispatch.map((e) => ({ f: e.faculty, r: e.rule }))));
  // The walk emits a dispatch frame per rescued-through faculty with a
  // 'fallback:...' rule. kimi_sub MUST appear among them - the ensemble member
  // the walk now reaches. This is the exact behavior the gap removed.
  const kimiRescue = dispatch.find((e) => e.faculty === 'kimi_sub' && typeof e.rule === 'string' && e.rule.indexOf('fallback:') === 0);
  assert(kimiRescue,
    'the rescue walk must ATTEMPT kimi_sub (dispatch frame faculty kimi_sub, rule fallback:*); dispatch frames: '
    + JSON.stringify(dispatch.map((e) => ({ f: e.faculty, r: e.rule }))));
});

test('KIMI-ENS-2: WITHOUT the key, kimi_sub is absent from the ensemble and the walk never names it (no behavior change)', async () => {
  // Inert-without-key: with no TROTH_KIMI_SUB_KEY, kimi_sub never wires (never
  // enters orchestrators), so priority_default cannot select it and the walk's
  // orchestrators[alt] gate skips it. The same dead-primary turn walks, but no
  // dispatch frame ever names kimi_sub. This is the "existing tests keep
  // passing / no behavior change" guarantee, pinned directly.
  const { events, stderr } = await runDaemon([
    { type: 'user_input', input: { text: 'Say anything at all please.' }, options: { conversation_id: 'kimi-nokey-ens' } },
  ], 60000, {
    TROTH_ENTITY_LLM: 'anthropic',
    TROTH_ENTITY_DISPATCH_PREFER: 'hosted',
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
    ANTHROPIC_BASE_URL: 'https://127.0.0.1:1',
    TROTH_KIMI_SUB_KEY: '', // no key => faculty never wires
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon reached ready; kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));
  const dispatch = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === 'kimi-nokey-ens');
  assert(dispatch.some((e) => e.faculty === 'anthropic'), 'primary still dispatched to anthropic; got ' + JSON.stringify(dispatch.map((e) => ({ f: e.faculty, r: e.rule }))));
  assert(dispatch.every((e) => e.faculty !== 'kimi_sub'),
    'unwired kimi_sub must NEVER be picked or walked to; dispatch frames: '
    + JSON.stringify(dispatch.map((e) => ({ f: e.faculty, r: e.rule }))));
});

test('KIMI-ENS-3: FENCE - a pinned turn (FALLBACK_ALLOW excludes kimi_sub) never touches kimi_sub even when wired', async () => {
  // The ChatGPT-pin fence shape: the app rides the Claude Code backbone
  // (HARD_PIN off) and passes TROTH_ENTITY_FALLBACK_ALLOW = the faculties
  // allowed to serve/rescue the pinned engine (for a ChatGPT pin:
  // claude_cli,codex_oauth,router). kimi_sub is wired (key present) but OUTSIDE
  // that fence, so the FALLBACK_ALLOW filter strips it from FACULTY_PRIORITY:
  // neither the pick nor the walk may reach kimi_sub. An excluded engine must
  // not rescue a pinned turn.
  //
  // Determinism: the allowlist here also names anthropic so the black-holed
  // primary survives the filter and produces the walkable abort on a machine-
  // independent, network-free endpoint (codex_oauth would hit a real saved
  // token on a dev box). The fence SEMANTICS under test are identical - a wired
  // faculty (kimi_sub) that is NOT in the allowlist is unreachable for pick AND
  // walk - regardless of which in-fence engine drives the primary.
  const { events, stderr } = await runDaemon([
    { type: 'user_input', input: { text: 'Say anything at all please.' }, options: { conversation_id: 'kimi-fence' } },
  ], 60000, {
    // Primary = black-holed anthropic (walkable abort); fence allows anthropic +
    // router but NOT kimi_sub, exactly as a ChatGPT pin excludes kimi_sub.
    TROTH_ENTITY_LLM: 'anthropic',
    TROTH_ENTITY_DISPATCH_PREFER: 'hosted',
    TROTH_ENTITY_FALLBACK_ALLOW: 'anthropic,router',
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
    ANTHROPIC_BASE_URL: 'https://127.0.0.1:1',
    // kimi_sub IS wired (key present) but must stay unreachable behind the fence.
    TROTH_KIMI_SUB_KEY: 'fake-key-fenced',
    TROTH_KIMI_SUB_BASE: 'https://127.0.0.1:1/coding/',
    TROTH_LLM_TIMEOUT_MS: '8000',
  });

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon reached ready; kinds: ' + kinds.slice(0, 10).join(',') + '; stderr tail: ' + String(stderr).slice(-300));
  const dispatch = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === 'kimi-fence');
  assert(dispatch.length >= 1, 'the pinned turn produced a dispatch frame; got ' + JSON.stringify(dispatch.map((e) => ({ f: e.faculty, r: e.rule }))));
  assert(dispatch.every((e) => e.faculty !== 'kimi_sub'),
    'the pin fence must EXCLUDE kimi_sub from pick AND walk even when wired; dispatch frames: '
    + JSON.stringify(dispatch.map((e) => ({ f: e.faculty, r: e.rule }))));
});

// -- ENGINE-PIN-SWITCH — a pin must not confiscate the operator's own switch --
test('ENGINE-PIN-SWITCH: a hard pin still LISTS and BINDS the operator\'s other configured engines, while plain turns stay pinned', async () => {
  // Operator report: with Settings on "Always use Kimi membership"
  // (TROTH_ENTITY_LLM_PIN=1), /engine inside the app offered only Kimi and the
  // two auto modes — no ChatGPT, no Claude, no Local — though Settings listed
  // them all. HARD_PIN wired nothing but the pinned engine, so the menu had
  // nothing real to show AND an explicit switch had nowhere to land: the
  // operator's explicit choice blocked by the setting meant to express it.
  //
  // Wiring their credentialed faculties fixes the menu but must NOT weaken the
  // pin, so this asserts all three at once — a change that wins one and loses
  // another is not a fix.
  const os2 = require('os');
  const fs2 = require('fs');
  const home = fs2.mkdtempSync(path.join(os2.tmpdir(), 'engine-pin-switch-'));
  fs2.mkdirSync(path.join(home, '.troth'), { recursive: true });
  // Every credentialed engine points at a black hole (127.0.0.1 refuses the
  // connection at once): the case is about which faculty a switch binds to,
  // never about a provider answering, and a test never leaves the machine.
  fs2.writeFileSync(path.join(home, '.troth', 'config.json'), JSON.stringify({
    providers: {
      deepseek:   { enabled: true,  apiKey: 'sk-fake-deepseek', endpoint: '127.0.0.1' },
      anthropic:  { enabled: true,  apiKey: 'sk-fake-anthropic', endpoint: '127.0.0.1' },
      local:      { enabled: true,  host: '127.0.0.1', port: 1234 },
      openrouter: { enabled: false, apiKey: 'sk-fake-or' },  // OFF    -> never offered
      xai:        { enabled: true }                          // no key -> never offered
    }
  }));

  const A = 'pin-menu-A', B = 'pin-switch-B';
  const { events, stderr } = await runDaemon([
    { type: 'user_input', input: { text: '/engine' },           options: { conversation_id: A } },
    { type: 'user_input', input: { text: 'plain turn please' }, options: { conversation_id: A } },
    { type: 'user_input', input: { text: '/engine deepseek' },  options: { conversation_id: B } },
    { type: 'user_input', input: { text: 'plain turn please' }, options: { conversation_id: B } }
  ], 90000, {
    HOME: home,
    TROTH_ENTITY_LLM: 'kimi_sub',
    TROTH_ENTITY_LLM_PIN: '1',
    TROTH_KIMI_SUB_KEY: 'fake-key-wired',
    TROTH_KIMI_SUB_BASE: 'https://127.0.0.1:1/coding/',
    TROTH_LLM_TIMEOUT_MS: '6000'
  });

  assert(events.some((e) => e.kind === 'ready'),
    'daemon must reach ready under a hard pin; stderr tail: ' + String(stderr).slice(-300));

  // 1. the menu names the engines the config actually credentials
  const reply = events.find((e) => e.kind === 'response' && e.conversation_id === A && Array.isArray(e.options));
  assert(reply, '/engine under a pin must return a structured options[]; responses: '
    + JSON.stringify(events.filter((e) => e.kind === 'response' && e.conversation_id === A).map((e) => e.text)));
  const values = reply.options.map((o) => o.value);
  for (const want of ['/engine anthropic', '/engine local', '/engine deepseek']) {
    assert(values.includes(want), 'the pinned menu must offer ' + want + '; got ' + values.join(' | '));
  }
  // Fail closed: never offer what is switched off or cannot authenticate.
  assert(!values.includes('/engine openrouter'), 'a DISABLED provider must never be offered; got ' + values.join(' | '));
  assert(!values.includes('/engine xai'), 'an uncredentialed provider must never be offered; got ' + values.join(' | '));

  // 2. the pin survives: an ordinary turn still goes to the pinned engine
  const dA = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A).map((e) => e.faculty);
  assert(dA.length > 0 && dA.every((f) => f === 'kimi_sub'),
    'a plain turn under a hard pin must stay on the pinned engine; got ' + JSON.stringify(dA));

  // 3. an EXPLICIT switch binds — the whole reason for showing the menu
  const dB = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === B).map((e) => e.faculty);
  assert(dB[0] === 'router',
    'an explicit /engine deepseek must dispatch to the router faculty FIRST; got ' + JSON.stringify(dB));

  try { fs2.rmSync(home, { recursive: true, force: true }); } catch (_) {}
});

};
