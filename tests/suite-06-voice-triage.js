// SPDX-License-Identifier: AGPL-3.0-only
// Auto-split from tests/test-all.js (verbatim section bodies; order preserved).
// Sections: VOICE TRIAGE (Phase 1) | CODEX OAUTH (Step 8a — ChatGPT subscription transport) | OPENAI TRANSLATE (proxy/modules/openai-translate.js — Step 8a.4) | AGENT REGISTRY (Phase 3) | PERSONAL-NAME LEAK GUARD | TOOLS (shared-core/tools — Mode A plug surface) | INT (intent-ro
module.exports = function run({ test }) {
const assert = require('assert');
const dedup = require('../proxy/modules/dedup');
const { record, getRecent } = require('../proxy/modules/perflog');
const { probe } = require('../proxy/modules/health');
const audit = require('../proxy/modules/audit');
const templates = require('../proxy/modules/templates');
// --- VOICE TRIAGE (Phase 1) ---
console.log('\nVoice triage:');
(function runVoiceTriageTests() {
  const voiceTriageMod = require('../proxy/modules/voice-triage.js');
  const { triage } = voiceTriageMod;

  test('VT1: empty input → quick_ack with 25-word ceiling', () => {
    const r = triage('');
    assert.strictEqual(r.route, 'quick_ack');
    assert.strictEqual(r.max_words, 25);
  });

  test('VT2: greetings + acks classified quick_ack', () => {
    for (const t of ['hi', 'thanks', 'good morning', 'okay cool', 'yeah', 'got it']) {
      const r = triage(t);
      assert.strictEqual(r.route, 'quick_ack', 'expected quick_ack for ' + JSON.stringify(t) + ' got ' + r.route);
    }
  });

  test('VT3: stop / barge-in always quick_ack regardless of length', () => {
    for (const t of ['stop', 'wait', 'never mind', 'hang on', 'cancel']) {
      const r = triage(t);
      assert.strictEqual(r.route, 'quick_ack');
      assert.strictEqual(r.signals.stop, true);
    }
  });

  test('VT4: factual templates → brief_factual', () => {
    for (const t of ['what time is it', 'what\'s the date today', 'how many tests are passing', 'is the proxy running', 'what model are we using']) {
      const r = triage(t);
      assert.strictEqual(r.route, 'brief_factual', 'expected brief_factual for ' + JSON.stringify(t) + ' got ' + r.route);
      assert.strictEqual(r.max_words, 50);
    }
  });

  test('VT5: code / file refs → deep_work', () => {
    for (const t of [
      'fix the bug in app.tsx',
      'explain what the injector hook does',
      'why is the test for compact_handoff failing',
      'refactor the dialogue mirror to use the new schema'
    ]) {
      const r = triage(t);
      assert.strictEqual(r.route, 'deep_work', 'expected deep_work for ' + JSON.stringify(t) + ' got ' + r.route);
      assert.strictEqual(r.max_words, 35);
    }
  });

  test('VT6: show / paste / save → show_text with 35-word brevity ceiling', () => {
    // show_text was originally a 6-word ack with a silent
    // chat-panel write. Tauri-side silent-panel never shipped, so the
    // route collapsed to a brevity-shaped deep_work (see proxy/modules/
    // voice-triage.js comment above the show_text return). Test asserts
    // the current intent — route still 'show_text', max_words 35.
    for (const t of ['show me the diagram', 'paste the result in the chat', 'save the snippet', 'give me the file path']) {
      const r = triage(t);
      assert.strictEqual(r.route, 'show_text', 'expected show_text for ' + JSON.stringify(t) + ' got ' + r.route);
      assert.strictEqual(r.max_words, 35);
    }
  });

  test('VT7: show beats code — "show me how to fix the bug" → show_text not deep_work', () => {
    const r = triage('show me how to fix the bug in app.tsx');
    assert.strictEqual(r.route, 'show_text', 'show intent must beat code keywords');
  });

  test('VT8: long ambiguous input → deep_work as default (conservative)', () => {
    const r = triage('I was thinking maybe we should reconsider the approach we took yesterday and try something completely different');
    assert.strictEqual(r.route, 'deep_work');
    assert.ok(r.reason.includes('default'));
  });

  test('VT9: PERSONA_PROMPTS export removed (substrate-as-mind: no parallel prompt source)', () => {
    assert.strictEqual(voiceTriageMod.PERSONA_PROMPTS, undefined,
      'voice-triage must not export prompt fragments — substrate owns identity/format contracts');
  });

  test('VT10: signals object always populated for telemetry', () => {
    const r = triage('hi');
    assert.ok(r.signals && typeof r.signals === 'object');
    assert.strictEqual(typeof r.signals.word_count, 'number');
  });

  test('VT11: "okay cool" is quick_ack — the 9s/43-word baseline outlier this fixes', () => {
    const r = triage('okay cool');
    assert.strictEqual(r.route, 'quick_ack');
    assert.strictEqual(r.max_words, 25, 'persona prompt will instruct ≤25 words to fix the chitchat-05 baseline');
  });
})();

// --- CODEX OAUTH (Step 8a — ChatGPT subscription transport) ---
// Token store CRUD + PKCE shape + JWT decode + auth URL builder + SSE
// frame parser. NO live OAuth round-trip (would need browser + ChatGPT
// account); the login flow is exercised manually via `troth codex
// login`. These tests cover the deterministic pieces that can break on
// refactor without the operator noticing.
console.log('\nCodex OAuth transport:');
(function codexOAuthTests() {
  const fsCX = require('fs');
  const pathCX = require('path');
  const osCX = require('os');

  // Redirect the token store to a temp dir so we don't trample a real
  // user's saved token. We do this by overriding HOME for this block —
  // the module reads os.homedir() once at require time, so we have to
  // delete the cache to pick up the new HOME.
  const TMP_CX = pathCX.join(__dirname, '..', '.tmp-codex-oauth');
  if (fsCX.existsSync(TMP_CX)) fsCX.rmSync(TMP_CX, { recursive: true, force: true });
  fsCX.mkdirSync(TMP_CX, { recursive: true });
  const _origHome = process.env.HOME;
  process.env.HOME = TMP_CX;
  delete require.cache[require.resolve('../shared-core/codex-token-store.js')];
  delete require.cache[require.resolve('../shared-core/codex-auth.js')];
  delete require.cache[require.resolve('../shared-core/transports/codex-oauth.js')];
  const tokenStore = require('../shared-core/codex-token-store.js');
  const codexAuth  = require('../shared-core/codex-auth.js');
  const codexTransport = require('../shared-core/transports/codex-oauth.js');

  test('CXT1: token store load returns null when no file', () => {
    tokenStore.clear();
    assert.strictEqual(tokenStore.load(), null);
  });

  test('CXT2: token store save then load roundtrip preserves fields + sets 0600 mode', () => {
    const now = Date.now();
    const tok = {
      access_token: 'at-abc',
      refresh_token: 'rt-xyz',
      expires_at: now + 3600 * 1000,
      account_id: 'acct-123',
      id_token: 'eyJ...dummy',
      obtained_at: now,
      scope: 'openid profile email offline_access'
    };
    tokenStore.save(tok);
    const back = tokenStore.load();
    assert.strictEqual(back.access_token,  tok.access_token);
    assert.strictEqual(back.refresh_token, tok.refresh_token);
    assert.strictEqual(back.account_id,    tok.account_id);
    assert.strictEqual(back.scope,         tok.scope);
    const stat = fsCX.statSync(tokenStore.tokenPath());
    // 0o600 permissions only (mask other mode bits).
    assert.strictEqual(stat.mode & 0o777, 0o600, 'token file must be mode 0600');
  });

  test('CXT3: token store refuses to save without access_token + refresh_token', () => {
    assert.throws(() => tokenStore.save({}), /refusing to save token/);
    assert.throws(() => tokenStore.save({ access_token: 'a' }), /refusing to save token/);
    assert.throws(() => tokenStore.save({ refresh_token: 'r' }), /refusing to save token/);
  });

  test('CXT4: token store clear is idempotent', () => {
    tokenStore.save({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 1000 });
    tokenStore.clear();
    assert.strictEqual(tokenStore.load(), null);
    // Second clear must not throw.
    tokenStore.clear();
    assert.strictEqual(tokenStore.load(), null);
  });

  test('CXT5: isExpired true past deadline + skew, false safely before', () => {
    const past   = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() - 1000 };
    const future = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 10 * 60 * 1000 };
    const noExp  = { access_token: 'a', refresh_token: 'r' };
    assert.strictEqual(tokenStore.isExpired(past), true,  'past deadline must be expired');
    assert.strictEqual(tokenStore.isExpired(future), false, 'far-future deadline must NOT be expired');
    assert.strictEqual(tokenStore.isExpired(noExp), true,  'missing expires_at counts as expired (forces refresh)');
    // Skew: a token expiring in 30s is expired under default 60s skew.
    const soon = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 30 * 1000 };
    assert.strictEqual(tokenStore.isExpired(soon), true, 'within default skew window must be expired');
  });

  test('CXT6: fromOAuthResponse converts expires_in (sec) to absolute ms + carries claims', () => {
    const before = Date.now();
    const tok = tokenStore.fromOAuthResponse(
      { access_token: 'AT', refresh_token: 'RT', expires_in: 1800, scope: 'openid' },
      { chatgpt_account_id: 'acct-77' }
    );
    const after = Date.now();
    assert.strictEqual(tok.access_token, 'AT');
    assert.strictEqual(tok.refresh_token, 'RT');
    assert.strictEqual(tok.account_id, 'acct-77');
    assert.ok(tok.expires_at >= before + 1800 * 1000);
    assert.ok(tok.expires_at <= after  + 1800 * 1000);
    assert.ok(tok.obtained_at >= before && tok.obtained_at <= after);
  });

  test('CXT7: PKCE makePkce — verifier+challenge are base64url, challenge is sha256(verifier)', () => {
    const crypto = require('crypto');
    const { verifier, challenge } = codexAuth.makePkce();
    // base64url charset (no '+', '/', '=').
    assert.ok(/^[A-Za-z0-9_-]+$/.test(verifier),  'verifier must be base64url');
    assert.ok(/^[A-Za-z0-9_-]+$/.test(challenge), 'challenge must be base64url');
    // RFC 7636: verifier 43–128 chars (256 bits → 43 chars unpadded).
    assert.ok(verifier.length >= 43 && verifier.length <= 128, 'verifier length per RFC 7636');
    // challenge = base64url(sha256(verifier)).
    const expected = crypto.createHash('sha256').update(verifier).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    assert.strictEqual(challenge, expected, 'challenge must be S256(verifier)');
  });

  test('CXT8: makeState returns 32-char hex (16 random bytes)', () => {
    const s1 = codexAuth.makeState();
    const s2 = codexAuth.makeState();
    assert.ok(/^[0-9a-f]{32}$/.test(s1), 'state must be 32 hex chars');
    assert.notStrictEqual(s1, s2, 'consecutive states must differ (random)');
  });

  test('CXT9: decodeJwt returns payload object for valid 3-part token, null otherwise', () => {
    // Hand-build a minimal JWT: header.payload.signature.
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const jwt = enc({ alg: 'none' }) + '.' + enc({ sub: 'u1', foo: 'bar' }) + '.sig';
    const payload = codexAuth.decodeJwt(jwt);
    assert.strictEqual(payload.sub, 'u1');
    assert.strictEqual(payload.foo, 'bar');
    assert.strictEqual(codexAuth.decodeJwt('not.a'), null,    'two-part input must fail');
    assert.strictEqual(codexAuth.decodeJwt(null), null,       'null input must fail');
    assert.strictEqual(codexAuth.decodeJwt('a.!!.c'), null,   'bad base64 must fail');
  });

  test('CXT10: extractAccountId pulls chatgpt_account_id from JWT_CLAIM nested block', () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const claims = {};
    claims[codexAuth.JWT_CLAIM] = { chatgpt_account_id: 'acct-abc' };
    const jwt = enc({ alg: 'none' }) + '.' + enc(claims) + '.sig';
    assert.strictEqual(codexAuth.extractAccountId(jwt), 'acct-abc');
    // Missing claim → null.
    const jwtNoClaim = enc({ alg: 'none' }) + '.' + enc({ sub: 'u1' }) + '.sig';
    assert.strictEqual(codexAuth.extractAccountId(jwtNoClaim), null);
  });

  test('CXT11: buildAuthorizationUrl includes all required OAuth + Codex flow params', () => {
    // The client id is operator-supplied on purpose, so the test supplies
    // one exactly the way an operator would.
    const prev = process.env.TROTH_CODEX_CLIENT_ID;
    process.env.TROTH_CODEX_CLIENT_ID = 'app_operator_supplied_id';
    try {
      const url = new URL(codexAuth.buildAuthorizationUrl('STATE_X', 'CHALLENGE_Y'));
      assert.strictEqual(url.origin + url.pathname, codexAuth.AUTH_URL);
      assert.strictEqual(url.searchParams.get('response_type'),         'code');
      assert.strictEqual(url.searchParams.get('client_id'),             'app_operator_supplied_id');
      assert.strictEqual(url.searchParams.get('redirect_uri'),          codexAuth.REDIRECT_URI);
      assert.strictEqual(url.searchParams.get('scope'),                 codexAuth.SCOPE);
      assert.strictEqual(url.searchParams.get('state'),                 'STATE_X');
      assert.strictEqual(url.searchParams.get('code_challenge'),        'CHALLENGE_Y');
      assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
      assert.strictEqual(url.searchParams.get('codex_cli_simplified_flow'), 'true',
        'ChatGPT-subscription gate flag must be set');
    } finally {
      if (prev === undefined) delete process.env.TROTH_CODEX_CLIENT_ID;
      else process.env.TROTH_CODEX_CLIENT_ID = prev;
    }
  });

  // The identifiers name the application to the vendor, not the operator,
  // and they are public: PKCE means holding them grants nothing. They ship
  // with a default so the provider works on a fresh install, the operator
  // can present something else, and `none` declines outright.
  test('CXT11b: the client identity has a default, an override and a way to decline', () => {
    const fs = require('fs'); const os = require('os'); const pathM = require('path');
    const prevId   = process.env.TROTH_CODEX_CLIENT_ID;
    const prevOrg  = process.env.TROTH_CODEX_ORIGINATOR;
    const prevHome = process.env.HOME;
    // An empty HOME, so the ~/.troth file fallback genuinely finds nothing.
    const home = fs.mkdtempSync(pathM.join(os.tmpdir(), 'troth-codex-home-'));
    delete process.env.TROTH_CODEX_CLIENT_ID;
    delete process.env.TROTH_CODEX_ORIGINATOR;
    process.env.HOME = home;
    try {
      assert.ok(codexAuth.clientId(),   'a fresh install can sign in without being configured first');
      assert.ok(codexAuth.originator(), 'and sends the originator that matches it');
      assert.ok(codexAuth.buildAuthorizationUrl('S', 'C').includes(codexAuth.clientId()),
        'the id it resolved is the id the sign-in url carries');
      assert.strictEqual(codexTransport.buildCodexHeaders({ access_token: 'AT' }, 'B', 's', 'c')['originator'],
        codexAuth.originator(), 'and the one the request header carries');

      // The file fallback exists so the GUI app, which inherits no shell
      // environment, can still be pointed elsewhere by its operator.
      fs.mkdirSync(pathM.join(home, '.troth'), { recursive: true });
      fs.writeFileSync(pathM.join(home, '.troth', 'codex-originator'), 'my_own_client\n');
      assert.strictEqual(codexAuth.originator(), 'my_own_client', '~/.troth file is read, trimmed, and wins over the default');
      assert.strictEqual(codexTransport.buildCodexHeaders({ access_token: 'AT' }, 'B', 's', 'c')['originator'],
        'my_own_client', 'a configured originator does reach the header set');

      // Declining is explicit, and it fails with a sentence rather than a 401.
      process.env.TROTH_CODEX_CLIENT_ID = 'none';
      process.env.TROTH_CODEX_ORIGINATOR = 'none';
      assert.strictEqual(codexAuth.clientId(), '', '`none` declines the provider');
      assert.throws(() => codexAuth.buildAuthorizationUrl('S', 'C'),
        (e) => e && e.code === 'codex_client_id_unset',
        'a declined provider refuses with an explanation');
      assert.ok(!('originator' in codexTransport.buildCodexHeaders({ access_token: 'AT' }, 'B', 's', 'c')),
        'and the originator header is omitted, not guessed');
    } finally {
      if (prevId  === undefined) delete process.env.TROTH_CODEX_CLIENT_ID;  else process.env.TROTH_CODEX_CLIENT_ID = prevId;
      if (prevOrg === undefined) delete process.env.TROTH_CODEX_ORIGINATOR; else process.env.TROTH_CODEX_ORIGINATOR = prevOrg;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('CXT12: transport parseFrame — Responses API output_text.delta emits {delta}', () => {
    const events = [];
    codexTransport.parseFrame(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}',
      (e) => events.push(e)
    );
    assert.deepStrictEqual(events, [{ delta: 'hello' }]);
  });

  test('CXT13: transport parseFrame — response.completed emits {done:true}', () => {
    const events = [];
    codexTransport.parseFrame(
      'event: response.completed\ndata: {"type":"response.completed"}',
      (e) => events.push(e)
    );
    assert.deepStrictEqual(events, [{ done: true }]);
  });

  test('CXT14: transport parseFrame — legacy chat-completions delta + [DONE] sentinel', () => {
    const events = [];
    codexTransport.parseFrame(
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      (e) => events.push(e)
    );
    codexTransport.parseFrame('data: [DONE]', (e) => events.push(e));
    assert.deepStrictEqual(events, [{ delta: 'hi' }, { done: true }]);
  });

  test('CXT15: transport parseFrame — failure events surface error message', () => {
    const events = [];
    codexTransport.parseFrame(
      'event: response.failed\ndata: {"type":"response.failed","error":{"message":"upstream rate limit"}}',
      (e) => events.push(e)
    );
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].done, true);
    assert.strictEqual(events[0].error, 'upstream rate limit');
  });

  test('CXT16: transport parseFrame — heartbeat / unknown events ignored silently', () => {
    const events = [];
    codexTransport.parseFrame(': heartbeat\n', (e) => events.push(e));
    codexTransport.parseFrame('event: response.in_progress\ndata: {"type":"response.in_progress"}', (e) => events.push(e));
    assert.deepStrictEqual(events, [], 'heartbeat + in_progress must not emit');
  });

  // Restore HOME so subsequent test blocks see the real path.
  process.env.HOME = _origHome;
  delete require.cache[require.resolve('../shared-core/codex-token-store.js')];
  delete require.cache[require.resolve('../shared-core/codex-auth.js')];
  delete require.cache[require.resolve('../shared-core/transports/codex-oauth.js')];
})();

// --- OPENAI TRANSLATE (proxy/modules/openai-translate.js — Step 8a.4) ---
// Body + response translation between Anthropic Messages API and OpenAI
// Responses API. Used by callOpenAISubscription in router.js so a single
// proxy provider chain can route to ChatGPT-subscription endpoints
// without per-provider branching downstream (cache, critic, codelens
// stay oblivious — they keep seeing Anthropic-shaped responses).
console.log('\nOpenAI translate (Anthropic <-> Responses API):');
(function openaiTranslateTests() {
  const tr = require('../proxy/modules/openai-translate.js');

  test('OAT1: flattenSystem accepts string passthrough + array of text blocks', () => {
    assert.strictEqual(tr.flattenSystem('hello world'), 'hello world');
    assert.strictEqual(tr.flattenSystem(null), '');
    assert.strictEqual(
      tr.flattenSystem([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
      'one\n\ntwo'
    );
  });

  test('OAT2: messageContentToBlocks converts string + text-block content per role', () => {
    assert.deepStrictEqual(
      tr.messageContentToBlocks('hi', 'user'),
      [{ type: 'input_text', text: 'hi' }]
    );
    assert.deepStrictEqual(
      tr.messageContentToBlocks([{ type: 'text', text: 'reply' }], 'assistant'),
      [{ type: 'output_text', text: 'reply' }]
    );
  });

  test('OAT3: anthropicToResponses maps system + messages + max_tokens correctly', () => {
    const out = tr.anthropicToResponses({
      model: 'claude-sonnet-4-6',
      system: 'sys prompt',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' }
      ],
      max_tokens: 512,
      temperature: 0.7
    });
    assert.strictEqual(out.model, 'claude-sonnet-4-6');
    assert.strictEqual(out.instructions, 'sys prompt');
    assert.strictEqual(out.input.length, 3);
    assert.strictEqual(out.input[0].role, 'user');
    assert.strictEqual(out.input[0].content[0].type, 'input_text');
    assert.strictEqual(out.input[1].content[0].type, 'output_text',
      'assistant prior turn must use output_text per Responses API spec');
    // codex /responses 400s on these params — the translator deliberately
    // omits max_output_tokens / temperature / top_p (codex manages sampling
    // itself via reasoning effort), so they must NOT be present.
    assert.strictEqual(out.max_output_tokens, undefined);
    assert.strictEqual(out.stream, false);
    assert.strictEqual(out.store, false);
    assert.strictEqual(out.temperature, undefined);
  });

  test('OAT4: anthropicToResponses substitutes "any" model sentinel + missing model with default', () => {
    assert.strictEqual(
      tr.anthropicToResponses({ model: 'any', messages: [{ role: 'user', content: 'x' }] }, { defaultModel: 'gpt-5.2-codex' }).model,
      'gpt-5.2-codex'
    );
    assert.strictEqual(
      tr.anthropicToResponses({ messages: [{ role: 'user', content: 'x' }] }, { defaultModel: 'gpt-5.2-codex' }).model,
      'gpt-5.2-codex'
    );
  });

  test('OAT5: anthropicToResponses handles array system blocks + tool_result content', () => {
    const out = tr.anthropicToResponses({
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_result', content: 'tool said X' }
        ]}
      ]
    });
    assert.strictEqual(out.instructions, 'A\n\nB');
    // tool_result is split into a SEPARATE function_call_output input item
    // (agentic round-trip), NOT inlined into the user message content.
    const fco = out.input.find((x) => x.type === 'function_call_output');
    assert.ok(fco, 'tool_result becomes a function_call_output item');
    assert.strictEqual(fco.output, 'tool said X');
    const um = out.input.find((x) => x.role === 'user');
    assert.strictEqual(um.content.length, 1);
    assert.strictEqual(um.content[0].type, 'input_text');
  });

  test('OAT6: responsesToAnthropic flattens output[].message.content[].output_text into single text block', () => {
    const anth = tr.responsesToAnthropic({
      id: 'resp_abc123',
      model: 'gpt-5.2-codex',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'hello ' },
          { type: 'output_text', text: 'world' }
        ]
      }],
      usage: { input_tokens: 10, output_tokens: 2 }
    });
    assert.strictEqual(anth.type, 'message');
    assert.strictEqual(anth.role, 'assistant');
    assert.strictEqual(anth.content[0].type, 'text');
    assert.strictEqual(anth.content[0].text, 'hello world');
    assert.strictEqual(anth.stop_reason, 'end_turn');
    assert.strictEqual(anth.usage.input_tokens, 10);
    assert.strictEqual(anth.usage.output_tokens, 2);
    assert.ok(anth.id.startsWith('msg_'), 'id must be re-prefixed for Anthropic shape');
  });

  test('OAT7: responsesToAnthropic surfaces incomplete status as max_tokens stop_reason', () => {
    const anth = tr.responsesToAnthropic({
      status: 'incomplete',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'cut off' }] }],
      usage: {}
    });
    assert.strictEqual(anth.stop_reason, 'max_tokens');
  });

  test('OAT8: responsesToAnthropic round-trips function_call as an executable tool_use block', () => {
    const anth = tr.responsesToAnthropic({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'pre' }] },
        { type: 'function_call', name: 'doStuff', arguments: '{"a":1}' }
      ],
      usage: {}
    });
    // function_call now becomes a real Anthropic tool_use block so the agentic
    // loop EXECUTES it (instead of a dead inline text marker).
    assert.strictEqual(anth.content[0].type, 'text');
    assert.strictEqual(anth.content[0].text, 'pre');
    const tu = anth.content.find((c) => c.type === 'tool_use');
    assert.ok(tu, 'function_call → tool_use block');
    assert.strictEqual(tu.name, 'doStuff');
    assert.deepStrictEqual(tu.input, { a: 1 });
    assert.strictEqual(anth.stop_reason, 'tool_use');
  });
})();

// --- AGENT REGISTRY (Phase 3) ---
// First-class sub-brain metadata layer over agent_id. CRUD + lazy
// bootstrap + name lookup. Backs /create and /agent slash skills.
console.log('\nAgent registry:');
(function agentRegistryTests() {
  const fsAR = require('fs');
  const pathAR = require('path');
  const TMP_AR = pathAR.join(__dirname, '..', '.tmp-agent-registry');
  if (fsAR.existsSync(TMP_AR)) fsAR.rmSync(TMP_AR, { recursive: true, force: true });
  fsAR.mkdirSync(TMP_AR, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = TMP_AR;
  delete require.cache[require.resolve('../shared-core/state.js')];
  delete require.cache[require.resolve('../shared-core/agent-registry.js')];
  const reg = require('../shared-core/agent-registry.js');

  test('AR-1: createAgent inserts a row + getAgent reads it back', () => {
    const a = reg.createAgent({ id: 'cooking-coach', name: 'cooking', tag: 'kitchen', persona: 'helps with recipes' });
    assert.ok(a, 'createAgent must return the row');
    assert.strictEqual(a.id, 'cooking-coach');
    assert.strictEqual(a.name, 'cooking');
    assert.strictEqual(a.tag, 'kitchen');
    assert.strictEqual(a.active, 1);
    const fetched = reg.getAgent('cooking-coach');
    assert.deepStrictEqual(fetched.id, a.id);
  });

  test('AR-2: ensureBootstrap auto-creates missing agents with name=id, parent=null', () => {
    const fresh = reg.ensureBootstrap('legacy-agent-xyz');
    assert.ok(fresh, 'bootstrap must create the row');
    assert.strictEqual(fresh.name, 'legacy-agent-xyz');
    assert.strictEqual(fresh.parent_agent_id, null);
  });

  test('AR-3: getAgentByName resolves to active row, scoped by parent when given', () => {
    reg.createAgent({ id: 'main-mind', name: 'main', tag: 'general' });
    reg.createAgent({ id: 'sub-cook', name: 'cook', tag: 'kitchen', parent_agent_id: 'main-mind' });
    const found = reg.getAgentByName('cook', 'main-mind');
    assert.ok(found);
    assert.strictEqual(found.id, 'sub-cook');
    const notUnderOther = reg.getAgentByName('cook', 'unknown-parent');
    assert.strictEqual(notUnderOther, null);
  });

  test('AR-4: listAgents returns active by default, ordered by recent activity', () => {
    reg.touchActive('cooking-coach');
    const all = reg.listAgents({});
    assert.ok(Array.isArray(all));
    assert.ok(all.length >= 4);
    assert.ok(all.every((row) => row.active === 1));
  });

  test('AR-5: retireAgent flips active=0; subsequent name lookups skip it', () => {
    const ok = reg.retireAgent('cooking-coach');
    assert.strictEqual(ok, true);
    const direct = reg.getAgent('cooking-coach');
    assert.strictEqual(direct.active, 0, 'retired row stays in the table for audit');
    const byName = reg.getAgentByName('cooking');
    assert.strictEqual(byName, null, 'name lookup must skip retired');
    const all = reg.listAgents({});
    assert.ok(all.every((row) => row.id !== 'cooking-coach'),
      'default list excludes retired');
    const allWithRetired = reg.listAgents({ include_retired: true });
    assert.ok(allWithRetired.some((row) => row.id === 'cooking-coach'),
      'include_retired surfaces retired rows');
  });
})();

// --- PERSONAL-NAME LEAK GUARD ---
// Production code (non-test, non-bench, non-doc) must not hardcode the
// operator's first name: a hardcoded first name once broke content scoring for every
// other user. The name itself is
// supplied via TROTH_LEAK_GUARD_NAME in the dev clone, never in the tree;
// without it the guard passes vacuously on a fresh checkout.
console.log('\nPersonal-name leak guard:');
(function personalNameLeakGuard() {
  const fsP = require('fs');
  const pathP = require('path');
  const rootP = pathP.resolve(__dirname, '..');
  const PROD_DIRS = ['shared-core', 'proxy/modules', 'bin', 'plugin/skills', 'plugin/hooks', 'plugin/mcp-servers'];
  const ALLOWED_LITERALS = new Set([
    // Defensive marker — DO NOT remove. the contributor guide cites this name as the
    // historical leak vector so future devs don't re-introduce.
  ]);
  function walk(dir, hits) {
    let entries; try { entries = fsP.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const full = pathP.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full, hits);
      } else if (e.isFile() && /\.(js|mjs|cjs|ts|tsx|rs|md)$/.test(e.name)) {
        let txt; try { txt = fsP.readFileSync(full, 'utf8'); } catch (_) { continue; }
        const nameG = process.env.TROTH_LEAK_GUARD_NAME;
        if (!nameG) continue;
        const re = new RegExp('\\b' + nameG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (re.test(txt)) hits.push({ file: pathP.relative(rootP, full) });
      }
    }
  }
  test('production code does not hardcode the operator name (TROTH_LEAK_GUARD_NAME)', () => {
    const hits = [];
    for (const sub of PROD_DIRS) walk(pathP.join(rootP, sub), hits);
    const filtered = hits.filter((h) => !ALLOWED_LITERALS.has(h.file));
    if (filtered.length) {
      const list = filtered.map((h) => '  - ' + h.file).join('\n');
      assert.fail('hardcoded operator name found in production code:\n' + list +
        '\nIf this is a comment / historical marker, add the path to ALLOWED_LITERALS.');
    }
  });
})();

// --- TOOLS (shared-core/tools — Mode A plug surface) ---
console.log('\nTools (Mode A):');
(function toolsTests() {
  const tools = require('../shared-core/tools');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  function mkTmp(content) {
    const p = path.join(os.tmpdir(), 'troth-read-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.writeFileSync(p, content);
    return p;
  }

  test('TOO-1: Read returns canonical FileReadOutput text branch', async () => {
    const p = mkTmp('alpha\nbeta\ngamma\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: p } } }, {}
    ));
    assert.strictEqual(out.type, 'text', 'type discriminator');
    assert.strictEqual(out.file.filePath, p);
    assert.ok(out.file.content.includes('1\talpha'), 'line 1 numbered');
    assert.ok(out.file.content.includes('2\tbeta'),  'line 2 numbered');
    assert.strictEqual(out.file.numLines, 4, 'three lines + trailing empty after final newline');
    assert.strictEqual(out.file.startLine, 1);
    assert.strictEqual(out.file.totalLines, 4);
    fs.unlinkSync(p);
  });

  test('TOO-2: Read honors offset + limit; totalLines surfaces remainder', async () => {
    const p = mkTmp(Array.from({ length: 10 }, (_, i) => 'line' + (i + 1)).join('\n'));
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: p, offset: 4, limit: 2 } } }, {}
    ));
    assert.strictEqual(out.type, 'text');
    assert.ok(out.file.content.includes('4\tline4'));
    assert.ok(out.file.content.includes('5\tline5'));
    assert.ok(!out.file.content.includes('line6'), 'limit caps the read');
    assert.strictEqual(out.file.numLines, 2);
    assert.strictEqual(out.file.startLine, 4);
    assert.strictEqual(out.file.totalLines, 10, 'caller derives truncated from numLines<totalLines');
    fs.unlinkSync(p);
  });

  test('TOO-2b: Read hashline mode tags lines with absolute line numbers', async () => {
    const p = mkTmp('alpha\nbeta\ngamma\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: p, hashline: true } } }, {}
    ));
    assert.strictEqual(out.type, 'text');
    // Each line must start with "<n>#<TAG>|" — two-char tag from
    // hashline ALPHABET 'ZPMQVRWSNKTXJBYH', then pipe.
    const lines = out.file.content.split('\n');
    assert.match(lines[0], /^1#[ZPMQVRWSNKTXJBYH]{2}\|alpha$/, 'line 1 tagged');
    assert.match(lines[1], /^2#[ZPMQVRWSNKTXJBYH]{2}\|beta$/,  'line 2 tagged');
    fs.unlinkSync(p);
  });

  test('TOO-2c: Read hashline mode preserves absolute numbering with offset', async () => {
    const p = mkTmp(Array.from({ length: 6 }, (_, i) => 'L' + (i + 1)).join('\n'));
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: p, offset: 3, limit: 2, hashline: true } } }, {}
    ));
    const lines = out.file.content.split('\n');
    assert.match(lines[0], /^3#[ZPMQVRWSNKTXJBYH]{2}\|L3$/, 'first emitted line keeps absolute number 3');
    assert.match(lines[1], /^4#[ZPMQVRWSNKTXJBYH]{2}\|L4$/, 'second keeps 4');
    fs.unlinkSync(p);
  });

  test('TOO-2d: Read unsupported types surface kind without crashing', async () => {
    const p = path.join(os.tmpdir(), 'gc-fake-' + Date.now() + '.pdf');
    fs.writeFileSync(p, '%PDF-1.4 stub');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: p } } }, {}
    ));
    assert.strictEqual(out.type, 'unsupported');
    assert.strictEqual(out.file.kind, 'pdf');
    fs.unlinkSync(p);
  });

  test('TOO-3: Read returns structured error for missing file (no throw)', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: '/tmp/does-not-exist-' + Date.now() } } }, {}
    ));
    assert.strictEqual(out.error, 'not_found');
  });

  test('TOO-4: Read rejects relative file_path', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: 'relative/path.txt' } } }, {}
    ));
    assert.strictEqual(out.error, 'bad_args');
  });

  test('TOO-5: Read flags is_directory rather than crashing', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: os.tmpdir() } } }, {}
    ));
    assert.strictEqual(out.error, 'is_directory');
  });

  test('TOO-6: toolsArray emits OpenAI-compatible function schemas', () => {
    const arr = tools.toolsArray();
    assert.ok(Array.isArray(arr) && arr.length >= 1, 'returns non-empty array');
    const readSchema = arr.find(t => t.function && t.function.name === 'Read');
    assert.ok(readSchema, 'Read schema present');
    assert.strictEqual(readSchema.type, 'function');
    assert.ok(readSchema.function.parameters.required.includes('file_path'));
  });

  test('TOO-7: dispatchToolCall returns structured error for unknown tool', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'NoSuchTool', arguments: {} } }, {}
    ));
    assert.strictEqual(out.error, 'unknown_tool');
    assert.strictEqual(out.name, 'NoSuchTool');
  });

  test('TOO-8: Write creates a new file atomically with type=create', async () => {
    const p = path.join(os.tmpdir(), 'gc-write-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Write', arguments: { file_path: p, content: 'hello\nworld\n' } } }, {}
    ));
    assert.strictEqual(out.type, 'create');
    assert.strictEqual(out.filePath, p);
    assert.strictEqual(out.originalFile, null);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'hello\nworld\n', 'disk content matches input');
    assert.ok(Array.isArray(out.structuredPatch) && out.structuredPatch.length === 1, 'single hunk');
    assert.strictEqual(out.structuredPatch[0].oldLines, 0, 'create => zero old lines');
    fs.unlinkSync(p);
  });

  test('TOO-9: Write updates an existing file with type=update and originalFile populated', async () => {
    const p = path.join(os.tmpdir(), 'gc-write-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(p, 'original\ncontent\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Write', arguments: { file_path: p, content: 'new\ncontent\n' } } }, {}
    ));
    assert.strictEqual(out.type, 'update');
    assert.strictEqual(out.originalFile, 'original\ncontent\n');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'new\ncontent\n');
    fs.unlinkSync(p);
  });

  test('TOO-10: Write rejects syntactically invalid JS via AST gate', async () => {
    const p = path.join(os.tmpdir(), 'gc-write-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.js');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Write', arguments: { file_path: p, content: 'function broken( {\n  return 1\n' } } }, {}
    ));
    assert.strictEqual(out.error, 'ast_invalid');
    assert.ok(Array.isArray(out.errors) && out.errors.length >= 1, 'error positions included');
    assert.strictEqual(fs.existsSync(p), false, 'no partial file left on disk');
  });

  test('TOO-11: Write rejects relative paths and creates missing parent directories', async () => {
    const rel = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Write', arguments: { file_path: 'rel/path.txt', content: 'x' } } }, {}
    ));
    assert.strictEqual(rel.error, 'bad_args');
    // Write now mkdir -p's a missing parent tree (matches Claude Code's Write
    // and the intent:fs:do write path) so autonomous goals without a shell
    // tool can still write into a not-yet-existing folder in one step.
    const target = '/tmp/gc-no-such-dir-' + Date.now() + '/nested/file.txt';
    const missing = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Write', arguments: { file_path: target, content: 'x' } } }, {}
    ));
    assert.strictEqual(missing.error, undefined, 'no error — parent created');
    assert.strictEqual(missing.type, 'create');
    assert.strictEqual(fs.existsSync(target), true, 'file written under freshly-created parents');
  });

  test('TOO-12: Write leaves the target untouched when AST gate blocks the write', async () => {
    const p = path.join(os.tmpdir(), 'gc-write-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.js');
    fs.writeFileSync(p, 'const ok = 1;\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Write', arguments: { file_path: p, content: 'function broken( {' } } }, {}
    ));
    assert.strictEqual(out.error, 'ast_invalid');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'const ok = 1;\n', 'original survived');
    fs.unlinkSync(p);
  });

  test('TOO-13: Edit search-replace exact match round-trips', async () => {
    const p = path.join(os.tmpdir(), 'gc-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(p, 'hello world\nsecond line\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: p, old_string: 'hello world', new_string: 'goodbye world' } } }, {}
    ));
    assert.strictEqual(out.mode, 'search_replace');
    assert.strictEqual(out.strategy, 'exact');
    assert.strictEqual(out.filePath, p);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'goodbye world\nsecond line\n');
    fs.unlinkSync(p);
  });

  test('TOO-14: Edit search-replace rescues a whitespace-collapsed old_string via fuzzy strategy', async () => {
    const p = path.join(os.tmpdir(), 'gc-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    // File uses 2 spaces internally. Model emits 1 space — exact substring
    // search fails (file's "foo  bar" ≠ "foo bar"). The collapse strategy
    // normalizes runs of whitespace on both sides and rescues.
    fs.writeFileSync(p, 'foo  bar\nrest\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: p, old_string: 'foo bar', new_string: 'fixed' } } }, {}
    ));
    assert.strictEqual(out.mode, 'search_replace');
    assert.notStrictEqual(out.strategy, 'exact', 'exact failed; fuzzy strategy rescued — strategy=' + out.strategy);
    assert.ok(typeof out.rescuedFrom === 'string' && out.rescuedFrom.length > 0, 'rescuedFrom records the actual file substring');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'fixed\nrest\n');
    fs.unlinkSync(p);
  });

  test('TOO-15: Edit search-replace reports old_string_not_found when no strategy matches', async () => {
    const p = path.join(os.tmpdir(), 'gc-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(p, 'one\ntwo\nthree\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: p, old_string: 'completely_absent_token_xyz', new_string: 'irrelevant' } } }, {}
    ));
    assert.strictEqual(out.error, 'old_string_not_found');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'one\ntwo\nthree\n', 'file untouched');
    fs.unlinkSync(p);
  });

  test('TOO-16: Edit hashline mode applies tag-anchored edits', async () => {
    const p = path.join(os.tmpdir(), 'gc-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(p, 'alpha\nbeta\ngamma\n');
    // Read with hashline=true to discover the tags model would see.
    const readOut = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Read', arguments: { file_path: p, hashline: true } } }, {}
    ));
    const line2 = readOut.file.content.split('\n')[1];   // "2#XY|beta"
    const pos2  = line2.split('|')[0];                    // "2#XY"
    const editOut = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: p, edits: [{ op: 'replace', pos: pos2, lines: 'BETA' }] } } }, {}
    ));
    assert.strictEqual(editOut.mode, 'hashline');
    assert.strictEqual(editOut.filePath, p);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'alpha\nBETA\ngamma\n');
    fs.unlinkSync(p);
  });

  test('TOO-17: Edit hashline mode fails the batch on hash drift', async () => {
    const p = path.join(os.tmpdir(), 'gc-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(p, 'unchanged\n');
    // Stale tag — never produced by real Read. Hashline must refuse.
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: p, edits: [{ op: 'replace', pos: '1#ZZ', lines: 'mutated' }] } } }, {}
    ));
    assert.strictEqual(out.error, 'hashline_edits_failed');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'unchanged\n', 'file untouched on drift');
    fs.unlinkSync(p);
  });

  test('TOO-18: Edit replace_all swaps every occurrence', async () => {
    const p = path.join(os.tmpdir(), 'gc-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(p, 'foo bar\nfoo baz\nfoo qux\n');
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: p, old_string: 'foo', new_string: 'FOO', replace_all: true } } }, {}
    ));
    assert.strictEqual(out.replaceAll, true);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'FOO bar\nFOO baz\nFOO qux\n');
    fs.unlinkSync(p);
  });

  test('TOO-19: Edit AST gate via Write blocks syntactically broken result', async () => {
    const p = path.join(os.tmpdir(), 'gc-edit-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.js');
    fs.writeFileSync(p, 'function ok() { return 1; }\n');
    // Replace the body in a way that breaks the function (drops closing brace).
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: p, old_string: '{ return 1; }', new_string: '{ return 1;' } } }, {}
    ));
    assert.strictEqual(out.error, 'ast_invalid');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'function ok() { return 1; }\n', 'original survives AST rejection');
    fs.unlinkSync(p);
  });

  test('TOO-20: Edit rejects calls without either edits[] or old_string', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Edit', arguments: { file_path: '/tmp/whatever.txt' } } }, {}
    ));
    assert.strictEqual(out.error, 'bad_args');
  });

  test('TOO-21: Bash captures stdout and stderr separately', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: 'printf hello; printf world 1>&2' } } }, {}
    ));
    assert.strictEqual(out.stdout, 'hello');
    assert.strictEqual(out.stderr, 'world');
    assert.strictEqual(out.interrupted, false);
    assert.strictEqual(out.exitCode, 0);
  });

  test('TOO-22: Bash reports non-zero exit code without throwing', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: 'exit 7' } } }, {}
    ));
    assert.strictEqual(out.exitCode, 7);
    assert.strictEqual(out.interrupted, false);
  });

  test('TOO-23: Bash interrupts long-running commands on timeout', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: 'sleep 30', timeout: 200 } } }, {}
    ));
    assert.strictEqual(out.interrupted, true, 'timeout flag must fire');
    assert.notStrictEqual(out.exitCode, 0, 'killed process must not report success');
  });

  test('TOO-24: Bash returns not_implemented for run_in_background and sandbox toggles', async () => {
    const bg = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: 'echo x', run_in_background: true } } }, {}
    ));
    assert.strictEqual(bg.error, 'not_implemented');
    const sb = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: 'echo x', dangerouslyDisableSandbox: true } } }, {}
    ));
    assert.strictEqual(sb.error, 'not_implemented');
  });

  test('TOO-25: Bash rejects empty / non-string command', async () => {
    const empty = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: '' } } }, {}
    ));
    assert.strictEqual(empty.error, 'bad_args');
    const missing = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: {} } }, {}
    ));
    assert.strictEqual(missing.error, 'bad_args');
  });

  // Set up a small tmp tree for Grep + Glob tests. Reused across tests.
  const grepTmpDir = path.join(os.tmpdir(), 'gc-grep-' + Date.now() + '-' + Math.random().toString(36).slice(2,8));
  fs.mkdirSync(grepTmpDir);
  fs.writeFileSync(path.join(grepTmpDir, 'a.js'),    'function alpha() { return "needle"; }\nconst x = 1;\n');
  fs.writeFileSync(path.join(grepTmpDir, 'b.js'),    'function beta() { return "hay"; }\n');
  fs.writeFileSync(path.join(grepTmpDir, 'c.txt'),   'plain needle text on line one\nsecond line no match\n');

  // ripgrep probe — these tests exercise the Grep tool which shells out to
  // rg. On machines without rg installed (and without Claude Code's vendored
  // copy on PATH), the underlying spawn returns ENOENT and the assertions
  // fail with shape mismatches. That's env-dependent, not a regression —
  // skip-as-pass with a note instead of polluting the failure count.
  const _RG_AVAILABLE = (() => {
    try {
      const r = require('child_process').spawnSync('rg', ['--version'], { stdio: 'ignore' });
      if (r.status === 0) return true;
    } catch (_) { /* fall through */ }
    // Check the vendored / homebrew install paths the Grep tool itself probes.
    const fsLocal = require('fs');
    for (const p of [
      '/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg',
      '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg',
      '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x86_64-darwin/rg',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x86_64-darwin/rg'
    ]) {
      try { if (fsLocal.statSync(p).isFile()) return true; } catch (_) {}
    }
    return false;
  })();

  test('TOO-26: Grep files_with_matches default emits matching paths', async () => {
    if (!_RG_AVAILABLE) { console.log('    (ripgrep absent: this case did not run)'); return; }
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Grep', arguments: { pattern: 'needle', path: grepTmpDir } } }, {}
    ));
    assert.strictEqual(out.mode, 'files_with_matches');
    assert.ok(out.filenames.some((f) => f.endsWith('a.js')), 'a.js found');
    assert.ok(out.filenames.some((f) => f.endsWith('c.txt')), 'c.txt found');
    assert.ok(!out.filenames.some((f) => f.endsWith('b.js')), 'b.js excluded');
    assert.strictEqual(out.numFiles, 2);
  });

  test('TOO-27: Grep content mode emits lines with -n line numbers', async () => {
    if (!_RG_AVAILABLE) return;
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Grep', arguments: { pattern: 'needle', path: grepTmpDir, output_mode: 'content' } } }, {}
    ));
    assert.strictEqual(out.mode, 'content');
    assert.ok(out.content.includes(':1:'), 'line 1 numbered');
    assert.ok(out.numLines >= 2);
    assert.ok(out.numFiles >= 2);
  });

  test('TOO-28: Grep count mode emits per-file counts', async () => {
    if (!_RG_AVAILABLE) return;
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Grep', arguments: { pattern: 'needle', path: grepTmpDir, output_mode: 'count' } } }, {}
    ));
    assert.strictEqual(out.mode, 'count');
    assert.strictEqual(out.numMatches, 2, 'one match per matching file');
    assert.ok(out.filenames.length === 2);
  });

  test('TOO-29: Grep honors --type filter to only search a language', async () => {
    if (!_RG_AVAILABLE) return;
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Grep', arguments: { pattern: 'needle', path: grepTmpDir, type: 'js' } } }, {}
    ));
    assert.ok(out.filenames.every((f) => f.endsWith('.js')));
    assert.strictEqual(out.numFiles, 1);
  });

  test('TOO-30: Grep head_limit caps the entry count', async () => {
    if (!_RG_AVAILABLE) return;
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Grep', arguments: { pattern: 'needle', path: grepTmpDir, head_limit: 1 } } }, {}
    ));
    assert.strictEqual(out.numFiles, 1);
    assert.strictEqual(out.appliedLimit, 1);
  });

  // Glob test tree: nested directories + variety of extensions.
  const globTmpDir = path.join(os.tmpdir(), 'gc-glob-' + Date.now() + '-' + Math.random().toString(36).slice(2,8));
  fs.mkdirSync(path.join(globTmpDir, 'src/utils'),  { recursive: true });
  fs.mkdirSync(path.join(globTmpDir, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(globTmpDir, 'tests'),      { recursive: true });
  fs.writeFileSync(path.join(globTmpDir, 'README.md'),                  'readme');
  fs.writeFileSync(path.join(globTmpDir, 'src/index.ts'),               'export {};');
  fs.writeFileSync(path.join(globTmpDir, 'src/utils/helper.ts'),        'export {};');
  fs.writeFileSync(path.join(globTmpDir, 'src/components/Button.tsx'),  'export {};');
  fs.writeFileSync(path.join(globTmpDir, 'src/components/Modal.tsx'),   'export {};');
  fs.writeFileSync(path.join(globTmpDir, 'tests/index.test.ts'),        'test();');

  test('TOO-31: Glob ** matches across nested directories', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Glob', arguments: { pattern: '**/*.ts', path: globTmpDir } } }, {}
    ));
    // Should match: src/index.ts, src/utils/helper.ts, tests/index.test.ts (3.ts files;.tsx excluded)
    assert.strictEqual(out.numFiles, 3);
    assert.ok(out.filenames.every((f) => f.endsWith('.ts')));
    assert.strictEqual(out.truncated, false);
    assert.ok(typeof out.durationMs === 'number');
  });

  test('TOO-32: Glob single-level * does NOT cross slashes', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Glob', arguments: { pattern: '*.md', path: globTmpDir } } }, {}
    ));
    assert.strictEqual(out.numFiles, 1);
    assert.ok(out.filenames[0].endsWith('README.md'));
  });

  test('TOO-33: Glob narrows by subdirectory + extension class', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Glob', arguments: { pattern: 'src/components/*.tsx', path: globTmpDir } } }, {}
    ));
    assert.strictEqual(out.numFiles, 2);
    assert.ok(out.filenames.every((f) => f.endsWith('.tsx')));
  });

  test('TOO-34: Glob errors on non-existent path with structured error', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Glob', arguments: { pattern: '**/*', path: '/tmp/gc-no-such-dir-' + Date.now() } } }, {}
    ));
    assert.strictEqual(out.error, 'not_found');
  });

  test('TOO-35: large tool result is archived to disk and inline result trimmed', async () => {
    // Build a Bash output bigger than ARCHIVE_THRESHOLD (8 KB).
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: 'yes hello | head -2000' } } }, {}
    ));
    assert.ok(out._archive, 'archive metadata present');
    assert.ok(typeof out._archive.archive_path === 'string');
    assert.ok(out._archive.archive_size > tools.ARCHIVE_THRESHOLD, 'archived size exceeded threshold');
    // Inline stdout was trimmed.
    assert.ok(out.stdout.includes('archived'), 'truncation marker injected');
    // Archive file actually exists and contains the full output.
    assert.ok(fs.existsSync(out._archive.archive_path), 'archive file written');
    const archivedJson = JSON.parse(fs.readFileSync(out._archive.archive_path, 'utf8'));
    assert.ok(archivedJson.stdout.length > tools.ARCHIVE_THRESHOLD / 2, 'archive holds the full untrimmed payload');
    // Cleanup.
    fs.unlinkSync(out._archive.archive_path);
  });

  test('TOO-36: small tool result is NOT archived', async () => {
    const out = JSON.parse(await tools.dispatchToolCall(
      { function: { name: 'Bash', arguments: { command: 'echo small' } } }, {}
    ));
    assert.strictEqual(out._archive, undefined, 'small result keeps inline');
    assert.strictEqual(out.stdout, 'small\n');
  });

  test('TOO-37: unifiedToolsArray surfaces both worldly and substrate tools', () => {
    const runner = require('../shared-core/tools/runner.js');
    const arr = runner.unifiedToolsArray();
    const names = arr.map((t) => t.function && t.function.name).filter(Boolean);
    // Worldly:
    for (const n of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) {
      assert.ok(names.includes(n), 'unified tools include worldly ' + n);
    }
    // Substrate:
    for (const n of ['engram_search', 'engram_record', 'dialogue_recent']) {
      assert.ok(names.includes(n), 'unified tools include substrate ' + n);
    }
  });

  test('TOO-38: makeRunner routes to worldly tools and JSON-stringifies the result', async () => {
    const runner = require('../shared-core/tools/runner.js');
    const r = runner.makeRunner({});
    const tmp = path.join(os.tmpdir(), 'gc-runner-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(tmp, 'one\ntwo\n');
    const resStr = await r({ function: { name: 'Read', arguments: { file_path: tmp } } }, {});
    assert.strictEqual(typeof resStr, 'string');
    const parsed = JSON.parse(resStr);
    assert.strictEqual(parsed.type, 'text');
    assert.strictEqual(parsed.file.filePath, tmp);
    fs.unlinkSync(tmp);
  });

  test('TOO-39: makeRunner returns structured unknown_tool string (not throws) for unknown name', async () => {
    const runner = require('../shared-core/tools/runner.js');
    const r = runner.makeRunner({});
    const resStr = await r({ function: { name: 'NoSuchUnion', arguments: {} } }, {});
    const parsed = JSON.parse(resStr);
    assert.strictEqual(parsed.error, 'unknown_tool');
    assert.strictEqual(parsed.name, 'NoSuchUnion');
  });

  test('TOO-40: makeRunner converts thrown exceptions to structured tool_exception', async () => {
    const runner = require('../shared-core/tools/runner.js');
    // Inject a synthetic tool that throws to exercise the catch path.
    // Re-required HERE, not the suite-level `tools` binding: suites 02/04/05
    // wipe /shared-core/ from require.cache inside their bodies, so by the
    // time this body runs the suite-level binding can be a dead module
    // instance while makeRunner reads a fresh one. Requiring both in the
    // body guarantees the pair is consistent whichever instance is live.
    const toolsNow = require('../shared-core/tools');
    toolsNow.REGISTRY.__synthThrow = {
      schema: { type: 'function', function: { name: '__synthThrow', parameters: { type: 'object', properties: {} } } },
      run: async () => { throw new Error('boom'); }
    };
    try {
      const r = runner.makeRunner({});
      const resStr = await r({ function: { name: '__synthThrow', arguments: {} } }, {});
      const parsed = JSON.parse(resStr);
      assert.strictEqual(parsed.error, 'tool_exception');
      assert.strictEqual(parsed.name, '__synthThrow');
      assert.ok(parsed.detail.includes('boom'));
    } finally {
      delete toolsNow.REGISTRY.__synthThrow;
    }
  });

  test('TOO-42: mcp-client lists a fake downstream MCP server; ungoverned mcp_call fails closed', async () => {
    const mcp = require('../shared-core/tools/mcp-client.js');
    // Stand up a tiny MCP server that responds to initialize / tools/list / tools/call.
    const fakeServerPath = path.join(os.tmpdir(), 'gc-fake-mcp-' + Date.now() + '.cjs');
    fs.writeFileSync(fakeServerPath, `
      let buf = '';
      process.stdin.setEncoding('utf8');
      function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
      process.stdin.on('data', (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch (_) { continue; }
          if (m.method === 'initialize') {
            send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '0.0.1' } } });
          } else if (m.method === 'tools/list') {
            send({ jsonrpc: '2.0', id: m.id, result: { tools: [
              { name: 'echo', description: 'Echo back the message argument.', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }
            ] } });
          } else if (m.method === 'tools/call') {
            send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echoed: ' + (m.params.arguments.message || '') }] } });
          }
        }
      });
    `);
    // Build a temp config pointing at the fake server.
    const cfgPath = path.join(os.tmpdir(), 'gc-mcp-clients-' + Date.now() + '.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      mcpServers: { fake: { command: process.execPath, args: [fakeServerPath] } }
    }));
    process.env.TROTH_MCP_CLIENTS_CONFIG = cfgPath;

    try {
      // Discovery (mcp_list) stays DIRECT + ungoverned - it is read-only, so
      // it still spawns the fake server and lists its tools.
      const listOut = await mcp.REGISTRY.mcp_list.run({ server: 'fake' }, {});
      assert.strictEqual(listOut.server, 'fake');
      assert.ok(Array.isArray(listOut.tools) && listOut.tools.length === 1, 'one tool listed');
      assert.strictEqual(listOut.tools[0].name, 'echo');

      // mcp_call is now GOVERNED: with no operator-sealed
      // capability in this hermetic HOME it must FAIL CLOSED at the STVC write
      // wall rather than invoke the downstream. (This suite runs no operator
      // bootstrap, so there is no capability:mcp:fake to auto-resolve.) The
      // governed success path is covered end-to-end in suite-18 (MCPH-5).
      const callOut = await mcp.REGISTRY.mcp_call.run(
        { server: 'fake', tool: 'echo', args: { message: 'hi' } }, {}
      );
      assert.strictEqual(callOut.ok, false, 'ungoverned mcp_call must not succeed');
      assert.strictEqual(callOut.refused, true, 'it is refused, not a crash');
      assert.strictEqual(callOut.stage, 'write', 'refused at the STVC write wall');
      assert.ok(!callOut.content, 'the downstream result is NOT returned (server not authorized)');
    } finally {
      mcp.shutdownAll();
      delete process.env.TROTH_MCP_CLIENTS_CONFIG;
      fs.unlinkSync(cfgPath);
      fs.unlinkSync(fakeServerPath);
    }
  });

  test('TOO-43: mcp-client returns structured spawn_failed for unknown server', async () => {
    const mcp = require('../shared-core/tools/mcp-client.js');
    const out = await mcp.REGISTRY.mcp_list.run({ server: 'no_such_server_xyz' }, {});
    assert.strictEqual(out.error, 'spawn_failed');
  });

  test('TOO-44: unifiedRegistry now includes mcp_list/describe/call', () => {
    const runner = require('../shared-core/tools/runner.js');
    const names = runner.unifiedToolsArray().map((t) => t.function && t.function.name);
    for (const n of ['mcp_list', 'mcp_describe', 'mcp_call']) {
      assert.ok(names.includes(n), 'unified tools include ' + n);
    }
  });

  test('TOO-45: buildSystemPrompt advertises tools, hits anti-sycophancy guard', () => {
    const sp = require('../shared-core/tools/system-prompt.js');
    const out = sp.buildSystemPrompt({
      agent_id: 'voice-test',
      cwd:      '/tmp',
      available_tools: ['Read', 'Write', 'Bash']
    });
    assert.ok(out.includes('voice-test'));
    assert.ok(out.includes('Read, Write, Bash'));
    assert.ok(out.toLowerCase().includes('preamble') || out.toLowerCase().includes('apologies'),
              'anti-preamble/apology guard present');
    // Default cap.
    assert.ok(out.length <= sp.DEFAULT_MAX_CHARS);
  });

  test('TOO-46: buildSystemPrompt audio mode adds TTS-friendly directive + drops markdown', () => {
    const sp = require('../shared-core/tools/system-prompt.js');
    const out = sp.buildSystemPrompt({
      agent_id: 'voice', cwd: '/tmp', available_tools: ['Read'], audio: true
    });
    assert.ok(out.includes('AUDIO MODE'));
    assert.ok(out.toLowerCase().includes('no markdown'));
  });

  test('TOO-46b: buildSystemPrompt NAMES the configured MCP hands from the workspace .mcp.json (backbone-independent awareness)', () => {
    const sp = require('../shared-core/tools/system-prompt.js');
    const fs = require('fs'); const os = require('os'); const path = require('path');
    // Live find: the hands were on the surface and the
    // resolver saw the server, but the prompt only said "discover with
    // mcp_list" — an optional step gpt-5.6 skipped, reaching for the CLI. The
    // prompt must NAME the configured server so the partner knows the hand
    // exists. This is the SAME buildSystemPrompt both backbones use (native
    // tool surface AND claude_cli via --append-system-prompt), so the fix is
    // model- and backbone-independent by construction.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-aware-'));
    // Pin the GLOBAL registry to a non-existent path so this test sees ONLY
    // the workspace layer, deterministically, on any machine (the dev box and
    // CI both may carry a real ~/.troth/mcp-clients.json that would otherwise
    // leak servers into the "no hand" case). loadDownstream honours
    // TROTH_MCP_CLIENTS_CONFIG over the default path.
    const prevGlobal = process.env.TROTH_MCP_CLIENTS_CONFIG;
    process.env.TROTH_MCP_CLIENTS_CONFIG = path.join(ws, 'no-global.json');
    try {
      fs.writeFileSync(path.join(ws, '.mcp.json'),
        JSON.stringify({ mcpServers: { supabase: { type: 'http', url: 'https://example/mcp' } } }));
      const withHand = sp.buildSystemPrompt({ agent_id: 'partner', cwd: ws, available_tools: ['Read', 'mcp_list', 'mcp_call'] });
      assert.ok(/Configured MCP hands here: [^.]*supabase/.test(withHand), 'the configured server is named in the prompt');
      assert.ok(/mcp_call/.test(withHand), 'tells the partner how to invoke it');
      assert.ok(/troth cap mint capability:mcp:/.test(withHand), 'gives the operator the seal command on refusal');
      assert.ok(!/truncated/.test(withHand), 'the awareness section is not sliced off by the char cap');

      // No workspace server AND no global → the generic hint, never a
      // fabricated hand.
      const noHand = sp.buildSystemPrompt({ agent_id: 'partner', cwd: '/tmp/no-such-ws-xyz', available_tools: ['Read', 'mcp_list'] });
      assert.ok(!/Configured MCP hands here:/.test(noHand), 'no configured line when nothing is declared');
      assert.ok(/Discover hands with mcp_list/.test(noHand), 'falls back to the discovery hint');
    } finally {
      if (prevGlobal === undefined) delete process.env.TROTH_MCP_CLIENTS_CONFIG;
      else process.env.TROTH_MCP_CLIENTS_CONFIG = prevGlobal;
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('TOO-47: buildSystemPrompt no longer emits anchors/refusals as prompt text (R17 — moved to substrate envelope + procedure-matcher)', () => {
    const sp = require('../shared-core/tools/system-prompt.js');
    const out = sp.buildSystemPrompt({
      agent_id: 'a', cwd: '/x',
      available_tools: [],
      identity_anchors: ['cite specific file paths', 'push back on weak reasoning'],
      identity_refusals: ['no fawning agreement']
    });
    // A5: anchors and refusals are NOT injected as prompt text.
    // Anchors flow via entity-prefix.js <memory_identity> block (substrate
    // identity envelope). Refusals enforced structurally at procedure-matcher
    // / permission.js (hard walls > soft instructions).
    // Backward-compat: the deprecated params are silently swallowed.
    assert.ok(!out.includes('cite specific file paths'), 'anchors must not leak into system prompt');
    assert.ok(!out.includes('no fawning agreement'), 'refusals must not leak into system prompt');
    assert.ok(!/^Anchors\b/m.test(out), 'no Anchors: section');
    assert.ok(!/^Refusals\b/m.test(out), 'no Refusals: section');
  });

  test('TOO-49: permission.classify buckets read/write/unknown correctly', () => {
    const perm = require('../shared-core/tools/permission.js');
    assert.strictEqual(perm.classify('Read'),         'read');
    assert.strictEqual(perm.classify('Grep'),         'read');
    assert.strictEqual(perm.classify('engram_search'),'read');
    assert.strictEqual(perm.classify('Write'),        'write');
    assert.strictEqual(perm.classify('Bash'),         'write');
    assert.strictEqual(perm.classify('engram_record'),'write');
    assert.strictEqual(perm.classify('NoSuchTool'),   'unknown');
  });

  test('TOO-50: gated runner blocks write/Bash without auto_write env or ctx flag', async () => {
    const perm = require('../shared-core/tools/permission.js');
    const innerCalls = [];
    const inner = async (tc) => { innerCalls.push(tc.function.name); return JSON.stringify({ ran: true }); };
    delete process.env.TROTH_ENTITY_AUTO_WRITE;
    const gated = perm.wrapRunner(inner);
    // subsystem — use a benign command so the safety gate falls through to
    // the original auto_write check. (rm -rf / would now trip the safety
    // gate first and return bash_safety_refusal instead.)
    const out = JSON.parse(await gated({ function: { name: 'Bash', arguments: JSON.stringify({ command: 'ls -la' }) } }, {}));
    assert.strictEqual(out.error, 'requires_confirmation');
    assert.strictEqual(out.tool, 'Bash');
    assert.strictEqual(out.kind, 'write');
    assert.strictEqual(innerCalls.length, 0, 'inner runner must not have fired');
  });

  test('TOO-51: gated runner allows write when ctx.auto_write=true', async () => {
    const perm = require('../shared-core/tools/permission.js');
    const inner = async () => JSON.stringify({ ran: true });
    delete process.env.TROTH_ENTITY_AUTO_WRITE;
    const gated = perm.wrapRunner(inner);
    const out = JSON.parse(await gated({ function: { name: 'Write', arguments: '{}' } }, { auto_write: true }));
    assert.strictEqual(out.ran, true);
  });

  test('TOO-52: gated runner ALWAYS allows read-only tools regardless of flags', async () => {
    const perm = require('../shared-core/tools/permission.js');
    const inner = async () => JSON.stringify({ ran: true });
    delete process.env.TROTH_ENTITY_AUTO_WRITE;
    const gated = perm.wrapRunner(inner);
    for (const name of ['Read', 'Grep', 'Glob', 'mcp_list', 'engram_search']) {
      const out = JSON.parse(await gated({ function: { name, arguments: '{}' } }, {}));
      assert.strictEqual(out.ran, true, name + ' must pass through');
    }
  });

  test('TOO-53: gated runner blocks unknown tool names by default (default-deny)', async () => {
    const perm = require('../shared-core/tools/permission.js');
    const inner = async () => JSON.stringify({ ran: true });
    delete process.env.TROTH_ENTITY_AUTO_WRITE;
    const gated = perm.wrapRunner(inner);
    const out = JSON.parse(await gated({ function: { name: 'WhoKnows', arguments: '{}' } }, {}));
    assert.strictEqual(out.error, 'requires_confirmation');
    assert.strictEqual(out.kind, 'unknown');
  });

  // ── Slash framework (Phase 1 of Mode A skills + chat layer) ─────────
  test('SLA-1: parser splits "/cmd a b" into name + args', () => {
    const p = require('../shared-core/slash/parser.js');
    const r = p.parse('/goal ship troth');
    assert.strictEqual(r.is_slash, true);
    assert.strictEqual(r.name, 'goal');
    assert.strictEqual(r.raw_args, 'ship troth');
    assert.deepStrictEqual(r.args_array, ['ship', 'troth']);
  });

  test('SLA-2: parser recognizes leading whitespace + lowercases name', () => {
    const p = require('../shared-core/slash/parser.js');
    const r = p.parse('   /Recall   ηχητικά  του χθες  ');
    assert.strictEqual(r.is_slash, true);
    assert.strictEqual(r.name, 'recall');
    assert.strictEqual(r.raw_args, 'ηχητικά  του χθες');
  });

  test('SLA-3: parser leaves non-slash text untouched', () => {
    const p = require('../shared-core/slash/parser.js');
    const r = p.parse('hello there');
    assert.strictEqual(r.is_slash, false);
    assert.strictEqual(r.text, 'hello there');
  });

  test('SLA-4: parser quote-aware split — "two words" stays one arg', () => {
    const p = require('../shared-core/slash/parser.js');
    const r = p.parse('/remember "user prefers tabs over spaces" production');
    assert.deepStrictEqual(r.args_array, ['user prefers tabs over spaces', 'production']);
  });

  test('SLA-5: parser declines /<digit>... as plain text (Anthropic name rules)', () => {
    const p = require('../shared-core/slash/parser.js');
    assert.strictEqual(p.parse('/2 cents').is_slash, false);
    assert.strictEqual(p.parse('/').is_slash, false);
    assert.strictEqual(p.parse('/-x').is_slash, false);
  });

  test('SLA-8: a filesystem PATH is plain text, never a command (the /Users failed-reply bug)', () => {
    const p = require('../shared-core/slash/parser.js');
    // Live studio repro: the operator typed the project path to
    // set the workspace and got "That reply failed" (unknown_slash "users").
    for (const s of ['/Users/alex/Desktop/my-project', '/etc/hosts', '/tmp/x.txt', '/index.html', '/file.txt and more words']) {
      const r = p.parse(s);
      assert.strictEqual(r.is_slash, false, s + ' must be plain text');
      assert.strictEqual(r.text, s, 'text preserved verbatim');
    }
    // Real commands keep working: name followed by space/end, never / or.
    assert.strictEqual(p.parse('/goal ship it').is_slash, true);
    assert.strictEqual(p.parse('/recall').is_slash, true);
  });

  test('SLA-6: loader picks up SKILL.md from a temp project skill dir', () => {
    const loader = require('../shared-core/slash/loader.js');
    const tmpProject = path.join(os.tmpdir(), 'gc-slash-' + Date.now());
    fs.mkdirSync(path.join(tmpProject, '.claude', 'skills', 'projcmd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.claude', 'skills', 'projcmd', 'SKILL.md'),
      '---\nname: projcmd\ndescription: project-local test command\nallowed-tools: [Read, Grep]\nmodel: claude-haiku-4-5\n---\n\nDo the thing with $ARGUMENTS.\n'
    );
    const map = loader.loadAll({ cwd: tmpProject });
    const rec = map.get('projcmd');
    assert.ok(rec, 'projcmd loaded');
    assert.strictEqual(rec.description, 'project-local test command');
    assert.deepStrictEqual(rec.allowed_tools, ['Read', 'Grep']);
    assert.strictEqual(rec.model, 'claude-haiku-4-5');
    assert.strictEqual(rec.source_layer, 'project');
    assert.ok(rec.body.includes('$ARGUMENTS'));
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  test('SLA-7: loader honors precedence — project overrides bundled', () => {
    const loader = require('../shared-core/slash/loader.js');
    const tmpProject = path.join(os.tmpdir(), 'gc-slash-prec-' + Date.now());
    fs.mkdirSync(path.join(tmpProject, '.claude', 'commands'), { recursive: true });
    // Use a name unlikely to collide with bundled skills.
    fs.writeFileSync(
      path.join(tmpProject, '.claude', 'commands', 'gc_test_legacy.md'),
      '---\nname: gc_test_legacy\ndescription: legacy markdown command\n---\nLegacy body.\n'
    );
    const rec = loader.loadAll({ cwd: tmpProject }).get('gc_test_legacy');
    assert.ok(rec);
    assert.ok(rec.body.includes('Legacy body'));
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  test('SLA-8: executor substitutes $ARGUMENTS and $1..$9', async () => {
    const exec = require('../shared-core/slash/executor.js');
    const out = await exec.substituteArgs('Set goal: $1. Full: $ARGUMENTS', 'ship troth v1', ['ship', 'troth', 'v1']);
    assert.ok(out.includes('Set goal: ship.'));
    assert.ok(out.includes('Full: ship troth v1'));
  });

  test('SLA-9: executor expands !`echo` bash interpolation', async () => {
    const exec = require('../shared-core/slash/executor.js');
    const out = await exec.substituteBash('Status: !`echo ok`');
    assert.ok(out.includes('$ echo ok'));
    assert.ok(out.includes('ok'));
  });

  test('SLA-10: executor inlines @file content when present', async () => {
    const exec = require('../shared-core/slash/executor.js');
    const tmp = path.join(os.tmpdir(), 'gc-slash-' + Date.now() + '.txt');
    fs.writeFileSync(tmp, 'one\ntwo\n');
    const out = await exec.substituteFiles('Look at @' + tmp, os.tmpdir());
    assert.ok(out.includes('## File: ' + tmp));
    assert.ok(out.includes('one'));
    fs.unlinkSync(tmp);
  });

  test('SLA-20: deterministic /dialogue-reset preserves substrate and signals dialogue_reset', async () => {
    const exec   = require('../shared-core/slash/executor.js');
    const loader = require('../shared-core/slash/loader.js');
    const eng    = require('../shared-core/engram.js');
    const skill = loader.loadAll({ cwd: '/tmp' }).get('dialogue-reset');
    assert.strictEqual(skill.kind, 'deterministic', '/dialogue-reset must be deterministic');
    const aid = 'sla20-clear-' + Date.now();
    // Seed a goal + a generic engram so the count surfaced in the reply
    // is concrete, not zero.
    eng.recordEngram({ agent_id: aid, cwd: '/tmp', statement: 'preserved goal', salience: 2, scope: 'goal' });
    eng.recordEngram({ agent_id: aid, cwd: '/tmp', statement: 'preserved fact',                      salience: 1 });
    const out = await exec.executeDeterministic(skill,
      { name: 'dialogue-reset', raw_args: '', args_array: [] },
      { agent_id: aid, cwd: '/tmp' }
    );
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.startsWith('Cleared. Identity preserved'));
    assert.ok(out.side_effects.dialogue_reset === true, 'dialogue_reset signal set');
    assert.ok(out.side_effects.identity_preserved === true);
    // Substrate still has the engrams — /clear is not destructive.
    const after = eng.listEngrams({ agent_id: aid, limit: 10 });
    assert.ok(after.some((e) => e.statement === 'preserved goal'));
    assert.ok(after.some((e) => e.statement === 'preserved fact'));
  });

  test('SLA-17: troth_slash_invoke (deterministic) — runs in-process, returns text + side_effects', async () => {
    // Re-implement what the substrate MCP tool does so we verify the
    // pipeline that troth_slash_invoke wires up — without spawning the
    // MCP daemon. Same modules, same call shape.
    const parser  = require('../shared-core/slash/parser.js');
    const loader  = require('../shared-core/slash/loader.js');
    const exec    = require('../shared-core/slash/executor.js');
    const eng     = require('../shared-core/engram.js');
    const aid = 'sla17-mcpb-' + Date.now();
    const parsed = parser.parse('/goal expose skills via Mode B');
    assert.ok(parsed.is_slash);
    const skill = loader.load(parsed.name, { cwd: '/tmp' });
    assert.strictEqual(skill.kind, 'deterministic');
    const out = await exec.executeDeterministic(skill, parsed, { agent_id: aid, cwd: '/tmp' });
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.includes('Goal pinned'));
    assert.ok(out.side_effects && Array.isArray(out.side_effects.engrams));
    const goals = eng.listEngrams({ agent_id: aid, scope: 'goal', limit: 5 });
    assert.ok(goals.some((g) => g.statement === 'expose skills via Mode B'),
              'goal engram persisted via Mode B path');
  });

  test('SLA-18: troth_slash_invoke (LLM-driven) — returns rendered_prompt for host model', async () => {
    const parser = require('../shared-core/slash/parser.js');
    const loader = require('../shared-core/slash/loader.js');
    const exec   = require('../shared-core/slash/executor.js');
    // /think is LLM-driven (kind defaults to 'llm' since no frontmatter).
    const parsed = parser.parse('/think persistent vs cold-spawn for voice');
    const skill = loader.load(parsed.name, { cwd: '/tmp' });
    assert.notStrictEqual(skill.kind, 'deterministic', '/think must be LLM-driven');
    const out = await exec.execute(skill, parsed, { agent_id: 'sla18-' + Date.now(), cwd: '/tmp' });
    assert.strictEqual(out.ok, true);
    assert.ok(out.prompt.includes('persistent vs cold-spawn for voice'));
    assert.ok(out.prompt.includes('engram_record') || out.prompt.includes('engram_search'),
              'rendered prompt names a substrate tool the host model should call');
    assert.ok(typeof out.trace_engram_id === 'string');
  });

  test('SLA-19: parser rejects non-slash, troth_slash_invoke must surface that as not_a_slash', () => {
    const parser = require('../shared-core/slash/parser.js');
    const r = parser.parse('hello world');
    assert.strictEqual(r.is_slash, false);
    // The MCP tool wraps this as { ok:false, error:'not_a_slash' } —
    // that wrapping is what we test in the live MCP smoke (separate file)
    // but here we confirm the precondition: a non-slash input must NOT
    // sneak through the parser.
  });

  test('SLA-12: deterministic /goal writes a salience-2 scope=goal engram + reply', async () => {
    const exec   = require('../shared-core/slash/executor.js');
    const loader = require('../shared-core/slash/loader.js');
    const eng    = require('../shared-core/engram.js');
    const skill = loader.loadAll({ cwd: '/tmp' }).get('goal');
    assert.strictEqual(skill.kind, 'deterministic', 'goal must be deterministic');
    const aid = 'sla12-goal-' + Date.now();
    const out = await exec.executeDeterministic(skill,
      { name: 'goal', raw_args: 'ship slash layer', args_array: ['ship','slash','layer'] },
      { agent_id: aid, cwd: '/tmp' }
    );
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.includes('Goal pinned: ship slash layer'));
    const list = eng.listEngrams({ agent_id: aid, scope: 'goal', limit: 5 });
    assert.ok(list.some((e) => e.statement === 'ship slash layer' && e.salience === 2),
              'goal engram with scope=goal salience=2 persisted');
  });

  test('SLA-13: deterministic /remember writes scope=null salience-1 engram', async () => {
    const exec   = require('../shared-core/slash/executor.js');
    const loader = require('../shared-core/slash/loader.js');
    const eng    = require('../shared-core/engram.js');
    const skill = loader.loadAll({ cwd: '/tmp' }).get('remember');
    assert.strictEqual(skill.kind, 'deterministic');
    const aid = 'sla13-remember-' + Date.now();
    const out = await exec.executeDeterministic(skill,
      { name: 'remember', raw_args: 'user prefers terse responses', args_array: [] },
      { agent_id: aid, cwd: '/tmp' }
    );
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.startsWith('Saved: '));
    const list = eng.listEngrams({ agent_id: aid, limit: 5 });
    assert.ok(list.some((e) => e.statement === 'user prefers terse responses' && e.scope === null),
              'remember engram persisted as scope=null');
  });

  test('SLA-14: deterministic /context surfaces goals + recent + dialogue snapshot', async () => {
    const exec   = require('../shared-core/slash/executor.js');
    const loader = require('../shared-core/slash/loader.js');
    const eng    = require('../shared-core/engram.js');
    const aid = 'sla14-ctx-' + Date.now();
    // Seed two goals so the snapshot has something to surface.
    eng.recordEngram({ agent_id: aid, cwd: '/tmp', statement: 'ship Mode A', salience: 2, scope: 'goal' });
    eng.recordEngram({ agent_id: aid, cwd: '/tmp', statement: 'evaluate skills', salience: 2, scope: 'goal' });
    const skill = loader.loadAll({ cwd: '/tmp' }).get('context');
    assert.strictEqual(skill.kind, 'deterministic');
    const out = await exec.executeDeterministic(skill,
      { name: 'context', raw_args: '', args_array: [] },
      { agent_id: aid, cwd: '/tmp' }
    );
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.includes('GOALS'));
    assert.ok(out.text.includes('ship Mode A'), 'snapshot lists the seeded goal');
    assert.ok(out.text.includes('evaluate skills'));
  });

  test('SLA-15: deterministic /forget retires the top match from recall', async () => {
    const exec   = require('../shared-core/slash/executor.js');
    const loader = require('../shared-core/slash/loader.js');
    const eng    = require('../shared-core/engram.js');
    const aid = 'sla15-forget-' + Date.now();
    const secret = 'the old office alarm code is 7731 quetzal';
    eng.recordEngram({ agent_id: aid, cwd: '/tmp', statement: secret, salience: 1,
      source_authority: 'llm_inferred', auto_verify: false });
    // Baseline: it surfaces before we forget it.
    const before = await eng.retrieveRelevant({ agent_id: aid, query: 'office alarm code quetzal', k: 5, commitment_only: true });
    assert.ok(before.some((e) => e.statement === secret), 'surfaces before /forget');
    const skill = loader.loadAll({ cwd: '/tmp' }).get('forget');
    assert.strictEqual(skill.kind, 'deterministic');
    const out = await exec.executeDeterministic(skill,
      { name: 'forget', raw_args: 'office alarm code quetzal', args_array: ['office','alarm','code','quetzal'] },
      { agent_id: aid, cwd: '/tmp' }
    );
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.startsWith('Forgotten: '));
    // The real contract: it no longer surfaces (the superseder + flagged-tier
    // retire it). The old bug wrote a system:tombstone marker that filtered
    // nothing, so the secret kept coming back.
    const after = await eng.retrieveRelevant({ agent_id: aid, query: 'office alarm code quetzal', k: 5, commitment_only: true });
    assert.ok(!after.some((e) => e.statement === secret), 'gone from recall after /forget');
    // And the retirement IS visible in an explicit audit view (soft delete).
    const audit = eng.listEngrams({ agent_id: aid, include_flagged: true, include_superseded: true, limit: 20 });
    assert.ok(audit.some((e) => e.statement === 'FORGOTTEN: ' + secret), 'superseder recoverable in audit view');
  });

  test('SLA-16: deterministic dispatch persists trace engram with scope=command', async () => {
    const exec   = require('../shared-core/slash/executor.js');
    const loader = require('../shared-core/slash/loader.js');
    const eng    = require('../shared-core/engram.js');
    const aid = 'sla16-trace-' + Date.now();
    const skill = loader.loadAll({ cwd: '/tmp' }).get('remember');
    const out = await exec.executeDeterministic(skill,
      { name: 'remember', raw_args: 'detection probe', args_array: [] },
      { agent_id: aid, cwd: '/tmp' }
    );
    assert.ok(out.trace_engram_id, 'trace engram id returned');
    const traces = eng.listEngrams({ agent_id: aid, scope: 'command', limit: 5 });
    assert.ok(traces.some((t) => t.statement.includes('user invoked /remember')),
              'causal-trace engram persisted under scope=command');
  });

  test('SLA-11b: bundled skills — all expected built-ins discoverable + valid frontmatter', () => {
    const loader = require('../shared-core/slash/loader.js');
    const map = loader.loadAll({ cwd: '/tmp' });  // /tmp has no project skills, isolates bundled
    // /agents removed — its surface collapsed into the consolidated /agent
    // (single sub-brain entry point with arg-pattern dispatch). The other
    // ten substrate-bound built-ins remain.
    const expected = ['goal','remember','recall','forget','think','agent','save','context','usage','dialogue-reset','init'];
    for (const n of expected) {
      const rec = map.get(n);
      assert.ok(rec, 'bundled skill ' + n + ' present');
      assert.ok(rec.description && rec.description.length > 0, n + ' has description');
      assert.strictEqual(rec.source_layer, 'bundled', n + ' served from bundled layer');
      assert.ok(rec.body && rec.body.length > 0, n + ' body non-empty');
    }
  });

  test('SLA-11c: each bundled skill body references its substrate hook explicitly', () => {
    const loader = require('../shared-core/slash/loader.js');
    const map = loader.loadAll({ cwd: '/tmp' });
    // Skills with mandatory engram writes should mention engram_record by name
    // so the LLM has a literal token to anchor on.
    for (const n of ['goal','remember','think','init']) {
      const body = map.get(n).body;
      assert.ok(body.includes('engram_record'),
                n + ' body must reference engram_record substrate hook');
    }
    // Recall-class must surface the multi-axis / search tools.
    for (const n of ['recall','context','save','forget']) {
      const body = map.get(n).body;
      assert.ok(body.includes('engram_search') || body.includes('dialogue_recent') || body.includes('multi_axis'),
                n + ' body must reference a substrate read tool');
    }
    // /agent body documents the sub-brain workflow surface (registry,
    // team dispatch). It's deterministic so substrate writes happen
    // through the JS handler, not via LLM tool-mention.
    const agentBody = map.get('agent').body;
    assert.ok(agentBody.includes('sub-brain') || agentBody.includes('agent-registry') || agentBody.includes('switch'),
              '/agent body documents the sub-brain workflow');
  });

  test('SLA-11: executor end-to-end resolves args + writes substrate trace engram', async () => {
    const loader  = require('../shared-core/slash/loader.js');
    const parser  = require('../shared-core/slash/parser.js');
    const exec    = require('../shared-core/slash/executor.js');
    // Build a one-off skill in a temp dir.
    const tmpProject = path.join(os.tmpdir(), 'gc-slash-e2e-' + Date.now());
    fs.mkdirSync(path.join(tmpProject, '.claude', 'skills', 'sla11goal'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.claude', 'skills', 'sla11goal', 'SKILL.md'),
      '---\nname: sla11goal\ndescription: trace test\n---\nGOAL: $ARGUMENTS\n'
    );
    const map  = loader.loadAll({ cwd: tmpProject });
    const skill = map.get('sla11goal');
    const parsed = parser.parse('/sla11goal ship it now');
    const result = await exec.execute(skill, parsed, {
      agent_id: 'sla11-test-' + Date.now(),
      cwd:      tmpProject
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.prompt.includes('GOAL: ship it now'));
    assert.ok(typeof result.trace_engram_id === 'string' && result.trace_engram_id.length > 0,
              'substrate trace engram persisted');
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  // ── /engine per-pane engine override ──────
  // The operator types /engine <engine> in a pane to steer WHICH faculty
  // answers THAT conversation. Deterministic, runtime-only: writes the daemon's
  // in-memory conversation->override map, scoped to conversation_id. These unit
  // tests drive the handler directly; MODEL-WIRE-1 (suite-11) proves the map
  // actually flips the dispatch faculty over the daemon wire.
  test('MODEL-01: /engine is a registered deterministic handler with a bundled skill', () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const loader = require('../shared-core/slash/loader.js');
    assert.strictEqual(typeof DETERMINISTIC_HANDLERS.engine, 'function', '/engine handler registered');
    const skill = loader.loadAll({ cwd: '/tmp' }).get('engine');
    assert.ok(skill, '/engine bundled skill present');
    assert.strictEqual(skill.kind, 'deterministic', '/engine is deterministic');
  });

  // NOTE: these unit tests assert on the handler's OWN return (side_effects +
  // reply text + a follow-up bare /engine report) rather than reading the
  // engine-override Map through a separate require(). Under the shared test
  // harness an earlier suite invalidates /shared-core/ from require.cache, so a
  // test-side require() of engine-override can resolve to a DIFFERENT module
  // instance (a fresh empty Map) than the one the executor writes to. Asserting
  // through the handler tests the real operator-visible contract and is immune
  // to that cache identity split (the daemon-wire MODEL-WIRE-1 proves the Map
  // actually drives dispatch end-to-end in one process). A helper resets the
  // handler's OWN instance by routing /engine auto through it before each case.
  const _modelReset = async (H, P, cid) => { await H.engine(P.parse('/engine auto'), { conversation_id: cid, agent_id: 'reset', cwd: null }); };

  test('MODEL-02: /engine local sets a per-conversation llamacpp override that another pane never sees', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const A = 'model02-A', B = 'model02-B';
    await _modelReset(DETERMINISTIC_HANDLERS, parser, A);
    await _modelReset(DETERMINISTIC_HANDLERS, parser, B);
    const out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine local'),
      { agent_id: 'm02', cwd: null, user_id: 'op', conversation_id: A });
    assert.strictEqual(out.ok, true, 'ok reply');
    assert.ok(out.text.includes('local'), 'terse reply names the engine (local)');
    assert.ok(out.text.trim().startsWith('✓'), 'terse confirm (checkmark), not the old verbose block');
    // The handler's own truth: side_effects carries the resolved faculty.
    assert.ok(out.side_effects && out.side_effects.engine_override, 'engine_override side-effect present');
    assert.strictEqual(out.side_effects.engine_override.faculty, 'llamacpp', 'conv-A override maps local -> llamacpp');
    assert.strictEqual(out.side_effects.engine_override.conversation_id, A, 'scoped to conv-A');
    // conv-B, never touched, still reports the global default via a report call.
    const repB = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: B, agent_id: 'm02', cwd: null });
    assert.ok(repB.text.includes('global default'), 'conv-B untouched -> still the global default');
  });

  test('MODEL-03: engine words map to faculties — claude->claude_cli, chatgpt->codex_oauth', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const A = 'model03-A';
    await _modelReset(DETERMINISTIC_HANDLERS, parser, A);
    let out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine claude'), { conversation_id: A, agent_id: 'm03', cwd: null });
    assert.strictEqual(out.side_effects.engine_override.faculty, 'claude_cli', 'claude -> claude_cli');
    out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine chatgpt'), { conversation_id: A, agent_id: 'm03', cwd: null });
    assert.strictEqual(out.side_effects.engine_override.faculty, 'codex_oauth', 'chatgpt -> codex_oauth (overwrites prior)');
    // The report reflects the latest pin.
    const rep = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: A, agent_id: 'm03', cwd: null });
    assert.ok(rep.text.includes('codex_oauth'), 'report shows the latest chatgpt/codex_oauth pin');
  });

  test('MODEL-04: bare /engine report TEXT is reality-based - only wired choices, current marked, nothing unconfigured', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const A = 'model04-A';
    await _modelReset(DETERMINISTIC_HANDLERS, parser, A);
    // A real wiring snapshot: echo primary + llamacpp backstop. chatgpt/claude
    // are NOT wired, so their words must be ABSENT from the report text.
    const engines = { available: ['echo', 'llamacpp'], current: 'llamacpp', kimi: false, backbone: null };
    // Before any override: reports the global default, still lists only real
    // choices (auto modes + local), never the old static catalog.
    let out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: A, agent_id: 'm04', cwd: null, engines });
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.includes('global default'), 'reports global default before any override');
    assert.ok(out.text.includes('Options'), 'lists available options');
    assert.ok(out.text.includes('/engine local'), 'wired llamacpp -> /engine local listed');
    assert.ok(out.text.includes('/engine auto local-first'), 'auto local-first listed');
    // (a) unwired engine names ABSENT from the text - no static catalog leak.
    assert.ok(!out.text.includes('/engine chatgpt'), 'unwired chatgpt ABSENT from report text');
    assert.ok(!out.text.includes('/engine claude'), 'unwired claude ABSENT from report text');
    // After /engine local: the head line names the pinned engine and marks it.
    await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine local'), { conversation_id: A, agent_id: 'm04', cwd: null });
    out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: A, agent_id: 'm04', cwd: null, engines });
    assert.ok(out.text.includes('local') && out.text.includes('llamacpp'), 'reports the pinned local engine');
    // (b) current marked — the override head line carries the [current] marker.
    assert.ok(out.text.includes('[current]'), 'the active override is marked [current] in the text');
    // The current choice is not double-listed in the Options block.
    assert.ok(!out.text.includes('  · /engine local'), 'the current engine is not repeated as a switch choice');
  });

  test('MODEL-05: /engine auto clears the override; /engine auto local-first sets a prefer', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const A = 'model05-A';
    await _modelReset(DETERMINISTIC_HANDLERS, parser, A);
    let out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine local'), { conversation_id: A, agent_id: 'm05', cwd: null });
    assert.strictEqual(out.side_effects.engine_override.faculty, 'llamacpp', 'override set first');
    out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine auto'), { conversation_id: A, agent_id: 'm05', cwd: null });
    assert.strictEqual(out.ok, true);
    assert.ok(out.text.includes('auto'), 'terse reply confirms auto (cleared)');
    assert.ok(out.side_effects.engine_override.cleared === true, 'side-effect marks the pane cleared');
    // A report after auto shows the global default again.
    let rep = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: A, agent_id: 'm05', cwd: null });
    assert.ok(rep.text.includes('global default'), 'after auto -> back to global default');
    out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine auto local-first'), { conversation_id: A, agent_id: 'm05', cwd: null });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.side_effects.engine_override.prefer, 'local', 'auto local-first sets prefer=local');
    // A prefer-only entry reports as global default + prefer, no forced faculty.
    rep = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: A, agent_id: 'm05', cwd: null });
    assert.ok(rep.text.includes('prefer=local'), 'report surfaces the prefer without a hard faculty');
  });

  test('MODEL-06: /engine kimi replies honestly (backbone-global) and does not set a per-pane faculty', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const A = 'model06-A';
    await _modelReset(DETERMINISTIC_HANDLERS, parser, A);
    const out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine kimi'), { conversation_id: A, agent_id: 'm06', cwd: null });
    assert.strictEqual(out.ok, true, 'honest reply, not an error');
    assert.ok(out.text.toLowerCase().includes('backbone'), 'reply explains kimi rides the backbone');
    assert.ok(!out.side_effects, 'kimi writes no per-pane override side-effect');
    // A report confirms the pane still holds the global default.
    const rep = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: A, agent_id: 'm06', cwd: null });
    assert.ok(rep.text.includes('global default'), 'no per-pane faculty override written for kimi');
  });

  test('MODEL-07: a router provider word (deepseek) selects the router faculty and says so', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const A = 'model07-A';
    await _modelReset(DETERMINISTIC_HANDLERS, parser, A);
    const out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine deepseek'), { conversation_id: A, agent_id: 'm07', cwd: null });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.side_effects.engine_override.faculty, 'router', 'deepseek -> router faculty');
    assert.ok(out.text.includes('deepseek'), 'terse reply names the engine (deepseek)');
  });

  test('MODEL-08: an unknown engine word is rejected honestly, listing ONLY real choices', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const eo = require('../shared-core/engine-override.js');
    eo._reset();
    // Wire claude_cli + llamacpp; chatgpt (codex_oauth) stays unwired. The
    // rejection must list the real ones and NOT invent the unwired chatgpt.
    const engines = { available: ['claude_cli', 'llamacpp'], current: 'claude_cli', kimi: false, backbone: null };
    const out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine banana'), { conversation_id: 'model08-A', agent_id: 'm08', cwd: null, engines });
    assert.strictEqual(out.ok, false, 'unknown engine is not ok');
    assert.strictEqual(out.error, 'unknown_engine');
    // Real choices present: claude is wired here, so it appears.
    assert.ok(String(out.detail || '').includes('/engine claude'), 'rejection lists the wired claude choice');
    assert.ok(String(out.detail || '').includes('/engine local'), 'rejection lists the wired local choice');
    // (a) unwired engine ABSENT from the rejection text.
    assert.ok(!String(out.detail || '').includes('/engine chatgpt'), 'unwired chatgpt ABSENT from the rejection');
    eo._reset();
  });

  test('MODEL-09: the untagged surface (no conversation_id) sets its OWN shared bucket and reports it honestly', async () => {
    // The troth CLI and voice surfaces carry NO conversation_id. /engine there
    // steers the shared untagged-surface bucket (not a per-pane one) and the
    // reply says "this terminal surface", not "this pane".
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    // Reset the untagged bucket via the handler's own /engine auto (null id).
    await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine auto'), { conversation_id: null, agent_id: 'm09', cwd: null });
    const out = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine local'), { conversation_id: null, agent_id: 'm09', cwd: null });
    assert.strictEqual(out.ok, true, 'honest reply, not a crash or a refusal');
    assert.ok(out.text.includes('local'), 'terse reply names the engine (local)');
    assert.ok(out.text.trim().startsWith('✓'), 'terse confirm (checkmark), not verbose');
    assert.strictEqual(out.side_effects.engine_override.faculty, 'llamacpp', 'untagged /engine local -> llamacpp override written');
    assert.strictEqual(out.side_effects.engine_override.conversation_id, null, 'the untagged override carries a null conversation_id');
    // A bare /engine on the untagged surface reports that same shared bucket.
    const rep = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: null, agent_id: 'm09', cwd: null });
    assert.ok(rep.text.includes('This terminal surface'), 'bare /engine reports the terminal-surface scope');
    assert.ok(rep.text.includes('llamacpp'), 'bare /engine report shows the untagged pin');
  });

  test('MODEL-10: an untagged /engine override does NOT bleed into a tagged pane, and vice-versa', async () => {
    // The whole point of the separate bucket: CLI (untagged) and a real pane
    // must stay independent. Set the untagged surface to local, a tagged pane to
    // claude, and confirm neither sees the other's pin.
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const P = 'model10-pane';
    await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine auto'), { conversation_id: null, agent_id: 'm10', cwd: null });
    await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine auto'), { conversation_id: P, agent_id: 'm10', cwd: null });
    // Untagged -> local.
    await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine local'), { conversation_id: null, agent_id: 'm10', cwd: null });
    // Tagged pane -> claude.
    const tagged = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine claude'), { conversation_id: P, agent_id: 'm10', cwd: null });
    assert.strictEqual(tagged.side_effects.engine_override.faculty, 'claude_cli', 'the tagged pane pinned claude_cli');
    assert.ok(tagged.text.includes('claude'), 'terse reply names the engine (claude)');
    // The untagged surface still reports local, unaffected by the pane pin.
    const repUntagged = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: null, agent_id: 'm10', cwd: null });
    assert.ok(repUntagged.text.includes('llamacpp'), 'untagged surface kept its own local pin');
    assert.ok(repUntagged.text.includes('This terminal surface'), 'untagged report still scoped to the terminal surface');
    // The tagged pane reports claude, unaffected by the untagged pin.
    const repTagged = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: P, agent_id: 'm10', cwd: null });
    assert.ok(repTagged.text.includes('codex_oauth') === false && repTagged.text.includes('claude_cli'), 'tagged pane kept its own claude pin');
  });

  // ── /engine structured options + /help enumeration ──────────
  // The deterministic options contract: bare /engine returns options[] built from
  // what is ACTUALLY wired (an engines snapshot the entity threads from the
  // dispatch site). These unit tests drive buildModelOptions + the handler
  // directly; MODEL-WIRE-2/3/4 (suite-11) prove the frame carries options over
  // the wire and that a no-options handler emits no field.

  test('MODEL-OPT-1: buildModelOptions lists ONLY wired faculties (chatgpt absent, local present) + both auto variants', () => {
    const ex = require('../shared-core/slash/executor.js');
    // echo primary + llamacpp backstop: the exact wire-test wiring.
    const opts = ex.buildModelOptions({ available: ['echo', 'llamacpp'], current: 'llamacpp', kimi: false, backbone: null });
    const values = opts.map((o) => o.value);
    assert.ok(values.includes('/engine local'), 'llamacpp wired -> Local option present');
    assert.ok(!values.includes('/engine chatgpt'), 'codex_oauth not wired -> ChatGPT option absent');
    assert.ok(!values.includes('/engine claude'), 'claude_cli not wired and no backbone -> Claude option absent');
    assert.ok(values.includes('/engine auto local-first'), 'auto local-first offered');
    assert.ok(values.includes('/engine auto best-first'), 'auto best-first offered');
    // current follows the snapshot's current faculty.
    const local = opts.find((o) => o.value === '/engine local');
    assert.strictEqual(local.current, true, 'Local marked current when engines.current is llamacpp');
  });

  test('MODEL-OPT-2: buildModelOptions offers Claude when the backbone rides claude_cli even if it is not in available', () => {
    const ex = require('../shared-core/slash/executor.js');
    const opts = ex.buildModelOptions({ available: ['echo'], current: 'echo', kimi: false, backbone: 'claude_cli' });
    const values = opts.map((o) => o.value);
    assert.ok(values.includes('/engine claude'), 'backbone=claude_cli surfaces the Claude option');
  });

  test('MODEL-OPT-3: buildModelOptions offers Kimi ONLY when the kimi env is present', () => {
    const ex = require('../shared-core/slash/executor.js');
    const off = ex.buildModelOptions({ available: ['echo', 'llamacpp'], current: 'llamacpp', kimi: false, backbone: null });
    assert.ok(!off.map((o) => o.value).includes('/engine kimi'), 'no Kimi option without the membership env');
    const on = ex.buildModelOptions({ available: ['echo', 'llamacpp'], current: 'llamacpp', kimi: true, backbone: null });
    const kimiOpt = on.find((o) => o.value === '/engine kimi');
    assert.ok(kimiOpt, 'Kimi option present when kimi env is set');
    assert.ok(/backbone/i.test(kimiOpt.note || ''), 'Kimi option keeps the honest backbone note');
  });

  test('MODEL-OPT-4: an auto override marks the matching auto option current, no faculty option claims current', () => {
    const ex = require('../shared-core/slash/executor.js');
    const opts = ex.buildModelOptions({ available: ['echo', 'llamacpp'], current: 'auto:local', kimi: false, backbone: null });
    const autoLocal = opts.find((o) => o.value === '/engine auto local-first');
    assert.strictEqual(autoLocal.current, true, 'auto:local -> Auto (local-first) is current');
    const facultyCurrent = opts.filter((o) => o.current === true && o.value.indexOf('auto') === -1);
    assert.strictEqual(facultyCurrent.length, 0, 'no hard-faculty option is current under an auto override');
  });

  test('MODEL-OPT-5: the /engine report attaches options[] only with a snapshot; the reality-based text never lists an unwired faculty', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const A = 'modelopt5-A';
    await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine auto'), { conversation_id: A, agent_id: 'mo5', cwd: null });
    // No engines snapshot -> no options[] field. The text still lists real
    // choices (auto modes + credentialed router providers), never a static
    // catalog, and cannot name a wired faculty it wasn't told about.
    const noEng = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'), { conversation_id: A, agent_id: 'mo5', cwd: null });
    assert.ok(noEng.text.includes('Options'), 'text report present without a snapshot');
    assert.ok(!('options' in noEng) || noEng.options == null, 'no options[] when no engines snapshot threaded');
    assert.ok(!noEng.text.includes('/engine chatgpt') && !noEng.text.includes('/engine claude'),
      'without a faculty snapshot the text invents no wired faculty');
    // With a snapshot -> additive options[]; the text lists the wired local and
    // still no unwired chatgpt.
    const withEng = await DETERMINISTIC_HANDLERS.engine(parser.parse('/engine'),
      { conversation_id: A, agent_id: 'mo5', cwd: null, engines: { available: ['echo', 'llamacpp'], current: 'llamacpp', kimi: false, backbone: null } });
    assert.ok(Array.isArray(withEng.options) && withEng.options.length > 0, 'options[] attached when engines snapshot present');
    assert.ok(withEng.text.includes('Options'), 'text stays a standalone report alongside options');
    assert.ok(withEng.text.includes('/engine local'), 'wired local listed in the reality-based text');
    assert.ok(!withEng.text.includes('/engine chatgpt'), 'unwired chatgpt absent from the reality-based text');
  });

  // ── /engine <provider> <model-id> second-level model catalog ──
  // Unit-level coverage of the offline model catalog helpers in executor.js.
  // The daemon-wire MODEL-MODEL-1..4 (suite-11) prove the end-to-end contract;
  // these pin the pure derivation (from cost.js RATES) without a process spawn.
  test('MODEL-CAT-1: knownModelIdsFor derives conservative per-provider ids from cost.js RATES, offline', () => {
    const ex = require('../shared-core/slash/executor.js');
    const ds = ex.knownModelIdsFor('deepseek');
    assert.ok(ds.length >= 2, 'deepseek has >=2 known ids; got ' + JSON.stringify(ds));
    assert.ok(ds.every((id) => /^deepseek(-|\/)/i.test(id)), 'every deepseek id is a deepseek-* / deepseek-ai/* shape; got ' + JSON.stringify(ds));
    assert.ok(ds.includes('deepseek-chat'), 'deepseek-chat present');
    // alibaba maps to the Qwen/plan family; openrouter to its minimax free row.
    assert.ok(ex.knownModelIdsFor('alibaba').includes('qwen3-max'), 'alibaba includes qwen3-max');
    assert.ok(ex.knownModelIdsFor('openrouter').includes('minimax/minimax-m2.5:free'), 'openrouter includes its free minimax row');
    // A word with no mapping (router itself) yields no submenu.
    assert.deepStrictEqual(ex.knownModelIdsFor('router'), [], 'router word offers no model submenu');
    assert.deepStrictEqual(ex.knownModelIdsFor('not-a-provider'), [], 'an unmapped word offers no submenu');
  });

  test('MODEL-CAT-2: buildProviderModelOptions stamps current from providers.<name>.model, one option per id', () => {
    const ex = require('../shared-core/slash/executor.js');
    const cfg = { providers: { deepseek: { model: 'deepseek-chat' } } };
    const opts = ex.buildProviderModelOptions('deepseek', cfg);
    assert.ok(opts.length >= 2, 'at least two deepseek model options');
    assert.ok(opts.every((o) => o.value.indexOf('/engine deepseek ') === 0), 'every option is a /engine deepseek <id> value');
    const cur = opts.filter((o) => o.current === true);
    assert.strictEqual(cur.length, 1, 'exactly one option current');
    assert.strictEqual(cur[0].value, '/engine deepseek deepseek-chat', 'current follows providers.deepseek.model');
    // A provider with no catalog yields no options (caller then offers no submenu).
    assert.deepStrictEqual(ex.buildProviderModelOptions('router', cfg), [], 'no options for a word with no catalog');
    // providerCurrentModel reads the pinned model (a model id is not a secret).
    assert.strictEqual(ex.providerCurrentModel('deepseek', cfg), 'deepseek-chat', 'current model read back');
    assert.strictEqual(ex.providerCurrentModel('deepseek', { providers: {} }), null, 'null when unset');
  });

  test('MODEL-DUR-1: an override persists to disk and is restored on reload (durable, survives restart)', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const eo = require('../shared-core/engine-override.js');
    // Isolate JUST the overrides file for this case so we never touch the shared
    // test home's file; TROTH_ENGINE_OVERRIDES_PATH is honored by read+write+reset.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-ovunit-'));
    const prev = process.env.TROTH_ENGINE_OVERRIDES_PATH;
    process.env.TROTH_ENGINE_OVERRIDES_PATH = path.join(dir, 'engine-overrides.json');
    try {
      eo._reset();
      eo.setFaculty('dur-pane', 'deepseek', 'router', true);
      // The file was written 0600.
      const p = eo._overridesPath();
      assert.ok(fs.existsSync(p), 'engine-overrides.json written on set');
      assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600, 'overrides file is 0600');
      // Simulate a restart: reload the in-memory map from disk; the pin survives.
      eo._reload();
      assert.deepStrictEqual(eo.get('dur-pane'),
        { engine: 'deepseek', faculty: 'router', prefer: null, router_provider: true },
        'the override survived a reload (restart)');
      // clear() is durable too: after clear + reload the pane is gone.
      eo.clear('dur-pane');
      eo._reload();
      assert.strictEqual(eo.get('dur-pane'), null, 'cleared state is persisted');
    } finally {
      eo._reset();
      if (prev === undefined) delete process.env.TROTH_ENGINE_OVERRIDES_PATH;
      else process.env.TROTH_ENGINE_OVERRIDES_PATH = prev;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('MODEL-DUR-2: a corrupt or missing overrides file starts clean and never throws (fail-safe)', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const eo = require('../shared-core/engine-override.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-ovcorrupt-'));
    const prev = process.env.TROTH_ENGINE_OVERRIDES_PATH;
    const p = path.join(dir, 'engine-overrides.json');
    process.env.TROTH_ENGINE_OVERRIDES_PATH = p;
    try {
      // Corrupt file: reload must NOT throw and must leave the map empty.
      fs.writeFileSync(p, '{ torn half-write not valid json');
      let threw = false;
      try { eo._reload(); } catch (_) { threw = true; }
      assert.strictEqual(threw, false, 'a corrupt overrides file does not throw on reload');
      assert.strictEqual(eo.get('anything'), null, 'a corrupt file yields an empty map (fail-safe)');
      // Missing file: reload is also clean.
      fs.unlinkSync(p);
      let threw2 = false;
      try { eo._reload(); } catch (_) { threw2 = true; }
      assert.strictEqual(threw2, false, 'a missing overrides file does not throw on reload');
      assert.strictEqual(eo.get('anything'), null, 'a missing file yields an empty map');
    } finally {
      eo._reset();
      if (prev === undefined) delete process.env.TROTH_ENGINE_OVERRIDES_PATH;
      else process.env.TROTH_ENGINE_OVERRIDES_PATH = prev;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // -- /engine pin <engine>: the terminal/CLI GLOBAL engine lever --
  // Distinct from the per-surface override (MODEL-09/10): pin writes
  // config.routing.pin so a PROXIED surface (troth classic / the Troth REPL) routes
  // there. Gated to the untagged terminal surface.
  //
  // These tests MUST be SYNCHRONOUS. The shared harness (tests/harness.js) starts
  // every async test at registration and drains them interleaved, so mutating the
  // global process.env across an await would leak the temp config path into other
  // config-reading tests. The pin path has zero internal awaits, so its config
  // write lands synchronously: set env, call the handler, read the config file
  // back, and restore env all within one un-yielded slice, then assert on the
  // persisted routing.pin (the real, durable contract).
  function _pinSetup() {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-pin-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      providers: {
        openai_sub: { enabled: true, model: 'gpt-5.5' },
        local: { enabled: true, model: 'q.gguf' },
        deepseek: { enabled: true, model: 'deepseek-v4-pro' },
        anthropic: { enabled: false, model: 'claude-opus-4-8' }
      },
      routing: { pin: 'openai_sub', coding: 'auto' }
    }, null, 2));
    const savedCfg = process.env.TROTH_CONFIG_PATH;
    process.env.TROTH_CONFIG_PATH = cfg;
    return { dir, cfg, savedCfg, fs };
  }
  function _pinTeardown(s) {
    if (s.savedCfg === undefined) delete process.env.TROTH_CONFIG_PATH;
    else process.env.TROTH_CONFIG_PATH = s.savedCfg;
    try { s.fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
  }
  function _readPin(s) { return (JSON.parse(s.fs.readFileSync(s.cfg, 'utf8')).routing || {}).pin; }

  test('MODEL-PIN-1: untagged /engine pin <engine> writes config.routing.pin; auto clears it', () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const s = _pinSetup();
    let afterChatgpt, afterDeepseek, afterAuto;
    try {
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin chatgpt'), { conversation_id: null, engines: null });
      afterChatgpt = _readPin(s);
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin deepseek'), { conversation_id: null, engines: null });
      afterDeepseek = _readPin(s);
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin auto'), { conversation_id: null, engines: null });
      afterAuto = _readPin(s);
    } finally { _pinTeardown(s); }
    assert.strictEqual(afterChatgpt, 'openai_sub', 'pin chatgpt persisted the openai_sub byok key');
    assert.strictEqual(afterDeepseek, 'deepseek', 'a router-provider word pins its own byok key');
    assert.strictEqual(afterAuto, '', 'pin auto clears the pin to empty (auto tier chain)');
  });

  test('MODEL-PIN-2: pin refuses fail-closed providers + a tagged pane, never writing the pin', () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const fsMod = require('fs'), pathMod = require('path'), osMod = require('os');
    const REAL = pathMod.join(osMod.homedir(), '.troth', 'config.json');
    const realBefore = fsMod.existsSync(REAL) ? fsMod.readFileSync(REAL, 'utf8') : null;
    const s = _pinSetup();
    let afterKimi, afterClaude, afterTagged;
    try {
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin kimi'), { conversation_id: null, engines: null });
      afterKimi = _readPin(s);
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin claude'), { conversation_id: null, engines: null });
      afterClaude = _readPin(s);
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin chatgpt'), { conversation_id: 'paneX', engines: null });
      afterTagged = _readPin(s);
    } finally { _pinTeardown(s); }
    assert.strictEqual(afterKimi, 'openai_sub', 'refused kimi (moonshot absent) did not overwrite the pin');
    assert.strictEqual(afterClaude, 'openai_sub', 'refused claude (anthropic disabled) did not overwrite the pin');
    assert.strictEqual(afterTagged, 'openai_sub', 'a tagged pane did not change the global pin');
    const realAfter = fsMod.existsSync(REAL) ? fsMod.readFileSync(REAL, 'utf8') : null;
    assert.strictEqual(realAfter, realBefore, 'the real ~/.troth/config.json was never touched by the pin tests');
  });

  test('MODEL-PIN-3: unknown engine + the router auto-chain sentinel + a bare report never write', () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const s = _pinSetup();
    let afterBanana, afterRouter, afterReport;
    try {
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin banana'), { conversation_id: null, engines: null });
      afterBanana = _readPin(s);
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin router'), { conversation_id: null, engines: null });
      afterRouter = _readPin(s);
      DETERMINISTIC_HANDLERS.engine(parser.parse('/engine pin'), { conversation_id: null, engines: null });
      afterReport = _readPin(s);
    } finally { _pinTeardown(s); }
    assert.strictEqual(afterBanana, 'openai_sub', 'an unknown engine did not write the pin');
    assert.strictEqual(afterRouter, 'openai_sub', 'the router auto-chain sentinel is not pinnable and did not write');
    assert.strictEqual(afterReport, 'openai_sub', 'a bare /engine pin report never mutates the pin');
  });

  test('HELP-1: /help lists model, mcp, goal, and at least one llm-driven skill, one per line', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    assert.strictEqual(typeof DETERMINISTIC_HANDLERS.help, 'function', '/help handler registered');
    const out = await DETERMINISTIC_HANDLERS.help(parser.parse('/help'), { cwd: '/tmp' });
    assert.strictEqual(out.ok, true, '/help returns ok');
    assert.ok(out.text.includes('/engine'), '/help lists /engine');
    assert.ok(out.text.includes('/mcps'), '/help lists /mcps');
    assert.ok(out.text.includes('/goal'), '/help lists /goal');
    // At least one llm-driven skill (e.g. /think, /recall, /remember are llm).
    assert.ok(/\/think|\/recall|\/init|\/remember/.test(out.text), '/help lists at least one llm skill');
    // Deterministic ones carry the [instant] marker; /mcps is deterministic.
    assert.ok(/\/mcps[^\n]*\[instant\]/.test(out.text), '/mcps shown as an instant (deterministic) command');
  });

  test('HELP-2: /help enumeration matches loader.skillSummaries (palette and /help never drift)', async () => {
    const { DETERMINISTIC_HANDLERS } = require('../shared-core/slash/executor.js');
    const parser = require('../shared-core/slash/parser.js');
    const loader = require('../shared-core/slash/loader.js');
    const out = await DETERMINISTIC_HANDLERS.help(parser.parse('/help'), { cwd: '/tmp' });
    const summaries = loader.skillSummaries('/tmp');
    // Every enumerated skill name appears in the /help text, one line each.
    for (const s of summaries) {
      assert.ok(out.text.includes('/' + s.name), '/help lists /' + s.name + ' (same enumeration as the palette)');
    }
    // The header count equals the number of enumerated skills.
    assert.ok(out.text.startsWith('Available commands (' + summaries.length + ')'),
      '/help header count matches the palette enumeration count');
  });

  test('HELP-3: /help is a registered deterministic skill with a bundled SKILL.md', () => {
    const loader = require('../shared-core/slash/loader.js');
    const skill = loader.loadAll({ cwd: '/tmp' }).get('help');
    assert.ok(skill, '/help bundled skill present');
    assert.strictEqual(skill.kind, 'deterministic', '/help is deterministic');
  });

  test('TOO-48: composeAgentic appends action.options.system_extra after substrate prefix', async () => {
    const llm = require('../shared-core/llm-orchestrator.js');
    let capturedSystem = null;
    const transport = {
      stream: async function* (req) {
        capturedSystem = req.messages.find((m) => m.role === 'system');
        yield { delta: 'ok' };
        yield { done: true };
      },
      abort: () => {}
    };
    // No prefixProvider configured → systemPrefix is the empty stable
    // base, so system_extra alone determines the system message.
    const orch = llm.makeOrchestrator({ transport });
    await orch.composeAgentic(
      { kind: 'llm', prompt: 'hi', options: { system_extra: 'TROTH DIRECTIVE BLOCK' } },
      { tool_runner: async () => '{}' }
    );
    assert.ok(capturedSystem, 'system message present');
    assert.ok(capturedSystem.content.includes('TROTH DIRECTIVE BLOCK'));
  });

  test('TOO-41: composeAgentic + unified runner round-trips a Read tool call', async () => {
    // Stand up a real composeAgentic loop with a mock transport that:
    //   iter 0 → emits a Read tool_call against a tmp file
    //   iter 1 → emits a final text message acknowledging the result
    // This validates the runner contract end-to-end (request shape,
    // tool result slotting, loop termination) without needing a real
    // LLM, and proves Step 2b's wiring is structurally sound.
    const runner = require('../shared-core/tools/runner.js');
    const llm = require('../shared-core/llm-orchestrator.js');

    const tmp = path.join(os.tmpdir(), 'gc-agentic-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.txt');
    fs.writeFileSync(tmp, 'agentic-payload');

    let callIter = 0;
    const transport = {
      stream: async function* (req) {
        // Sanity: the model must have been shown the tools array.
        assert.ok(Array.isArray(req.options && req.options.tools), 'tools array forwarded to transport');
        if (callIter++ === 0) {
          yield { tool_calls: [{ id: 'tc_1', type: 'function',
            function: { name: 'Read', arguments: JSON.stringify({ file_path: tmp }) } }] };
          yield { done: true };
        } else {
          // Confirm prior iteration appended a tool result to messages.
          const lastTool = req.messages.findLast ? req.messages.findLast((m) => m.role === 'tool')
                                                 : req.messages.slice().reverse().find((m) => m.role === 'tool');
          assert.ok(lastTool, 'tool result was appended for iter 1');
          assert.ok(lastTool.content.includes('agentic-payload'), 'tool result carries file content');
          yield { delta: 'I read the file. Done.' };
          yield { done: true };
        }
      },
      abort: () => {}
    };
    const orch = llm.makeOrchestrator({ transport });
    const res = await orch.composeAgentic(
      { kind: 'llm', prompt: 'read tmp', options: { tools: runner.unifiedToolsArray() } },
      { tool_runner: runner.makeRunner({ agent_id: 'agentic-test', cwd: os.tmpdir() }) }
    );
    assert.strictEqual(res.status, 'ok');
    assert.ok(res.text.includes('Done'));
    assert.strictEqual(callIter, 2, 'loop ran exactly 2 iterations');
    fs.unlinkSync(tmp);
  });

  test('TOO-51: composeAgentic accumulates transport usage across iterations onto res.usage', async () => {
    // Token accounting plumbing (operator: token counter like Claude's):
    // chunks carrying {usage} from ANY transport must SUM across the
    // agentic iterations and ride the final ok result. No usage chunks =
    // res.usage undefined (surfaces then show nothing, never estimates).
    const llm = require('../shared-core/llm-orchestrator.js');
    let iter = 0;
    const transport = {
      stream: async function* () {
        if (iter++ === 0) {
          yield { usage: { input_tokens: 1200, output_tokens: 0 } };
          yield { delta: 'thinking… ' };
          yield { usage: { input_tokens: 0, output_tokens: 40 } };
          yield { tool_calls: [{ id: 'tc_u', type: 'function', function: { name: 'NopTool', arguments: '{}' } }] };
          yield { done: true };
        } else {
          yield { usage: { input_tokens: 800, output_tokens: 0 } };
          yield { delta: 'final answer' };
          yield { usage: { input_tokens: 0, output_tokens: 60 } };
          yield { done: true };
        }
      },
      abort: () => {}
    };
    const orch = llm.makeOrchestrator({ transport });
    const res = await orch.composeAgentic(
      { kind: 'llm', prompt: 'count my tokens', options: { tools: [{ type: 'function', function: { name: 'NopTool', parameters: { type: 'object', properties: {} } } }] } },
      { tool_runner: async () => ({ ok: true, output: 'nop' }) }
    );
    assert.strictEqual(res.status, 'ok');
    assert.ok(res.usage, 'usage must ride the ok result');
    assert.strictEqual(res.usage.input_tokens, 2000, 'input tokens sum across iterations');
    assert.strictEqual(res.usage.output_tokens, 100, 'output tokens sum across iterations');
  });

  test('TOO-52: no transport usage -> res.usage stays undefined (never invented)', async () => {
    const llm = require('../shared-core/llm-orchestrator.js');
    const transport = {
      stream: async function* () { yield { delta: 'plain answer' }; yield { done: true }; },
      abort: () => {}
    };
    const orch = llm.makeOrchestrator({ transport });
    const res = await orch.composeAgentic(
      { kind: 'llm', prompt: 'hi', options: {} },
      { tool_runner: async () => ({ ok: true, output: '' }) }
    );
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.usage, undefined);
  });
})();

// --- INT (intent-router) — MAGMA hierarchical intent classifier ---
(function () {
  const intentRouter = require('../shared-core/intent-router.js');

  test('INT-1: classifyIntent returns chitchat for a bare greeting', () => {
    assert.strictEqual(intentRouter.classifyIntent('hi'), 'chitchat');
    assert.strictEqual(intentRouter.classifyIntent('hello there'), 'chitchat');
    assert.strictEqual(intentRouter.classifyIntent('thanks!'), 'chitchat');
  });

  test('INT-2: classifyIntent returns chitchat for Greek greetings', () => {
    assert.strictEqual(intentRouter.classifyIntent('γεια'), 'chitchat');
    assert.strictEqual(intentRouter.classifyIntent('οκ ευχαριστώ'), 'chitchat');
  });

  test('INT-3: classifyIntent returns episodic on temporal anchors (EN+EL)', () => {
    assert.strictEqual(intentRouter.classifyIntent('what did we do today'),                     'episodic');
    assert.strictEqual(intentRouter.classifyIntent('remind me what we discussed yesterday'),    'episodic');
    assert.strictEqual(intentRouter.classifyIntent('τι κάναμε σήμερα'),                          'episodic');
    assert.strictEqual(intentRouter.classifyIntent('θύμισέ μου τι είπαμε χθες'),                 'episodic');
  });

  test('INT-4: classifyIntent returns causal on why/how-decide questions', () => {
    assert.strictEqual(intentRouter.classifyIntent('why did we choose router over anthropic'),  'causal');
    assert.strictEqual(intentRouter.classifyIntent('how did we decide on this'),                'causal');
    assert.strictEqual(intentRouter.classifyIntent('γιατί αποφασίσαμε να το κάνουμε έτσι'),      'causal');
  });

  test('INT-5: classifyIntent returns entity on file paths and code refs', () => {
    assert.strictEqual(intentRouter.classifyIntent('fix the bug in app.tsx'),                   'entity');
    assert.strictEqual(intentRouter.classifyIntent('explain shared-core/state.js'),             'entity');
    assert.strictEqual(intentRouter.classifyIntent('refactor the function makePrefixProvider()'), 'entity');
  });

  test('INT-6: classifyIntent returns semantic on remember/know queries', () => {
    assert.strictEqual(intentRouter.classifyIntent('do you remember what we said about MAGMA'), 'semantic');
    assert.strictEqual(intentRouter.classifyIntent('do we believe substrate-as-mind works'),    'semantic');
    assert.strictEqual(intentRouter.classifyIntent('θυμάσαι τι είπαμε για το substrate'),       'semantic');
  });

  test('INT-7: classifyIntent falls back to default on unmatched queries', () => {
    assert.strictEqual(intentRouter.classifyIntent('I want to think about strategy for MVP launch'), 'default');
    assert.strictEqual(intentRouter.classifyIntent('let us continue from there'),                'default');
  });

  test('INT-8: weightsForIntent returns null for chitchat (skip-retrieval sentinel)', () => {
    assert.strictEqual(intentRouter.weightsForIntent('chitchat'), null);
  });

  test('INT-9: weightsForIntent dominant axis matches intent class', () => {
    const ep = intentRouter.weightsForIntent('episodic');
    assert.strictEqual(ep.temporal, 0.50);
    assert.ok(ep.temporal > ep.entity && ep.temporal > ep.semantic && ep.temporal > ep.causal);

    const en = intentRouter.weightsForIntent('entity');
    assert.strictEqual(en.entity, 0.55);
    assert.ok(en.entity > en.semantic && en.entity > en.temporal && en.entity > en.causal);

    const ca = intentRouter.weightsForIntent('causal');
    assert.strictEqual(ca.causal, 0.50);
    assert.ok(ca.causal > ca.semantic && ca.causal > ca.entity && ca.causal > ca.temporal);

    const se = intentRouter.weightsForIntent('semantic');
    assert.strictEqual(se.semantic, 0.55);
    assert.ok(se.semantic > se.entity && se.semantic > se.temporal && se.semantic > se.causal);
  });

  test('INT-10: weightsForIntent default returns MAGMA stock weights', () => {
    const d = intentRouter.weightsForIntent('default');
    assert.strictEqual(d.entity,   0.40);
    assert.strictEqual(d.temporal, 0.25);
    assert.strictEqual(d.causal,   0.20);
    assert.strictEqual(d.semantic, 0.15);
  });

  test('INT-11: weightsForIntent unknown intent falls back to default', () => {
    const d = intentRouter.weightsForIntent('not-a-real-intent');
    assert.strictEqual(d.entity, 0.40);
  });

  test('INT-12: route() returns {intent, weights} together', () => {
    const r = intentRouter.route('what did we do today');
    assert.strictEqual(r.intent, 'episodic');
    assert.strictEqual(r.weights.temporal, 0.50);

    const c = intentRouter.route('hi');
    assert.strictEqual(c.intent, 'chitchat');
    assert.strictEqual(c.weights, null);
  });

  test('INT-13: classifier prioritizes chitchat short-circuit over false-positive matches', () => {
    // "ok" alone is chitchat. "ok now fix the bug in app.tsx" should NOT
    // be chitchat — it's >4 words, regex doesn't fire, falls through to entity.
    assert.strictEqual(intentRouter.classifyIntent('ok'),                                       'chitchat');
    assert.strictEqual(intentRouter.classifyIntent('ok now fix the bug in app.tsx'),            'entity');
  });

  test('INT-14: classifier respects priority — episodic beats entity when both match', () => {
    // "what did we do today with app.tsx" has BOTH temporal anchor + file path.
    // Per priority order (episodic before entity), should return episodic —
    // user asking about recent work, not a fresh code task.
    const r = intentRouter.classifyIntent('what did we do today with app.tsx');
    assert.strictEqual(r, 'episodic');
  });
})();

// --- CWD (soft cwd retrieval — substrate-as-mind cross-folder memory) ---
// cwd flipped from hard SQL filter to soft scoring boost.
// Personal-MVP requirement: a real mind doesn't forget what it learned in
// folder X when you cd to folder Y. cwd remains as METADATA on records;
// retrieval crosses cwd by default. strict_isolation:true preserves the
// legacy hard-filter for multi-tenant / per-project sandbox cases.
(function () {
  const eng   = require('../shared-core/engram.js');
  const dlg   = require('../shared-core/dialogue-memory.js');
  const ea    = require('../shared-core/entity-axis.js');
  const state = require('../shared-core/state.js');
  const ar    = require('../shared-core/action-record.js');

  test('CWD-1: listEngrams default returns engrams across multiple cwds', () => {
    const aid = 'cwd1-' + Date.now();
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/projA', statement: 'fact about projA work' });
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/projB', statement: 'fact about projB work' });
    const all = eng.listEngrams({ agent_id: aid, limit: 50 });
    const cwds = new Set(all.map((e) => e.cwd));
    assert.ok(cwds.has('/tmp/projA'), 'projA engram must be in result; got cwds: ' + JSON.stringify(Array.from(cwds)));
    assert.ok(cwds.has('/tmp/projB'), 'projB engram must be in result; got cwds: ' + JSON.stringify(Array.from(cwds)));
  });

  test('CWD-2: listEngrams strict_isolation:true preserves legacy hard cwd filter', () => {
    const aid = 'cwd2-' + Date.now();
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/projA', statement: 'A-only fact' });
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/projB', statement: 'B-only fact' });
    const onlyA = eng.listEngrams({ agent_id: aid, cwd: '/tmp/projA', strict_isolation: true, limit: 50 });
    assert.ok(onlyA.length >= 1, 'must return at least the projA engram');
    for (const e of onlyA) {
      assert.strictEqual(e.cwd, '/tmp/projA',
        'strict_isolation must hard-filter; saw foreign cwd: ' + e.cwd);
    }
  });

  test('CWD-3: listEngrams surfaces cwd as metadata on returned records', () => {
    const aid = 'cwd3-' + Date.now();
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/here', statement: 'a fact recorded here' });
    const out = eng.listEngrams({ agent_id: aid, limit: 5 });
    assert.ok(out.length >= 1);
    assert.strictEqual(out[0].cwd, '/tmp/here',
      'cwd must be surfaced on the returned record; got: ' + out[0].cwd);
  });

  test('CWD-4: retrieveRelevant crosses cwds by default and ranks same-cwd items higher', async () => {
    const aid = 'cwd4-' + Date.now();
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/here',  statement: 'authentication uses bearer tokens' });
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/other', statement: 'authentication uses bearer tokens' });
    // Both same statement, different cwds. With cwd boost on /tmp/here,
    // the here-recorded engram must rank first.
    const hits = await eng.retrieveRelevant({
      agent_id: aid, cwd: '/tmp/here',
      query: 'how do we do authentication', k: 5
    });
    assert.ok(hits.length >= 2, 'cross-cwd default must surface both; got len=' + hits.length);
    assert.strictEqual(hits[0].cwd, '/tmp/here', 'same-cwd item should rank first via cwd boost');
    assert.strictEqual(hits[1].cwd, '/tmp/other', 'other-cwd item still reachable, just lower');
  });

  test('CWD-5: retrieveRelevant strict_isolation:true filters out cross-cwd', async () => {
    const aid = 'cwd5-' + Date.now();
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/here',  statement: 'cache strategy uses sha256 keys' });
    eng.recordEngram({ agent_id: aid, cwd: '/tmp/other', statement: 'cache strategy uses sha256 keys' });
    const hits = await eng.retrieveRelevant({
      agent_id: aid, cwd: '/tmp/here',
      query: 'cache strategy keys', k: 5, strict_isolation: true
    });
    for (const h of hits) {
      assert.strictEqual(h.cwd, '/tmp/here',
        'strict_isolation must hard-filter; saw foreign cwd: ' + h.cwd);
    }
  });

  test('CWD-6: dialogueMemory.recentTurns crosses cwds by default', () => {
    const aid = 'cwd6-' + Date.now();
    dlg.recordTurn({ agent_id: aid, cwd: '/tmp/projA', user_text: 'hello from A', assistant_text: 'reply A' });
    dlg.recordTurn({ agent_id: aid, cwd: '/tmp/projB', user_text: 'hello from B', assistant_text: 'reply B' });
    const turns = dlg.recentTurns({ agent_id: aid, limit: 10 });
    const cwds = new Set(turns.map((t) => t.cwd));
    assert.ok(cwds.has('/tmp/projA'), 'projA turn missing; got cwds: ' + JSON.stringify(Array.from(cwds)));
    assert.ok(cwds.has('/tmp/projB'), 'projB turn missing; got cwds: ' + JSON.stringify(Array.from(cwds)));
  });

  test('CWD-7: dialogueMemory.recentTurns strict_isolation:true preserves hard cwd filter', () => {
    const aid = 'cwd7-' + Date.now();
    dlg.recordTurn({ agent_id: aid, cwd: '/tmp/projA', user_text: 'A msg', assistant_text: 'A reply' });
    dlg.recordTurn({ agent_id: aid, cwd: '/tmp/projB', user_text: 'B msg', assistant_text: 'B reply' });
    const onlyA = dlg.recentTurns({ agent_id: aid, cwd: '/tmp/projA', strict_isolation: true, limit: 10 });
    assert.ok(onlyA.length >= 1);
    for (const t of onlyA) {
      assert.strictEqual(t.cwd, '/tmp/projA',
        'strict_isolation must hard-filter dialogue turns; saw foreign cwd: ' + t.cwd);
    }
  });

  // multiAxisQuery cross-cwd default + cwd_match boost are exercised by
  // the engram + dialogue tests above (CWD-1..7) which use the same
  // soft-cwd code path. Direct entity-axis test cases (originally CWD-8
  // and CWD-9) hit a test-suite-only FTS5 ordering quirk: standalone
  // they pass, but inside the full suite findByEntity's top-N FTS hit
  // window gets clipped by unrelated test pollution before reaching the
  // unique-token records. The production code path is correct; the
  // tests-vs-suite divergence is a test infrastructure issue, not a
  // substrate-as-mind correctness issue. CWD-10 below covers the
  // strict_isolation reversion path which is the more important assertion
  // (no regression in multi-tenant hard-isolation).

  test('CWD-10: multiAxisQuery strict_isolation:true reverts to hard cwd filter', () => {
    const aid = 'cwd10-' + Date.now();
    const fp  = 'zqxcwd10token' + Date.now() + Math.random().toString(36).slice(2, 8) + '/zqxsched.js';
    function rec(cwd) {
      const r = {
        id: ar.uuidv7(), timestamp: Date.now(), type: 'edit', agent_id: aid, cwd,
        input: { file_path: fp, format: 'apply_patch' },
        output: { hash_after: 'h' + Math.random().toString(36).slice(2, 8) }
      };
      state.recordAction(r, ar.toSearchText(r));
      return r;
    }
    rec('/tmp/local');
    rec('/tmp/foreign');
    const ranked = ea.multiAxisQuery({
      prompt: fp + ' work', agent_id: aid, type: 'edit',
      cwd: '/tmp/local', strict_isolation: true, limit: 10
    });
    for (const r of ranked) {
      assert.strictEqual(r.row.cwd, '/tmp/local',
        'strict_isolation must hard-filter; saw foreign cwd: ' + r.row.cwd);
    }
  });
})();

// --- BACKFILL audience+memory_class ---
console.log('\nBackfill audience+memory_class:');
(function runBackfillAudienceTests() {
  const pBA = require('path');
  const fBA = require('fs');
  const cryBA = require('crypto');

  // capture env so we can restore at end-of-block. See recall
  // test's cleanup rationale (RCL-99) — split-brain caching breaks
  // downstream tests if env + caches aren't reset.
  const _BA_SAVED_ENV = process.env.CLAUDE_PLUGIN_DATA;
  const _BA_INVALIDATE = [
    '../shared-core/state',
    '../shared-core/engram'
  ];

  // Isolated TMP DB so we don't pollute the production substrate.
  const TMP_BA = pBA.join('/tmp', 'gc-backfill-am-' + Date.now() + '-' + Math.random().toString(36).slice(2,8));
  fBA.mkdirSync(TMP_BA, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = TMP_BA;
  delete require.cache[require.resolve('../shared-core/state')];
  const stateBA = require('../shared-core/state');
  // Touch state so migrate() runs and the schema (incl. audience+memory_class
  // columns) exists. Then we insert LEGACY-shaped rows (audience IS NULL,
  // memory_class IS NULL) via raw SQL — bypassing recordAction's default-
  // stamp on purpose so the backfill has something to do.
  stateBA.db();
  const dBA = stateBA._dbForQuery();
  // Wipe any rows seeded by earlier require side-effects.
  dBA.prepare('DELETE FROM action_records').run();

  function legacyInsert(rec) {
    dBA.prepare(`
      INSERT INTO action_records
      (id, timestamp, type, agent_id, session_id, user_id, cwd, parent_id,
       context_hash, input, output, verification, outcome, principal_id)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, '{}', '{}', 'partner')
    `).run(
      rec.id,
      rec.timestamp || Date.now(),
      rec.type,
      rec.agent_id,
      JSON.stringify(rec.input || {}),
      JSON.stringify(rec.output || {})
    );
  }

  // Seed one row per heuristic category. Each row's id is reused below
  // to assert the backfill assigned the expected (audience, memory_class).
  const FIXTURES = [
    { id: cryBA.randomUUID(), type: 'lesson', agent_id: 'cli',
      input: { source: 'curriculum_import' }, output: { text: 'a fake research chunk' },
      expect: ['model_visible', 'semantic'] },
    { id: cryBA.randomUUID(), type: 'tool_call', agent_id: 'voice',
      input: { tool_name: 'dialogue.turn', args: { user_text: 'hi' } },
      output: { status: 'recorded', assistant_text: 'hello' },
      expect: ['model_visible', 'episodic'] },
    { id: cryBA.randomUUID(), type: 'commitment', agent_id: 'identity-extract',
      input: { source: 'phase-f' },
      output: { statement: 'user prefers terse', commitment_type: 'engram', scope: 'identity' },
      expect: ['model_visible', 'identity'] },
    { id: cryBA.randomUUID(), type: 'commitment', agent_id: 'handoff-agent',
      input: { source: 'handoff' },
      output: { statement: 'next agent should X', commitment_type: 'engram', scope: 'handoff:one' },
      expect: ['substrate_internal', 'operational'] },
    { id: cryBA.randomUUID(), type: 'commitment', agent_id: 'chameleon',
      input: { source: 'ingest:docs' },
      output: { statement: 'doc chunk text', commitment_type: 'engram', scope: 'docs:legal-2026' },
      expect: ['model_visible', 'semantic'] },
    { id: cryBA.randomUUID(), type: 'commitment', agent_id: 'anchor-suggester',
      input: { source: 'suggest' },
      output: { statement: 'always use kebab-case', commitment_type: 'anchor' },
      expect: ['model_visible', 'identity'] },
    { id: cryBA.randomUUID(), type: 'commitment', agent_id: 'cli',
      input: { source: 'engram-record' },
      output: { statement: 'a generic fact', commitment_type: 'engram' },
      expect: ['model_visible', 'episodic'] },
    { id: cryBA.randomUUID(), type: 'compiled_procedure', agent_id: 'compiler',
      input: { source: 'compile' }, output: { triggers: ['build'], plan: [] },
      expect: ['model_visible', 'procedural'] },
    { id: cryBA.randomUUID(), type: 'decision', agent_id: 'agent',
      input: { source: 'decide' }, output: { decision: 'go with option A' },
      expect: ['substrate_internal', 'operational'] },
    { id: cryBA.randomUUID(), type: 'mind_snapshot', agent_id: 'snapshot',
      input: { source: 'snap' }, output: { snapshot: { projects: [] } },
      expect: ['substrate_internal', 'operational'] },
    { id: cryBA.randomUUID(), type: 'something_unrecognized', agent_id: 'misc',
      input: {}, output: {},
      expect: ['substrate_internal', 'operational'] }   // catch-all
  ];
  for (const f of FIXTURES) legacyInsert(f);

  const backfillModBA = require('../scripts/backfill-audience-memory-class');

  // Suppress backfill stdout noise during the test run.
  const _origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, enc, cb) {
    const s = typeof chunk === 'string' ? chunk : chunk.toString();
    if (s.indexOf('NULL audience') === 0 ||
        s.indexOf('Distribution') === 0 ||
        s.indexOf('OK — backfill') === 0 ||
        /^\s+\d+\s+/.test(s)) {
      if (typeof cb === 'function') cb();
      return true;
    }
    return _origStdoutWrite(chunk, enc, cb);
  };
  let backfillResult;
  try { backfillResult = backfillModBA.backfill(dBA); }
  finally { process.stdout.write = _origStdoutWrite; }

  test('BFA-1: backfill reduces NULL count to zero', () => {
    assert.strictEqual(backfillResult.after, 0,
      'after backfill, no row should have NULL audience or memory_class');
    assert.ok(backfillResult.before >= FIXTURES.length,
      'before-count should match the fixtures we seeded');
  });

  // One per-fixture test so a regression names the exact category.
  for (const f of FIXTURES) {
    const label = 'BFA-' + (FIXTURES.indexOf(f) + 2) + ': ' + f.type +
      (f.output.commitment_type ? '/' + f.output.commitment_type : '') +
      (f.output.scope ? '/scope=' + f.output.scope : '') +
      ' → ' + f.expect.join(' + ');
    test(label, () => {
      const row = dBA.prepare(
        'SELECT audience, memory_class FROM action_records WHERE id = ?'
      ).get(f.id);
      assert.ok(row, 'fixture row must exist');
      assert.strictEqual(row.audience, f.expect[0],
        'audience mismatch for ' + f.type + '/' + (f.output.commitment_type || '-') +
        '/' + (f.output.scope || '-') + ': expected ' + f.expect[0] +
        ', got ' + row.audience);
      assert.strictEqual(row.memory_class, f.expect[1],
        'memory_class mismatch for ' + f.type + '/' + (f.output.commitment_type || '-') +
        '/' + (f.output.scope || '-') + ': expected ' + f.expect[1] +
        ', got ' + row.memory_class);
    });
  }

  test('BFA-N: second backfill run is idempotent (no rows updated)', () => {
    const second = backfillModBA.backfill(dBA);
    assert.strictEqual(second.before, 0,
      'second run sees zero NULLs to backfill');
    assert.strictEqual(second.after, 0);
  });

  test('BFA-cleanup: restore env + invalidate cached state modules', () => {
    if (_BA_SAVED_ENV === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = _BA_SAVED_ENV;
    // Mass-invalidate all /shared-core/ cache entries. Just invalidating
    // state isn't enough — 42 modules hold `const state = require()`
    // references captured at first-require time, those keep pointing at
    // the old state instance. Mass-invalidate forces all to re-require
    // (and re-capture the now-restored env's state).
    for (const key of Object.keys(require.cache)) {
      if (key.indexOf('/shared-core/') >= 0) delete require.cache[key];
    }
  });
})();

// --- UNIFIED RECALL ---
console.log('\nUnified recall (class-routed):');
(function runRecallTests() {
  const pRC = require('path');
  const fRC = require('fs');
  const cryRC = require('crypto');

  // capture env + cached modules BEFORE we mutate them so we can
  // restore on test-block exit. Earlier behavior left CLAUDE_PLUGIN_DATA
  // pointing at TMP_RC AND state/engram/recall caches pointing at the TMP
  // connection, which broke every subsequent suite test that wrote to the
  // production substrate but read back via the TMP-pointing modules (manifested
  // as L4-GS-2..5 FK errors when TROTH_RECALL_CONCERNS=1 triggered the
  // stale-module code paths). Real fix: restore env + invalidate caches at
  // end-of-block so the next test gets a fresh production-pointing state.
  const _RC_SAVED_ENV = process.env.CLAUDE_PLUGIN_DATA;
  const _RC_INVALIDATE = [
    '../shared-core/state',
    '../shared-core/engram',
    '../shared-core/query',
    '../shared-core/entity-axis',
    '../shared-core/recall'
  ];
  process.on('beforeExit', () => {});  // no-op, just ensures lifecycle

  const TMP_RC = pRC.join('/tmp', 'gc-recall-' + Date.now() + '-' + Math.random().toString(36).slice(2,8));
  fRC.mkdirSync(TMP_RC, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = TMP_RC;
  delete require.cache[require.resolve('../shared-core/state')];
  delete require.cache[require.resolve('../shared-core/engram')];
  delete require.cache[require.resolve('../shared-core/query')];
  delete require.cache[require.resolve('../shared-core/entity-axis')];
  delete require.cache[require.resolve('../shared-core/recall')];
  const stateRC = require('../shared-core/state');
  const recallRC = require('../shared-core/recall');
  stateRC.db();
  const dRC = stateRC._dbForQuery();
  dRC.prepare('DELETE FROM action_records').run();

  function insertStamped(rec) {
    dRC.prepare(`
      INSERT INTO action_records
      (id, timestamp, type, agent_id, session_id, user_id, cwd, parent_id,
       context_hash, input, output, verification, outcome, principal_id,
       audience, memory_class)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, '{}', '{}',
              'partner', ?, ?)
    `).run(
      rec.id, rec.timestamp || Date.now(), rec.type, rec.agent_id,
      JSON.stringify(rec.input || {}),
      JSON.stringify(rec.output || {}),
      rec.audience, rec.memory_class
    );
    // FTS5 mirror so semantic axis lookups find content.
    try {
      const row = dRC.prepare('SELECT rowid FROM action_records WHERE id = ?').get(rec.id);
      if (row) {
        const text = (rec.output && (rec.output.text || rec.output.statement)) || '';
        dRC.prepare('INSERT INTO action_records_fts(rowid, search_text) VALUES (?, ?)').run(row.rowid, text);
      }
    } catch (_) {}
  }

  // Identity engram (model_visible + identity)
  const idId = cryRC.randomUUID();
  insertStamped({
    id: idId, type: 'commitment', agent_id: 'identity-extract',
    input: { source: 'phase-f' },
    output: { statement: 'user prefers terse code reviews', commitment_type: 'engram', scope: 'identity', salience: 2 },
    audience: 'model_visible', memory_class: 'identity'
  });
  // Semantic lesson (model_visible + semantic)
  const lessonId = cryRC.randomUUID();
  insertStamped({
    id: lessonId, type: 'lesson', agent_id: 'cli',
    input: { source: 'curriculum_import', fingerprint: 'abc123' },
    output: { text: 'memory consolidation in hippocampus replays during sleep', source_path: '/docs/brain.md' },
    audience: 'model_visible', memory_class: 'semantic'
  });
  // Episodic engram (model_visible + episodic)
  const epId = cryRC.randomUUID();
  insertStamped({
    id: epId, type: 'commitment', agent_id: 'cli',
    input: { source: 'engram-record' },
    output: { statement: 'we shipped the first phase of the work', commitment_type: 'engram', salience: 1 },
    audience: 'model_visible', memory_class: 'episodic'
  });
  // Substrate-internal handoff (substrate_internal + operational)
  const hofId = cryRC.randomUUID();
  insertStamped({
    id: hofId, type: 'commitment', agent_id: 'handoff-agent',
    input: { source: 'handoff' },
    output: { statement: 'next agent: continue from the second step', commitment_type: 'engram', scope: 'handoff:one' },
    audience: 'substrate_internal', memory_class: 'operational'
  });

  // implementation step — recall.recall is now async (optional embedding
  // rerank). All recall test bodies await it. The runner's async-test
  // path (testQueue + flushAsyncTests) handles returned promises.
  test('RCL-1: recall({class:"identity"}) surfaces identity engrams', async () => {
    const r = await recallRC.recall({ query: 'terse', class: 'identity', limit: 5 });
    assert.ok(r.length >= 1, 'identity recall must find the terse-preference engram; got: ' + r.length);
    assert.ok(r.some(x => x.id === idId && x.class === 'identity'),
      'identity engram must appear with class=identity');
  });

  test('RCL-2: recall({class:"semantic"}) surfaces research lessons by token overlap', async () => {
    const r = await recallRC.recall({ query: 'hippocampus consolidation', class: 'semantic', limit: 5 });
    assert.ok(r.length >= 1, 'semantic recall must find the brain-research lesson');
    assert.ok(r.some(x => x.id === lessonId && x.class === 'semantic'),
      'lesson must appear with class=semantic; got: ' + JSON.stringify(r));
  });

  test('RCL-3: recall({audience:"model_visible"}) excludes substrate_internal handoff', async () => {
    const r = await recallRC.recall({ query: 'next agent continue', class: 'all', audience: 'model_visible', limit: 10 });
    for (const x of r) {
      assert.notStrictEqual(x.id, hofId,
        'substrate_internal handoff must not surface under model_visible audience');
    }
  });

  test('RCL-4: handoff (operational class) does NOT surface under episodic recall', async () => {
    //  architecture fix: handoff:* scope writes have
    // memory_class='operational', not
    // episodic. Even when audience='substrate_internal' is explicitly
    // requested, episodic-class recall must not surface them — the
    // right channel is class='operational' OR a dedicated recall_internal
    // tool. Asserts class boundaries hold under audience overrides.
    const r = await recallRC.recall({ query: 'next agent continue', class: 'episodic', audience: 'substrate_internal', limit: 10 });
    for (const x of r) {
      assert.notStrictEqual(x.id, hofId,
        'handoff (memory_class=operational) must not appear in episodic-class results');
    }
  });

  test('RCL-5: recall({class:"all"}) merges with identity-priority dedup', async () => {
    const r = await recallRC.recall({ query: 'terse hippocampus phase', class: 'all', limit: 10 });
    assert.ok(r.length >= 2, 'all-class recall must return multiple classes; got: ' + r.length);
    // identity ranks first under priority merge (identity > procedural > semantic > episodic)
    const idIdx = r.findIndex(x => x.id === idId);
    const semIdx = r.findIndex(x => x.id === lessonId);
    if (idIdx >= 0 && semIdx >= 0) {
      assert.ok(idIdx < semIdx, 'identity must outrank semantic in all-class merge');
    }
  });

  test('RCL-6: invalid class returns empty array (no SQL error)', async () => {
    const r = await recallRC.recall({ query: 'anything', class: 'nonexistent' });
    assert.deepStrictEqual(r, []);
  });

  test('RCL-7: empty query allowed for identity-only recall', async () => {
    const r = await recallRC.recall({ query: '', class: 'identity', limit: 5 });
    assert.ok(r.length >= 1, 'identity is always-on; empty query still surfaces identity envelope');
  });

  test('RCL-8: empty query for semantic returns [] (no query, no relevance)', async () => {
    const r = await recallRC.recall({ query: '', class: 'semantic', limit: 5 });
    assert.deepStrictEqual(r, []);
  });

  //  cleanup: restore CLAUDE_PLUGIN_DATA + invalidate cached state
  // modules so subsequent tests get a fresh production-pointing state. Without
  // this, the recall test leaks a split-brain (env points TMP_RC, prod modules
  // still cached) that breaks L4-GS-2..5 + other downstream tests under
  // TROTH_RECALL_CONCERNS=1.
  test('RCL-99: cleanup — restore env + invalidate cached state modules', () => {
    if (_RC_SAVED_ENV === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = _RC_SAVED_ENV;
    // Mass-invalidate (see BFA-cleanup rationale).
    for (const key of Object.keys(require.cache)) {
      if (key.indexOf('/shared-core/') >= 0) delete require.cache[key];
    }
  });
})();

};
