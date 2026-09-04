// SPDX-License-Identifier: AGPL-3.0-only
// Production E2E (the production bar test bar): boot the REAL daemon
// (bin/troth-entity.js) as a child process and drive it over stdin exactly
// like the app's Rust bridge does — same wire protocol, same submit path.
// hermetic-db.js already redirected HOME to a throwaway, and children
// inherit it, so this doubles as a FRESH-INSTALL boot proof: a virgin
// ~/.troth must cold-boot to 'ready' with no manual setup.
//
// TROTH_ENTITY_LLM=echo wires the no-network fake transport (same as
// tests/smoke-entity.sh) — the full dispatch machinery runs, only the
// model call is canned. No LLM key, no spend, deterministic.
module.exports = function run({ test }) {
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

console.log('Production E2E (real daemon over stdin):');

const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');

// Captured at suite LOAD, before any other suite's flush-time body can move
// it: suite-14 points process.env.HOME at its own temp home during its load
// and only restores it inside its teardown TEST, and suites 02/04/05/06 both
// mutate HOME and wipe /shared-core/ from require.cache mid-flush. A daemon
// child spawned from a body that runs later would inherit whichever home is
// current at that moment and write its dialogue mirror THERE, while this
// suite's assertions read the hermetic one: every mirror count then comes
// back zero. Pinning the load-time value into the child env makes writer and
// reader agree no matter what the flush order does to the ambient env.
const HERMETIC_HOME = process.env.HOME;

/** Boot the daemon, write all stdin lines, close stdin, collect every
 * emitted JSON event until the process exits on its own. extraEnv layers
 * over the hermetic defaults (used by the concurrency tests to pin a
 * custom transport + concurrency cap). */
function runDaemon(lines, timeoutMs, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTITY], {
      cwd: process.cwd(),
      // TROTH_LLAMA_SERVER_BIN pins an explicit (absent) binary so
      // local-server.ensureBinary() NEVER network-fetches llama-server from a
      // virgin test home (idle upkeep → engram embed → download tarball →
      // starves the timing-sensitive phases; recall degrades to lexical,
      // which is exactly right for a hermetic run).
      env: { ...process.env, HOME: HERMETIC_HOME, TROTH_ENTITY_LLM: 'echo', TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch', ...(extraEnv || {}) },
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
      reject(new Error('daemon E2E timed out after ' + timeoutMs + 'ms; stderr tail: ' + err.slice(-400)));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    // Resolve on 'close', not 'exit': 'exit' fires when the process dies but
    // the last stdout chunk can still be in flight and gets delivered AFTER
    // 'exit' on loaded runners, which dropped the final 'stopped' event and
    // flaked this suite on CI while passing locally. 'close'
    // waits for the stdio streams to drain; the leftover buffer is parsed so
    // a final line without a trailing newline still counts.
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

// Reads the dialogue mirror in a CHILD process pinned to the hermetic home.
// The parent's own module instances are fair game for other suites: several
// wipe /shared-core/ from require.cache mid-flush and re-require while their
// temp HOME is active, so a parent-side require here can resolve to a module
// whose memoized DB handle points at a different file than the daemon wrote.
// A fresh child with HOME pinned resolves everything against the same home
// the daemon used, which is the actual contract being asserted.
function readMirror(conversationId, limit) {
  const { spawnSync } = require('child_process');
  const script = [
    "const dm = require(process.argv[1]);",
    "const agentId = require(process.argv[2]).resolveAgentId();",
    "const rows = dm.recentTurns({ agent_id: agentId, conversation_id: process.argv[3], limit: Number(process.argv[4]) });",
    "console.log(JSON.stringify(rows));",
  ].join('\n');
  const r = spawnSync(process.execPath, [
    '-e', script,
    path.join(__dirname, '..', 'shared-core', 'dialogue-memory.js'),
    path.join(__dirname, '..', 'shared-core', 'agent-id.js'),
    conversationId, String(limit),
  ], { env: { ...process.env, HOME: HERMETIC_HOME }, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error('mirror reader failed: ' + String(r.stderr || '').slice(-300));
  const lines = String(r.stdout || '').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('E2E-1: daemon cold-boots on a virgin home, serves two conversations with no cross-bleed, and shuts down clean', async () => {

  const A = 'e2e-conv-A', B = 'e2e-conv-B';
  const textA1 = 'Tell me about the substrate in two sentences please.';
  const textB1 = 'Now tell me about goals in two sentences please.';
  const textA2 = 'One more thing: say anything at all please.';

  const { events, stderr, code } = await runDaemon([
    { type: 'user_input', input: { text: textA1 }, options: { conversation_id: A } },
    { type: 'user_input', input: { text: textB1 }, options: { conversation_id: B } },
    { type: 'user_input', input: { text: textA2 }, options: { conversation_id: A } },
    // Tail turn on a throwaway conversation: the serial queue finishes A2's
    // mirror write while C streams, so shutdown can only ever clip C (not
    // asserted). The control lines would provide this cover pre-split;
    // the underlying fast-shutdown recordTurn race is noted in the plan.
    { type: 'user_input', input: { text: 'And a final goodbye line please.' }, options: { conversation_id: 'e2e-conv-C' } },
  ], 90000);

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon must reach ready on a virgin home; got kinds: ' + kinds.slice(0, 10).join(','));
  assert(kinds.includes('stopped'), 'daemon must announce shutdown on stdin EOF (exit code ' + code + '; stderr tail: ' + String(stderr || '').slice(-400) + ')');

  // Turns: every user_input got a response envelope (echo transport).
  const responses = events.filter((e) => e.kind === 'response');
  assert(responses.length >= 3, 'expected 3 response envelopes (2 conv-A + 1 conv-B), got ' + responses.length);

  assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'wire protocol: no bad_json');
  // §8 no-cross-bleed: the dialogue mirror has each conversation's turns
  // under its own thread, and neither sees the other's text.
  const rowsA = readMirror(A, 10);
  const rowsB = readMirror(B, 10);
  assert.strictEqual(rowsA.length, 2, 'conv-A must hold exactly its 2 turns, got ' + rowsA.length);
  assert.strictEqual(rowsB.length, 1, 'conv-B must hold exactly its 1 turn, got ' + rowsB.length);
  assert.deepStrictEqual(rowsA.map((t) => t.user_text), [textA1, textA2], 'conv-A turns in order');
  assert.strictEqual(rowsB[0].user_text, textB1, 'conv-B turn intact');
  assert(!rowsA.some((t) => t.user_text === textB1), 'conv-B text must not bleed into conv-A');
  assert(!rowsB.some((t) => t.user_text === textA1 || t.user_text === textA2), 'conv-A text must not bleed into conv-B');
});

test('MODEL-WIRE-1: /engine local in pane A routes A next turn to llamacpp while pane B keeps the default', async () => {
  // Drive the REAL daemon. Primary faculty is echo (TROTH_ENTITY_LLM=echo);
  // llamacpp is auto-wired as the backstop, so /engine local (-> llamacpp) has
  // a real faculty to bind to. The dispatch frame is emitted BEFORE the
  // transport streams, so we can probe choice.faculty even though the
  // (absent) local server then aborts cleanly. Sequence:
  //   1. /engine local in A   -> deterministic reply (no llm dispatch)
  //   2. plain turn in A     -> dispatch faculty must be llamacpp + engine_override
  //   3. plain turn in B     -> dispatch faculty must stay echo (the default)
  const A = 'model-wire-A', B = 'model-wire-B';
  const { events, stderr, code } = await runDaemon([
    { type: 'user_input', input: { text: '/engine local' }, options: { conversation_id: A } },
    { type: 'user_input', input: { text: 'Say something in pane A please.' }, options: { conversation_id: A } },
    { type: 'user_input', input: { text: 'Say something in pane B please.' }, options: { conversation_id: B } },
  ], 90000);

  const kinds = events.map((e) => e.kind);
  assert(kinds.includes('ready'), 'daemon reached ready; kinds: ' + kinds.slice(0, 10).join(','));
  assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');

  // The /engine command itself is deterministic: it replies without an llm
  // dispatch. Its response must confirm the per-pane scope.
  const modelReply = events.find((e) => e.kind === 'response' && e.conversation_id === A
    && typeof e.text === 'string' && e.text.indexOf('✓') !== -1);
  assert(modelReply, 'the /engine local command replied naming the llamacpp faculty');

  // Pane A plain turn: its dispatch frame must show llamacpp with the override
  // annotation. There are two dispatch frames for A total (none for the
  // deterministic /engine), so filter to the llm one carrying engine_override.
  const dispatchA = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
  assert(dispatchA.some((e) => e.faculty === 'llamacpp' && e.engine_override === 'local'),
    'pane A next turn dispatched to llamacpp with engine_override=local; got ' + JSON.stringify(dispatchA));

  // Pane B got NO /engine command, so it keeps the global default faculty
  // (echo), and carries no engine_override annotation.
  const dispatchB = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === B);
  assert(dispatchB.length >= 1, 'pane B produced a dispatch frame; got ' + JSON.stringify(dispatchB));
  assert(dispatchB.every((e) => e.faculty !== 'llamacpp'), 'pane B must NOT be pulled to llamacpp by pane A override');
  assert(dispatchB.some((e) => e.faculty === 'echo'), 'pane B keeps the default echo faculty; got ' + JSON.stringify(dispatchB));
  assert(dispatchB.every((e) => e.engine_override === undefined), 'pane B carries no engine_override');
  void stderr; void code;
});

test('MODEL-WIRE-2: bare /engine over the wire returns options[] listing ONLY wired engines, no secrets', async () => {
  // Structured options contract: a UI selection surface reads
  // options[] off the /engine report frame. It must list ONLY what is actually
  // wired on THIS daemon (echo primary + llamacpp backstop): local IS present,
  // chatgpt (codex_oauth) is ABSENT because no codex faculty is wired. We plant
  // a config.json with an ENABLED router provider carrying a FAKE apiKey to prove
  // (a) the option appears (enabled + credentialed) yet (b) the secret value
  // NEVER reaches the wire. Planted under HERMETIC_HOME, not os.homedir():
  // homedir() reads the ambient HOME at call time, and by the time this body
  // runs in the serial flush another suite may have moved it. runDaemon pins
  // the child to HERMETIC_HOME, so the plant must land in the same place.
  const fs = require('fs');
  const cfgDir = path.join(HERMETIC_HOME, '.troth');
  const cfgPath = path.join(cfgDir, 'config.json');
  const FAKE_KEY = 'sk-fake-planted-secret-DEADBEEF0123456789abcdef';
  let priorCfg = null;
  try { priorCfg = fs.readFileSync(cfgPath, 'utf8'); } catch (_) { priorCfg = null; }
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
    providers: {
      deepseek:  { enabled: true,  apiKey: FAKE_KEY, model: 'deepseek-v4-pro' },
      openrouter:{ enabled: false, apiKey: FAKE_KEY },   // disabled -> must NOT appear
      local:     { enabled: true,  host: 'planted-host' } // enabled local -> router word 'local' is NOT a router provider; ignored here
    }
  }, null, 2));

  try {
    const A = 'model-wire-2';
    const { events } = await runDaemon([
      { type: 'user_input', input: { text: '/engine' }, options: { conversation_id: A } },
    ], 90000);

    assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');
    // The bare /engine report is a deterministic response frame for conv A.
    const rep = events.find((e) => e.kind === 'response' && e.conversation_id === A
      && typeof e.text === 'string' && Array.isArray(e.options));
    assert(rep, 'bare /engine emitted a response frame carrying options[]; kinds: ' + events.map((e) => e.kind).join(','));
    const values = rep.options.map((o) => o.value);

    // Only wired engines: llamacpp backstop -> local present; codex_oauth NOT
    // wired -> chatgpt absent.
    assert(values.includes('/engine local'), 'local option present (llamacpp backstop wired); got ' + JSON.stringify(values));
    assert(!values.includes('/engine chatgpt'), 'chatgpt option ABSENT (no codex faculty wired); got ' + JSON.stringify(values));
    // Auto variants are always offerable.
    assert(values.includes('/engine auto local-first'), 'auto local-first present');
    assert(values.includes('/engine auto best-first'), 'auto best-first present');
    // The enabled+credentialed router provider appears; the disabled one does not.
    assert(values.includes('/engine deepseek'), 'enabled+credentialed deepseek offered via router; got ' + JSON.stringify(values));
    assert(!values.includes('/engine openrouter'), 'disabled openrouter must NOT be offered; got ' + JSON.stringify(values));
    const ds = rep.options.find((o) => o.value === '/engine deepseek');
    assert(ds && ds.note === 'via router', 'router provider carries the "via router" note');

    // The TEXT must mirror reality too (CLI surfaces have no options UI). It is
    // built from the SAME source as options[], so it lists ONLY configured
    // choices and NEVER the old static catalog.
    assert(typeof rep.text === 'string' && rep.text.length, 'report frame carries a text body');
    // (c) credentialed router provider present in the text, uncredentialed absent.
    assert(rep.text.includes('/engine deepseek'), 'credentialed deepseek listed in the report text; got ' + rep.text);
    assert(!rep.text.includes('/engine openrouter'), 'disabled/uncredentialed openrouter ABSENT from the report text');
    // The via-router note rides the text choice line too.
    assert(/\/engine deepseek \(via router\)/.test(rep.text), 'deepseek text line carries the (via router) note');
    // (a) unwired faculty words ABSENT from the text (no codex/claude wired here).
    assert(!rep.text.includes('/engine chatgpt'), 'unwired chatgpt ABSENT from the report text');
    assert(!rep.text.includes('/engine claude'), 'unwired claude ABSENT from the report text');
    // The old static catalog phrasing must be gone entirely.
    assert(!/router providers:/.test(rep.text), 'the old static "router providers:" catalog is gone from the text');

    // SECRETS: the planted apiKey must NOT appear anywhere in the frame (text or options).
    const frameStr = JSON.stringify(rep);
    assert(frameStr.indexOf(FAKE_KEY) === -1, 'planted apiKey must NOT leak into the /engine frame');
    assert(!/https?:\/\//.test(frameStr), 'no url in the /engine options frame');
    assert(frameStr.indexOf('planted-host') === -1, 'no host name leaks into the /engine options frame');
  } finally {
    // Restore the prior config so later suites see the same home state.
    if (priorCfg != null) fs.writeFileSync(cfgPath, priorCfg);
    else { try { fs.unlinkSync(cfgPath); } catch (_) {} }
  }
});

test('MODEL-WIRE-3: bare /engine options[] mark current:true on the pane\'s active override', async () => {
  // current follows a set override: pin the pane to local, then a bare /engine
  // report must stamp current:true on the /engine local option (and on nothing
  // else). Proves the report reads the SAME override store the dispatch site
  // consults, so the UI highlight can never drift from where the turn routes.
  const A = 'model-wire-3';
  const { events } = await runDaemon([
    { type: 'user_input', input: { text: '/engine local' }, options: { conversation_id: A } },
    { type: 'user_input', input: { text: '/engine' }, options: { conversation_id: A } },
  ], 90000);

  assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');
  // Two deterministic responses on conv A; the report is the one with options[].
  const reports = events.filter((e) => e.kind === 'response' && e.conversation_id === A && Array.isArray(e.options));
  assert(reports.length >= 1, 'a bare /engine report with options[] was emitted; got ' + reports.length);
  const rep = reports[reports.length - 1];
  const localOpt = rep.options.find((o) => o.value === '/engine local');
  assert(localOpt && localOpt.current === true, 'local option is marked current after /engine local; got ' + JSON.stringify(rep.options));
  // Exactly one option carries current:true.
  const currentCount = rep.options.filter((o) => o.current === true).length;
  assert.strictEqual(currentCount, 1, 'exactly one option marked current; got ' + currentCount);
  // (b) current marked in the TEXT too: the pinned engine rides the head line
  // with a [current] marker, and is NOT repeated as a switch choice below.
  assert(typeof rep.text === 'string' && rep.text.includes('[current]'),
    'the active override is marked [current] in the report text; got ' + rep.text);
  assert(/llamacpp/.test(rep.text), 'the report text names the pinned llamacpp faculty on the current line');
  assert(!/  · \/engine local/.test(rep.text), 'the current engine is not duplicated as a switch choice in the text');
});

test('MODEL-WIRE-4: a deterministic command WITHOUT options emits a response frame with no options field', async () => {
  // The structured options contract is ADDITIVE: a handler that returns no
  // options (e.g. /context) emits a response frame WITHOUT the field. Proves
  // untouched handlers are unaffected - the field is present only when a
  // handler opts in.
  const A = 'model-wire-4';
  const { events } = await runDaemon([
    { type: 'user_input', input: { text: '/context' }, options: { conversation_id: A } },
  ], 90000);

  assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');
  const rep = events.find((e) => e.kind === 'response' && e.conversation_id === A && typeof e.text === 'string');
  assert(rep, '/context emitted a response frame; kinds: ' + events.map((e) => e.kind).join(','));
  assert(!('options' in rep), '/context response frame carries NO options field; frame keys: ' + Object.keys(rep).join(','));
});

// ── /engine <provider> <model-id> second-level model catalog ──
// A router-provider word selects the router faculty AND, in v1, lets the
// operator pin THAT provider's model - the same providers.<name>.model value
// the Settings dropdown writes. The submenu ids are derived from cost.js RATES
// (offline, no network) via a conservative per-provider mapping.
//
// Isolation: each test gets its OWN throwaway HOME (passed to the daemon via
// extraEnv.HOME) so concurrent planted-config tests never race on one shared
// ~/.troth/config.json. hermetic-db already set the _TROTH_TEST_HOME sentinel,
// so children do NOT re-redirect - they honor the HOME we pass. The parent reads
// back the explicit cfgPath inside that home, so read and write agree.
let _mmHomeSeq = 0;
function withPlantedConfig(cfgObject, fn) {
  const fs = require('fs');
  const os = require('os');
  const home = path.join(os.tmpdir(),
    'troth-model-home-' + process.pid + '-' + (_mmHomeSeq++) + '-' + Math.random().toString(36).slice(2, 8));
  const cfgDir = path.join(home, '.troth');
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfgObject, null, 2), { mode: 0o600 });
  // Every daemon this test spawns must read/write config from THIS home.
  const env = { HOME: home };
  return Promise.resolve()
    .then(() => fn(cfgPath, env, home))
    .finally(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
}

test('MODEL-MODEL-1: bare /engine <provider> carries a second-level models options[] with current marked from config', async () => {
  // (a) A bare /engine deepseek reply offers deepseek's known model ids as a
  // second-level options list, and the id equal to the planted config's
  // providers.deepseek.model is stamped current:true. Ids come from cost.js
  // RATES (offline), so the menu can never require a network call.
  const FAKE_KEY = 'sk-fake-MODEL1-secret-0011223344556677';
  await withPlantedConfig({
    providers: {
      deepseek: { enabled: true, apiKey: FAKE_KEY, model: 'deepseek-chat' },
    }
  }, async (cfgPath, env) => {
    const A = 'model-model-1';
    const { events } = await runDaemon([
      { type: 'user_input', input: { text: '/engine deepseek' }, options: { conversation_id: A } },
    ], 90000, env);

    assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');
    const rep = events.find((e) => e.kind === 'response' && e.conversation_id === A
      && typeof e.text === 'string' && Array.isArray(e.options));
    assert(rep, 'bare /engine deepseek emitted a response frame carrying a models options[]; kinds: '
      + events.map((e) => e.kind).join(','));
    // Every option is a second-level /engine <provider> <model-id> value.
    assert(rep.options.length >= 2, 'at least two deepseek models offered; got ' + JSON.stringify(rep.options.map((o) => o.value)));
    assert(rep.options.every((o) => o.value.indexOf('/engine deepseek ') === 0),
      'every model option is a /engine deepseek <id> value; got ' + JSON.stringify(rep.options.map((o) => o.value)));
    // The planted current model is marked, and exactly one option is current.
    const chatOpt = rep.options.find((o) => o.value === '/engine deepseek deepseek-chat');
    assert(chatOpt && chatOpt.current === true, 'the planted current model (deepseek-chat) is marked current; got ' + JSON.stringify(rep.options));
    assert.strictEqual(rep.options.filter((o) => o.current === true).length, 1, 'exactly one model marked current');
    // The pane override was set to the router faculty (the word still routes).
    assert(/deepseek/.test(rep.text), 'terse reply names the engine (deepseek); got ' + rep.text);
    // No secret leaks into the submenu frame.
    assert(JSON.stringify(rep).indexOf(FAKE_KEY) === -1, 'planted apiKey must NOT leak into the /engine deepseek submenu frame');
  });
});

test('MODEL-MODEL-2: /engine <provider> <model-id> writes providers.<name>.model preserving other keys and sets the override', async () => {
  // (b) Choosing a model writes providers.deepseek.model into config.json via the
  // blessed atomic writer: other providers, the secret apiKey, and unrelated
  // top-level keys all survive; the file stays 0600. The pane override is set to
  // the router faculty in the same turn, then a plain turn on that pane must
  // dispatch through the router - so we WIRE the router faculty for this test
  // (TROTH_ENTITY_LLM_FACULTIES=router); the router transport aborts cleanly on
  // the fake key AFTER the dispatch frame is emitted, which is all we assert.
  const FAKE_KEY = 'sk-fake-MODEL2-secret-8899aabbccddeeff';
  await withPlantedConfig({
    providers: {
      deepseek: { enabled: true, apiKey: FAKE_KEY, model: 'deepseek-chat' },
      alibaba:  { enabled: false, apiKey: 'sk-other-untouched' },
    },
    unrelatedTopKey: { keep: 'me' }
  }, async (cfgPath, env) => {
    const fs = require('fs');
    const A = 'model-model-2';
    const NEW_ID = 'deepseek-ai/deepseek-v3.2';
    const { events } = await runDaemon([
      { type: 'user_input', input: { text: '/engine deepseek ' + NEW_ID }, options: { conversation_id: A } },
      { type: 'user_input', input: { text: 'Say something on this pane please.' }, options: { conversation_id: A } },
    ], 90000, Object.assign({ TROTH_ENTITY_LLM_FACULTIES: 'router' }, env));

    assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');
    const rep = events.find((e) => e.kind === 'response' && e.conversation_id === A
      && typeof e.text === 'string' && e.text.indexOf('model') !== -1);
    assert(rep, 'the model-set command replied confirming the write; kinds: ' + events.map((e) => e.kind).join(','));
    assert(rep.text.indexOf(NEW_ID) !== -1, 'reply names the newly set model id');
    // Honest globally-applies wording + the respawn caveat + durable-choice wording.
    assert(/deepseek/.test(rep.text), 'terse reply names the engine (deepseek)');
    assert(/model/.test(rep.text), 'terse reply confirms the model was set');
    // The pane choice is durable now: the reply must NOT claim it lasts only
    // "until the app restarts" (the amnesia caveat is gone).
    assert(!/until the app restarts/.test(rep.text), 'the model-set reply drops the "until the app restarts" caveat; got ' + rep.text);

    // The config write landed and preserved everything else.
    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(after.providers.deepseek.model, NEW_ID, 'providers.deepseek.model updated');
    assert.strictEqual(after.providers.deepseek.apiKey, FAKE_KEY, 'deepseek secret preserved');
    assert.strictEqual(after.providers.deepseek.enabled, true, 'deepseek.enabled preserved');
    assert.strictEqual(after.providers.alibaba.apiKey, 'sk-other-untouched', 'other provider preserved');
    assert.deepStrictEqual(after.unrelatedTopKey, { keep: 'me' }, 'unrelated top-level key preserved');
    assert.strictEqual(fs.statSync(cfgPath).mode & 0o777, 0o600, 'config file stays 0600');

    // The secret never appears in the reply frame.
    assert(JSON.stringify(rep).indexOf(FAKE_KEY) === -1, 'planted apiKey must NOT leak into the model-set reply frame');

    // The pane override was set: the plain follow-up turn dispatches via router.
    const dispatchA = events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
    assert(dispatchA.some((e) => e.faculty === 'router' && e.engine_override === 'deepseek'),
      'the pane next turn dispatched to the router faculty with engine_override=deepseek; got ' + JSON.stringify(dispatchA));
  });
});

test('MODEL-MODEL-3: an unknown model id for a provider refuses honestly and lists the known ids', async () => {
  // (c) A model id core does not know for the provider is refused with an error
  // frame that lists the ids core DOES know - never a silent config write.
  const FAKE_KEY = 'sk-fake-MODEL3-secret-1234deadbeef5678';
  await withPlantedConfig({
    providers: { deepseek: { enabled: true, apiKey: FAKE_KEY, model: 'deepseek-chat' } }
  }, async (cfgPath, env) => {
    const fs = require('fs');
    const A = 'model-model-3';
    const { events } = await runDaemon([
      { type: 'user_input', input: { text: '/engine deepseek totally-made-up-model' }, options: { conversation_id: A } },
    ], 90000, env);

    assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');
    // The refusal surfaces as an error frame naming the unknown-model reason.
    const errFrame = events.find((e) => e.kind === 'error' && e.conversation_id === A && e.error === 'unknown_model');
    assert(errFrame, 'an unknown_model error frame was emitted; kinds/errors: '
      + events.filter((e) => e.kind === 'error').map((e) => e.error).join(','));
    assert(/deepseek-chat/.test(errFrame.detail || ''), 'the refusal lists the known deepseek ids; got ' + (errFrame.detail || ''));
    assert(/totally-made-up-model/.test(errFrame.detail || ''), 'the refusal names the rejected id');

    // Crucially: the config was NOT touched by the refused write.
    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(after.providers.deepseek.model, 'deepseek-chat', 'a refused id must NOT change providers.deepseek.model');
    // No secret leaks into the error frame.
    assert(JSON.stringify(errFrame).indexOf(FAKE_KEY) === -1, 'planted apiKey must NOT leak into the refusal frame');
  });
});

test('MODEL-MODEL-4: no secret material appears anywhere in /engine output with planted keys', async () => {
  // (d) Sweep the whole /engine surface (bare provider submenu + model-set +
  // refusal) with a planted apiKey and assert the key value never rides ANY
  // emitted frame - text, options, error detail, or side_effects.
  const FAKE_KEY = 'sk-fake-MODEL4-secret-cafebabe99887766';
  await withPlantedConfig({
    providers: {
      deepseek: { enabled: true, apiKey: FAKE_KEY, model: 'deepseek-chat' },
      alibaba:  { enabled: true, apiKey: FAKE_KEY, model: 'qwen3-max' },
    }
  }, async (cfgPath, env) => {
    const A = 'model-model-4';
    const { events } = await runDaemon([
      { type: 'user_input', input: { text: '/engine deepseek' }, options: { conversation_id: A } },
      { type: 'user_input', input: { text: '/engine alibaba qwen3.6-plus' }, options: { conversation_id: A } },
      { type: 'user_input', input: { text: '/engine deepseek nope-not-real' }, options: { conversation_id: A } },
    ], 90000, env);

    assert(!events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on the wire');
    // Sweep EVERY frame for conv A - not one may carry the planted secret.
    const all = JSON.stringify(events.filter((e) => e.conversation_id === A));
    assert(all.indexOf(FAKE_KEY) === -1, 'planted apiKey must NOT appear in any /engine frame');
    // Sanity: the three /engine turns actually produced output (submenu + set + refusal).
    const setReply = events.find((e) => e.kind === 'response' && e.conversation_id === A
      && typeof e.text === 'string' && e.text.indexOf('qwen3.6-plus') !== -1);
    assert(setReply, 'the alibaba model-set turn replied; kinds: ' + events.map((e) => e.kind).join(','));
    const refusal = events.find((e) => e.kind === 'error' && e.conversation_id === A && e.error === 'unknown_model');
    assert(refusal, 'the unknown-id turn refused; errors: ' + events.filter((e) => e.kind === 'error').map((e) => e.error).join(','));
  });
});

test('MODEL-PERSIST-1: an engine override survives a daemon restart on the same HOME (durable, not amnesiac)', async () => {
  // Durability (operator rule: a partner that forgets your /engine choice on
  // restart repeats the amnesia sin). engine-override.js persists its map to
  // ~/.troth/engine-overrides.json on every set and reloads it at module init.
  // We plant a config so deepseek is offerable, run one daemon that sets a pane
  // override, let it exit (stdin EOF), then spawn a SECOND daemon on the SAME
  // HOME and a plain turn on that pane must STILL dispatch via the override -
  // proving the choice was restored from disk, not lost with the process.
  const FAKE_KEY = 'sk-fake-PERSIST-secret-1122334455667788';
  await withPlantedConfig({
    providers: { deepseek: { enabled: true, apiKey: FAKE_KEY, model: 'deepseek-chat' } }
  }, async (cfgPath, env, home) => {
    const fs = require('fs');
    const A = 'model-persist-1';
    const wireEnv = Object.assign({ TROTH_ENTITY_LLM_FACULTIES: 'router' }, env);
    // Daemon #1: set the pane to deepseek (router faculty), then exit.
    const first = await runDaemon([
      { type: 'user_input', input: { text: '/engine deepseek' }, options: { conversation_id: A } },
    ], 90000, wireEnv);
    assert(!first.events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on daemon #1');
    // The override file was written under this HOME.
    const ovPath = path.join(home, '.troth', 'engine-overrides.json');
    assert(fs.existsSync(ovPath), 'engine-overrides.json was persisted on set; expected at ' + ovPath);
    assert.strictEqual(fs.statSync(ovPath).mode & 0o777, 0o600, 'engine-overrides.json is mode 0600');

    // Daemon #2 (a fresh process = a "restart"): a plain turn on the SAME pane
    // must still route via the override restored from disk.
    const second = await runDaemon([
      { type: 'user_input', input: { text: 'Say something after the restart please.' }, options: { conversation_id: A } },
    ], 90000, wireEnv);
    assert(!second.events.some((e) => e.kind === 'error' && e.error === 'bad_json'), 'no bad_json on daemon #2');
    const dispatchA = second.events.filter((e) => e.kind === 'dispatch' && e.conversation_id === A);
    assert(dispatchA.some((e) => e.faculty === 'router' && e.engine_override === 'deepseek'),
      'after restart the pane STILL dispatched via the router faculty with engine_override=deepseek; got ' + JSON.stringify(dispatchA));
  });
});

// ── Concurrency fixtures ─────────
// A hermetic custom transport (TROTH_ENTITY_LLM=<path>) that makes turn
// duration and workspace evidence controllable with zero network:
//   turn 1: honors an optional [sleep:<ms>] directive in the user text
//           (abortable via transport.abort - the per-pane cancel path),
//           then issues a Read tool call for <cwd>/marker.txt where cwd=
//           is parsed from the system prompt (buildSystemPrompt stamps
//           '; cwd=<turn workspace>').
//   turn 2: echoes the tool result, so the final response text carries the
//           marker content of THE TURN'S OWN workspace.
const CONC_TRANSPORT_SRC = [
  "'use strict';",
  "const _wakers = new Set();",
  "function sleepAbortable(ms) {",
  "  return new Promise((resolve) => {",
  "    const wake = () => { clearTimeout(t); _wakers.delete(wake); resolve(true); };",
  "    const t = setTimeout(() => { _wakers.delete(wake); resolve(false); }, ms);",
  "    _wakers.add(wake);",
  "  });",
  "}",
  "module.exports = {",
  "  stream: async function* (req) {",
  "    const messages = Array.isArray(req && req.messages) ? req.messages : [];",
  "    const last = messages[messages.length - 1] || {};",
  "    if (last.role === 'tool') {",
  "      yield { delta: 'MARKER<' + String(last.content || '') + '>' };",
  "      yield { done: true };",
  "      return;",
  "    }",
  "    let userText = '';",
  "    for (let i = messages.length - 1; i >= 0; i--) {",
  "      const m = messages[i];",
  "      if (m && m.role === 'user' && typeof m.content === 'string') { userText = m.content; break; }",
  "    }",
  "    // The daemon mounts recent dialogue (possibly another pane's) inside a",
  "    // <turn_context> wrapper ABOVE the operator's current message. Grepping",
  "    // the whole content for [sleep:] made this fixture sleep on a marker",
  "    // quoted from ANOTHER conversation's history, so a Stop over there",
  "    // woke this pane into a bare done: the exact empty-turn CONC-4 chased.",
  "    // Only the CURRENT operator text may carry directives.",
  "    const ctxEnd = userText.lastIndexOf('</turn_context>');",
  "    const opText = ctxEnd >= 0 ? userText.slice(ctxEnd + '</turn_context>'.length) : userText;",
  "    const sleepMatch = opText.match(/\\[sleep:(\\d+)\\]/);",
  "    const sleepMs = sleepMatch ? parseInt(sleepMatch[1], 10) : 0;",
  "    if (sleepMs > 0) {",
  "      const woken = await sleepAbortable(sleepMs);",
  "      if (woken) { yield { done: true }; return; }",
  "    }",
  "    const sys = messages.find((m) => m && m.role === 'system');",
  "    const sysText = (sys && typeof sys.content === 'string') ? sys.content : '';",
  "    const cwdMatch = sysText.match(/; cwd=([^\\s;]+)/);",
  "    const cwd = cwdMatch ? cwdMatch[1].replace(/\\.$/, '') : null;",
  "    if (cwd) {",
  "      yield { tool_calls: [{ id: 'conc_read_1', function: { name: 'Read', arguments: JSON.stringify({ file_path: cwd + '/marker.txt' }) } }] };",
  "      yield { done: true };",
  "      return;",
  "    }",
  "    yield { delta: 'NOCWD ' + userText.slice(0, 80) };",
  "    yield { done: true };",
  "  },",
  "  abort: () => { for (const wake of Array.from(_wakers)) { try { wake(); } catch (_) {} } }",
  "};",
  ""
].join('\n');

/** Writes the transport + n marker workspaces into throwaway temp dirs.
 * Returns { txPath, workspaces: [{dir, token}], cleanup }. */
function makeConcFixtures(n) {
  const fs = require('fs');
  const os = require('os');
  const dirs = [];
  const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-conc-tx-'));
  dirs.push(txDir);
  const txPath = path.join(txDir, 'conc-transport.js');
  fs.writeFileSync(txPath, CONC_TRANSPORT_SRC);
  const workspaces = [];
  for (let i = 0; i < n; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-conc-ws-'));
    dirs.push(dir);
    const token = 'MARKER_TOKEN_' + String.fromCharCode(65 + i) + '_' + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(path.join(dir, 'marker.txt'), token);
    workspaces.push({ dir, token });
  }
  const cleanup = () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
  return { txPath, workspaces, cleanup };
}

test('RT-CONC-1: cognitive runtime overlaps turns up to the cap; same-conversation turns stay serial; cap=1 reproduces the strict FIFO loop; drainAndStop waits for in-flight turns', async () => {
  const rt = require('../shared-core/cognitive-runtime.js');
  let live = 0, peak = 0;
  const done = [];
  const times = {};
  const mk = (cap) => rt.start({
    agent_id: 'rt-conc', user_id: 'rt-conc', cwd: process.cwd(),
    max_concurrent_turns: cap,
    decide: async (_view, event) => ({ kind: 'respond', prompt: event.input && event.input.text }),
    dispatch: async (action) => {
      live++; peak = Math.max(peak, live);
      times[action.prompt] = { start: Date.now(), end: null };
      await new Promise((r) => setTimeout(r, 150));
      live--; done.push(action.prompt);
      times[action.prompt].end = Date.now();
      return { status: 'ok' };
    }
  });
  // cap=2 with 3 lane-less events: exactly two overlap, the third queues,
  // all finish before drainAndStop returns.
  const t0 = Date.now();
  const r2 = mk(2);
  r2.submit({ type: 'user_input', input: { text: 'c1' } });
  r2.submit({ type: 'user_input', input: { text: 'c2' } });
  r2.submit({ type: 'user_input', input: { text: 'c3' } });
  const stateBefore = r2.state();
  const drained = await r2.drainAndStop({ timeout_ms: 30000 });
  // On a loaded runner this is the first thing to go, so say WHY it went:
  // still queued means nothing launched, still in flight means drain gave up
  // early, neither means a turn was dropped between the two.
  assert.strictEqual(done.length, 3, 'cap=2: all three turns must complete before drainAndStop returns, got ' + done.length
    + ' | at submit: ' + JSON.stringify(stateBefore)
    + ' | at return: ' + JSON.stringify(drained)
    + ' | elapsed ' + (Date.now() - t0) + 'ms');
  assert.strictEqual(peak, 2, 'cap=2: exactly two turns in flight at peak, got ' + peak);
  // Lane serialization: two turns on ONE conversation must not overlap and
  // must run in submit order, while another conversation overlaps freely.
  live = 0; peak = 0; done.length = 0;
  const rl = mk(3);
  rl.submit({ type: 'user_input', input: { text: 'p1' }, options: { conversation_id: 'pane-1' } });
  rl.submit({ type: 'user_input', input: { text: 'p2' }, options: { conversation_id: 'pane-1' } });
  rl.submit({ type: 'user_input', input: { text: 'x1' }, options: { conversation_id: 'pane-2' } });
  await rl.drainAndStop({ timeout_ms: 30000 });
  assert.strictEqual(done.length, 3, 'lanes: all three turns complete');
  assert(times.p2.start >= times.p1.end, 'same-conversation turns must serialize (p2 started ' + (times.p2.start - times.p1.end) + 'ms relative to p1 end)');
  assert(times.x1.start < times.p1.end, 'a different conversation must overlap the busy lane');
  assert(done.indexOf('p1') < done.indexOf('p2'), 'same-conversation order preserved');
  // cap=1 must reproduce the historical serial loop: no overlap, FIFO order.
  live = 0; peak = 0; done.length = 0;
  const r1 = mk(1);
  r1.submit({ type: 'user_input', input: { text: 's1' } });
  r1.submit({ type: 'user_input', input: { text: 's2' } });
  r1.submit({ type: 'user_input', input: { text: 's3' } });
  await r1.drainAndStop({ timeout_ms: 30000 });
  assert.strictEqual(peak, 1, 'cap=1: turns must never overlap, peak=' + peak);
  assert.deepStrictEqual(done, ['s1', 's2', 's3'], 'cap=1: FIFO order preserved');
});

test('E2E-CONC-2: two panels overlap - fast B lands while slow A is in flight, every frame tagged, each turn in ITS OWN workspace', async () => {
  const fx = makeConcFixtures(2);
  const [wsA, wsB] = fx.workspaces;
  const A = 'conc2-conv-A', B = 'conc2-conv-B';
  try {
    const { events, stderr, code } = await runDaemon([
      { type: 'user_input', input: { text: 'slow marker turn please [sleep:3500]' },
        options: { conversation_id: A, workspace: wsA.dir } },
      { type: 'user_input', input: { text: 'fast marker turn please' },
        options: { conversation_id: B, workspace: wsB.dir } },
    ], 90000, {
      TROTH_ENTITY_LLM: fx.txPath,
      TROTH_ENTITY_LLM_PIN: '1',
      TROTH_ENTITY_MAX_CONCURRENT_TURNS: '3',
    });
    const kinds = events.map((e) => e.kind);
    assert(kinds.includes('ready'), 'daemon must reach ready; stderr tail: ' + String(stderr || '').slice(-300));
    assert(kinds.includes('stopped'), 'clean shutdown (exit ' + code + ')');
    // Tagging contract: boot frames stay untagged; per-turn frames carry
    // their conversation_id at the top level.
    const ready = events.find((e) => e.kind === 'ready');
    assert(!('conversation_id' in ready), 'boot frames (no conversation) must emit untagged');
    const respA = events.findIndex((e) => e.kind === 'response' && e.conversation_id === A);
    const respB = events.findIndex((e) => e.kind === 'response' && e.conversation_id === B);
    assert(respA >= 0, 'conv-A response must arrive tagged; kinds: ' + kinds.join(','));
    assert(respB >= 0, 'conv-B response must arrive tagged');
    // Overlap proof: A is slowed by 3.5s, so B's response MUST land first -
    // impossible under the old serial loop (A submitted first would finish first).
    assert(respB < respA, 'fast B (idx ' + respB + ') must complete while slow A (idx ' + respA + ') is still in flight');
    // Mid-turn frames tagged too: A's Read tool_request belongs to pane A.
    assert(events.some((e) => e.kind === 'tool_request' && e.conversation_id === A),
      'mid-turn tool_request frames must carry the conversation tag');
    assert(events.some((e) => e.kind === 'dispatch' && e.conversation_id === B),
      'dispatch frames must carry the conversation tag');
    // Workspace isolation: each response reflects ITS marker, never the other's.
    const rA = events[respA], rB = events[respB];
    assert.strictEqual(rA.status, 'ok', 'conv-A turn must succeed, got ' + rA.status + '/' + rA.reason);
    assert.strictEqual(rB.status, 'ok', 'conv-B turn must succeed, got ' + rB.status + '/' + rB.reason);
    assert(String(rA.text).includes(wsA.token), 'conv-A must read its own workspace marker; text: ' + String(rA.text).slice(0, 200));
    assert(!String(rA.text).includes(wsB.token), 'conv-B marker must not bleed into conv-A');
    assert(String(rB.text).includes(wsB.token), 'conv-B must read its own workspace marker; text: ' + String(rB.text).slice(0, 200));
    assert(!String(rB.text).includes(wsA.token), 'conv-A marker must not bleed into conv-B');
  } finally { fx.cleanup(); }
});

test('E2E-CONC-3: three panels under cap=2 - the third queues behind the cap, then still completes tagged in its own workspace', async () => {
  const fx = makeConcFixtures(3);
  const [wsA, wsB, wsC] = fx.workspaces;
  const A = 'conc3-conv-A', B = 'conc3-conv-B', C = 'conc3-conv-C';
  try {
    const { events, stderr } = await runDaemon([
      { type: 'user_input', input: { text: 'slot one please [sleep:2500]' },
        options: { conversation_id: A, workspace: wsA.dir } },
      { type: 'user_input', input: { text: 'slot two please [sleep:2500]' },
        options: { conversation_id: B, workspace: wsB.dir } },
      { type: 'user_input', input: { text: 'queued third please' },
        options: { conversation_id: C, workspace: wsC.dir } },
    ], 90000, {
      TROTH_ENTITY_LLM: fx.txPath,
      TROTH_ENTITY_LLM_PIN: '1',
      TROTH_ENTITY_MAX_CONCURRENT_TURNS: '2',
    });
    const kinds = events.map((e) => e.kind);
    assert(kinds.includes('ready'), 'daemon must reach ready; stderr tail: ' + String(stderr || '').slice(-300));
    const resp = {};
    for (const id of [A, B, C]) {
      resp[id] = events.findIndex((e) => e.kind === 'response' && e.conversation_id === id);
      assert(resp[id] >= 0, 'response for ' + id + ' must arrive tagged; kinds: ' + kinds.join(','));
    }
    // Cap respected: C's turn may only START once a slot frees, i.e. its
    // dispatch frame must come after the first finisher's response.
    const dispatchC = events.findIndex((e) => e.kind === 'dispatch' && e.conversation_id === C);
    assert(dispatchC >= 0, 'conv-C dispatch frame must exist (and be tagged)');
    const firstFinisher = Math.min(resp[A], resp[B]);
    assert(dispatchC > firstFinisher,
      'cap=2: conv-C must not start (dispatch idx ' + dispatchC + ') before a slot frees (first response idx ' + firstFinisher + ')');
    // Every turn resolved its OWN workspace.
    const tokens = { [A]: wsA.token, [B]: wsB.token, [C]: wsC.token };
    for (const id of [A, B, C]) {
      const r = events[resp[id]];
      assert.strictEqual(r.status, 'ok', id + ' must succeed, got ' + r.status + '/' + r.reason);
      assert(String(r.text).includes(tokens[id]), id + ' must carry its own marker');
      for (const other of [A, B, C]) {
        if (other === id) continue;
        assert(!String(r.text).includes(tokens[other]), other + ' marker must not bleed into ' + id);
      }
    }
  } finally { fx.cleanup(); }
});

test('E2E-CONC-4: per-pane Stop - cancel_turn aborts ONE conversation (operator_cancel) while the other pane completes untouched', async () => {
  const fs = require('fs');
  const fx = makeConcFixtures(2);
  const [wsA, wsB] = fx.workspaces;
  const A = 'conc4-conv-A', B = 'conc4-conv-B';
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [ENTITY], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: HERMETIC_HOME,
          TROTH_ENTITY_LLM: fx.txPath,
          TROTH_ENTITY_LLM_PIN: '1',
          TROTH_ENTITY_MAX_CONCURRENT_TURNS: '3',
          TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const events = [];
      let out = '';
      let err = '';
      let cancelSent = false;
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
          // The cancel signal registers BEFORE the dispatch frame emits, so
          // the moment pane A sees its turn start, Stop is routable.
          if (!cancelSent && ev.kind === 'dispatch' && ev.conversation_id === A) {
            cancelSent = true;
            child.stdin.write(JSON.stringify({ type: 'control', op: 'cancel_turn', conversation_id: A }) + '\n');
            child.stdin.end();
          }
        }
      });
      child.stderr.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CONC-4 timed out; stderr tail: ' + err.slice(-400)));
      }, 60000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const tail = out.trim();
        if (tail) { try { events.push(JSON.parse(tail)); } catch (_) {} }
        resolve({ events, code, stderr: err });
      });
      // A sleeps 20s - only a working cancel path brings this test home fast
      // (drainAndStop's shutdown budget is 10s, so an uncancelled A would
      // ALSO show up as a clipped turn - the status assertion below catches
      // either failure shape). B is instant and must be untouched.
      child.stdin.write([
        JSON.stringify({ type: 'user_input', input: { text: 'cancel me please [sleep:20000]' },
          options: { conversation_id: A, workspace: wsA.dir } }),
        JSON.stringify({ type: 'user_input', input: { text: 'complete me please' },
          options: { conversation_id: B, workspace: wsB.dir } }),
      ].join('\n') + '\n');
    });
    const kinds = result.events.map((e) => e.kind);
    const ack = result.events.find((e) => e.kind === 'cancel_turn_ack');
    assert(ack, 'daemon must ack the cancel; kinds: ' + kinds.join(','));
    assert.strictEqual(ack.conversation_id, A, 'ack tagged to the cancelled pane');
    assert.strictEqual(ack.in_flight, true, 'cancel must find the registered in-flight turn');
    const rA = result.events.find((e) => e.kind === 'response' && e.conversation_id === A);
    const rB = result.events.find((e) => e.kind === 'response' && e.conversation_id === B);
    assert(rA, 'cancelled pane still gets its (tagged) terminal response');
    assert.strictEqual(rA.status, 'aborted', 'conv-A must abort, got ' + rA.status);
    assert.strictEqual(rA.reason, 'operator_cancel', 'conv-A abort reason must be operator_cancel, got ' + rA.reason);
    assert(rB, 'conv-B response must arrive');
    assert.strictEqual(rB.status, 'ok', 'conv-B must complete untouched, got ' + rB.status + '/' + rB.reason);
    assert(String(rB.text).includes(wsB.token), 'conv-B still resolves its own workspace');
  } finally { fx.cleanup(); }
});

test('E2E-CONC-4b: Simple-mode Stop - an untagged cancel_turn aborts the live untagged turn (the app sends no conversation_id)', async () => {
  // The app's Simple chat and voice bar run their turns UNTAGGED. Until
  //  those turns were never registered for cancellation, the
  // Rust side never shipped a cancel for them, and the UI comment said
  // "backend stops TTS only" - so Esc and the stop button let a 90s
  // agentic turn keep working (operator find, on the codex faculty).
  // This is CONC-4 minus every conversation_id: the cancel carries none,
  // and must still land on the one live interactive turn.
  const fx = makeConcFixtures(1);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [ENTITY], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: HERMETIC_HOME,
          TROTH_ENTITY_LLM: fx.txPath,
          TROTH_ENTITY_LLM_PIN: '1',
          TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const events = [];
      let out = '';
      let err = '';
      let cancelSent = false;
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
          if (!cancelSent && ev.kind === 'dispatch') {
            cancelSent = true;
            child.stdin.write(JSON.stringify({ type: 'control', op: 'cancel_turn' }) + '\n');
            child.stdin.end();
          }
        }
      });
      child.stderr.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CONC-4b timed out; stderr tail: ' + err.slice(-400)));
      }, 60000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer);
        const tail = out.trim();
        if (tail) { try { events.push(JSON.parse(tail)); } catch (_) {} }
        resolve({ events, stderr: err });
      });
      child.stdin.write(JSON.stringify(
        { type: 'user_input', input: { text: 'cancel me please [sleep:20000]' } }
      ) + '\n');
    });
    const kinds = result.events.map((e) => e.kind);
    const ack = result.events.find((e) => e.kind === 'cancel_turn_ack');
    assert(ack, 'daemon must ack the untagged cancel; kinds: ' + kinds.join(','));
    assert.strictEqual(ack.in_flight, true, 'untagged cancel must find the live untagged turn');
    assert.strictEqual(ack.conversation_id, undefined, 'untagged ack carries no conversation tag');
    const r = result.events.find((e) => e.kind === 'response');
    assert(r, 'the cancelled untagged turn still gets its terminal response');
    assert.strictEqual(r.status, 'aborted', 'untagged turn must abort, got ' + r.status + '/' + r.reason);
    assert.strictEqual(r.reason, 'operator_cancel', 'abort reason must be operator_cancel, got ' + r.reason);
  } finally { fx.cleanup(); }
});

test('E2E-ENV-1: structured-envelope tags never reach the operator - bodies stay inline, meta is dropped', async () => {
  // The injector asks the model to tag its reply; the proxy decomposes the
  // tags for the audit log. Display was the missing half: the app rendered
  // a raw "<meta>" plan block in the chat. The
  // echo transport returns the composed prompt verbatim, so tags planted in
  // the input arrive on the response path exactly as a tagging model's
  // output would, and the emit must hand the operator clean text.
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTITY], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: HERMETIC_HOME, TROTH_ENTITY_LLM: 'echo',
             TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ENV-1 timed out; stderr tail: ' + err.slice(-300)));
    }, 30000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean));
    });
    child.stdin.write(JSON.stringify({ type: 'user_input', input: {
      text: 'Reply about <claim>keep-me-claim</claim> and <meta>drop-me-meta</meta> thanks for the details today' } }) + '\n');
    child.stdin.end();
  });
  const r = result.find((e) => e.kind === 'response');
  assert(r, 'response frame must arrive');
  assert(String(r.text).includes('keep-me-claim'), 'claim body must stay inline');
  assert(!String(r.text).includes('drop-me-meta'), 'meta body must be dropped from display');
  assert(!/<\/?(claim|meta)>/.test(String(r.text)), 'no envelope tags may reach the operator');
});

test('E2E-CONC-5: a focused pane never inherits another workstream\'s goal as its concern; unfocused surfaces keep the fallback', async () => {
  // The DMN concerns block ALWAYS included the
  // top-2 most-recent unresolved goals as a fallback, so another pane's
  // project goal entered an unrelated conversation and an instruction-hungry
  // local model executed it over the operator's actual message. The fix cuts
  // the off-topic fallback for conversation-tagged turns only; relevant
  // (token-matched) concerns still surface everywhere, and untagged surfaces
  // (CLI, voice) keep the fallback exactly as before.
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-conc5-home-'));
  // Pin the state db INTO the virgin home. hermetic-db.js pins a SHARED
  // STATE_DB_PATH for the whole suite process and children inherit it, so
  // this test's "virgin home" was never virgin at the db layer: concurrent
  // suite daemons write dialogue into the shared db, an echo transport
  // elsewhere can restate this test's planted goal into a recorded reply,
  // and the focused pane's window backfill then legitimately surfaces that
  // recorded dialogue - flaking SAW<YES> under full-suite load only
  //. The invariant under test is the CONCERNS path, and it
  // needs a genuinely isolated substrate to be judged.
  fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
  const conc5Db = path.join(home, '.troth', 'state.db');
  const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-conc5-tx-'));
  const txPath = path.join(txDir, 'probe-transport.js');
  // Probe transport: the response text reports whether ANY composed message
  // carried the planted goal marker, i.e. whether the memory envelope
  // surfaced the foreign goal to the model.
  fs.writeFileSync(txPath, [
    "'use strict';",
    "module.exports = { stream: async function* (req) {",
    "  const all = (Array.isArray(req && req.messages) ? req.messages : [])",
    "    .map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\\n')",
    "    + '\\n' + String(req && req.system || '');",
    "  yield { delta: 'SAW<' + (all.indexOf('XYZZY_CONC5_GOAL') >= 0 ? 'YES' : 'NO') + '>' };",
    "  yield { done: true };",
    "}, abort: () => {} };",
    ""
  ].join('\n'));
  // Plant ONE unresolved intent (another workstream's goal) in the virgin
  // home, via a subprocess so the state module binds to THAT home.
  execFileSync(process.execPath, ['-e', [
    "const path = require('path');",
    "const state = require(process.argv[1] + '/shared-core/state.js');",
    "const ar = require(process.argv[1] + '/shared-core/action-record.js');",
    "const rec = { id: ar.uuidv7(), timestamp: Date.now(), type: 'intent', agent_id: 'local-agent',",
    "  cwd: '/tmp/conc5-other-project', user_id: 'default',",
    "  input: { kind: 'goal' },",
    "  output: { statement: 'XYZZY_CONC5_GOAL build the other pane project end to end' },",
    "  outcome: { status: 'open' } };",
    "state.recordAction(rec, ar.toSearchText(rec));"
  ].join('\n'), path.join(__dirname, '..')], { env: { ...process.env, HOME: home, STATE_DB_PATH: conc5Db } });
  try {
    const { events, stderr } = await runDaemon([
      { type: 'user_input', input: { text: 'help me plan a quiet beach holiday' },
        options: { conversation_id: 'conc5-pane' } },
      { type: 'user_input', input: { text: 'help me plan a quiet beach holiday' } },
    ], 90000, { HOME: home, TROTH_ENTITY_LLM: txPath, TROTH_ENTITY_LLM_PIN: '1', STATE_DB_PATH: conc5Db });
    const kinds = events.map((e) => e.kind);
    assert(kinds.includes('ready'), 'daemon must reach ready; stderr tail: ' + String(stderr || '').slice(-300));
    const tagged = events.find((e) => e.kind === 'response' && e.conversation_id === 'conc5-pane');
    const untagged = events.find((e) => e.kind === 'response' && !('conversation_id' in e));
    assert(tagged, 'tagged pane response must arrive; kinds: ' + kinds.join(','));
    assert(untagged, 'untagged (CLI/voice shape) response must arrive');
    assert(/SAW<NO>/.test(String(tagged.text)),
      'a focused pane must NOT see the foreign goal in its envelope: ' + String(tagged.text).slice(0, 120));
    assert(/SAW<YES>/.test(String(untagged.text)),
      'an unfocused surface keeps the concerns fallback (one mind): ' + String(untagged.text).slice(0, 120));
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(txDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('SR-1: daemon self-reaps when its script file vanishes (uninstall orphan guard)', async () => {
  const fs = require('fs');
  const os = require('os');
  // Own virgin HOME: daemons are singletons per state file and async test
  // bodies interleave, so sharing the suite home would race E2E-2.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-sr1-'));
  fs.mkdirSync(path.join(home, '.troth'), { recursive: true });
  // Sentinel stands in for the installed script via TROTH_SELF_REAP_PATH -
  // deleting bin/troth-entity.js itself would nuke the checkout.
  const sentinel = path.join(home, 'installed-script-sentinel');
  fs.writeFileSync(sentinel, 'x');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTITY], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        TROTH_ENTITY_LLM: 'echo',
        TROTH_LLAMA_SERVER_BIN: '/nonexistent-e2e-no-fetch',
        CLAUDE_PLUGIN_DATA: '',
        STATE_DB_PATH: '',
        TROTH_CONFIG_PATH: '',
        TROTH_CONFIG_DIR: '',
        TROTH_ENTITY_DAEMON: '1',
        TROTH_SELF_REAP_PATH: sentinel,
        TROTH_SELF_REAP_MS: '150',
        TROTH_SELF_REAP_GRACE_MS: '150',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events = [];
    let out = '';
    let err = '';
    let sentinelPulled = false;
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
        if (ev.kind === 'daemon_listening' && !sentinelPulled) {
          sentinelPulled = true;
          // Daemon is up and watching; simulate the uninstall.
          try { fs.unlinkSync(sentinel); } catch (e) { reject(e); }
        }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('SR-1 timed out: daemon never self-reaped; stderr tail: ' + err.slice(-400)));
    }, 30000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ events, code }); });
    // Daemon mode: stdin EOF must NOT kill it (that is the point of B3).
    child.stdin.end();
  });

  const kinds = result.events.map((e) => e.kind);
  assert(kinds.includes('daemon_listening'), 'daemon booted; got: ' + kinds.slice(0, 8).join(','));
  assert(kinds.includes('self_reap'), 'daemon announced self_reap; got: ' + kinds.join(','));
  assert(kinds.includes('stopped'), 'graceful halt ran (stopped event), not a bare exit');
  assert.strictEqual(result.code, 0, 'clean exit code');
  assert(!fs.existsSync(path.join(home, '.troth', 'entity-state.json')),
    'state file removed on shutdown so no spawner reattaches to a dead pid');
  fs.rmSync(home, { recursive: true, force: true });
});
};
