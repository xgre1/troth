// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// suite-22: STRUCTURAL outbound secret redaction (R17 hard wall). Live find
// a pane received a fresh secret in a Supabase tool result and
// pasted it into the chat, telling the operator to place it manually. The
// prompt-level SECRETS rule (suite-21) is steering; THIS is the wall: a
// secret-shaped literal that transits a tool result cannot reach reply text.
// Pins:
//   (1) harvest+redact for every credential shape we claim to catch;
//   (2) precision: git hashes / uuids / plain prose are NEVER masked;
//   (3) end-to-end through the REAL composeAgentic: a stub faculty echoes a
//       tool-result secret and the final text arrives masked;
//   (4) the marker never contains the secret and no em-dash rides authored text.
const assert = require('assert');
const redactor = require('../shared-core/secret-redactor.js');

module.exports = function run({ test }) {
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.4jX9kPbrxYzq2mVwFhL8nQ3tRcU7oWaSdEgHi01MZyA';

  test('REDACT-1: supabase-style service_role JWT in a tool result is harvested and masked in reply text', () => {
    redactor._resetForTests();
    redactor.harvest(JSON.stringify({ ok: true, service_role: JWT }));
    const reply = 'Here is your key: ' + JWT + ' - paste it into the dashboard.';
    const out = redactor.redact(reply);
    assert(out.indexOf(JWT) === -1, 'the JWT must not survive redaction');
    assert(out.includes(redactor.MARKER), 'the withheld marker must appear');
  });

  test('REDACT-2: known prefixes (sk-, ghp_, AKIA, xoxb-, sbp_) are caught', () => {
    redactor._resetForTests();
    const secrets = [
      'sk-proj-Abc123Def456Ghi789Jkl012',
      'ghp_abcdefghijklmnopqrstuv0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijkl',
      'sbp_0123456789abcdef0123456789abcdef'
    ];
    redactor.harvest('tool output: ' + secrets.join(' , '));
    for (const s of secrets) {
      const out = redactor.redact('echoing ' + s + ' back');
      assert(out.indexOf(s) === -1, s.slice(0, 6) + '... must be masked; got ' + JSON.stringify(out));
    }
  });

  test('REDACT-3: credential-named fields (.env / JSON) and URL passwords are caught', () => {
    redactor._resetForTests();
    redactor.harvest('SUPABASE_API_KEY=verysecretvalue123\n{"client_secret": "another_secret_98765"}\npostgres://admin:hunter2pass@db.host:5432/app');
    assert(redactor.redact('key is verysecretvalue123').indexOf('verysecretvalue123') === -1, '.env value masked');
    assert(redactor.redact('use another_secret_98765').indexOf('another_secret_98765') === -1, 'json field masked');
    assert(redactor.redact('pw: hunter2pass').indexOf('hunter2pass') === -1, 'url password masked');
  });

  test('REDACT-4: PRECISION - git hashes, uuids, prose, vault refs are NEVER masked', () => {
    redactor._resetForTests();
    redactor.harvest('commit 3f2c9e14ab7d5e6f8a90b1c2d3e4f5a6b7c8d9e0 fixed the bug\n' +
      'id: 550e8400-e29b-41d4-a716-446655440000\n' +
      'TOKEN=$vault:SUPABASE_KEY\n' +
      'password: <placeholder>');
    const echo = 'commit 3f2c9e14ab7d5e6f8a90b1c2d3e4f5a6b7c8d9e0 and id 550e8400-e29b-41d4-a716-446655440000 and $vault:SUPABASE_KEY';
    assert.strictEqual(redactor.redact(echo), echo, 'benign literals must pass untouched');
  });

  // Source code assigns identifiers to credential-NAMED constants, and the
  // pair matcher sees the same shape as a config line. Masking one would blank
  // an ordinary word everywhere for the life of the process, inside code read
  // back as if it were the file. A credential value is a literal, never an
  // identifier this same text declares, calls, or reaches through a dot.
  test('REDACT-7: PRECISION - code that assigns to credential-NAMED constants harvests nothing', () => {
    redactor._resetForTests();
    const code = [
      "const MAX_TOKENS = parseInt(process.env.TROTH_BENCH_LOCAL_MAX_TOKENS || '6144', 10);",
      'const qTokens = qLow.split(/[^a-z]+/u);',
      'body: JSON.stringify({ max_tokens: MAX_TOKENS, temperature: 0 })',
      'const apiKey = resolveCredential(name);'
    ].join('\n');
    assert.strictEqual(redactor.harvest(code), 0, 'ordinary code carries no secrets');
    const echo = 'MAX_TOKENS was raised, parseInt is used, qLow.split tokenises, resolveCredential resolves';
    assert.strictEqual(redactor.redact(echo), echo, 'and none of those words may ever be masked');
  });

  test('REDACT-8: a real credential beside that code is still caught', () => {
    redactor._resetForTests();
    redactor.harvest("const MAX_TOKENS = parseInt(x, 10);\nAPI_KEY=verysecretvalue123\n");
    assert(redactor.redact('key is verysecretvalue123').indexOf('verysecretvalue123') === -1,
      'the literal credential is still harvested when code sits beside it');
    assert.strictEqual(redactor.redact('parseInt is fine'), 'parseInt is fine');
  });

  test('REDACT-5: PEM private-key block is masked whole', () => {
    redactor._resetForTests();
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh\nAAOCAQ8AMIIBCgKC\n-----END PRIVATE KEY-----';
    redactor.harvest('here: ' + pem);
    const out = redactor.redact('the key was ' + pem + ' ok');
    assert(out.indexOf('MIIEvQIBADANBgkqh') === -1, 'PEM body must not survive');
  });

  test('REDACT-6: E2E through the REAL composeAgentic - echoed tool-result secret arrives masked in final text', async () => {
    redactor._resetForTests();
    const { makeOrchestrator } = require('../shared-core/llm-orchestrator.js');
    const SECRET = 'sk-proj-LiveFindSecret1234567890abcd';
    let call = 0;
    const transport = {
      stream(req) {
        call++;
        const chunks = [];
        if (call === 1) {
          chunks.push({ tool_calls: [{ id: 't1', type: 'function', function: { name: 'mcp_call', arguments: '{}' } }] });
          chunks.push({ done: true });
        } else {
          chunks.push({ delta: 'Your new key is ' + SECRET + ' - save it somewhere safe.' });
          chunks.push({ done: true });
        }
        let i = 0;
        return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }; },
                 [Symbol.asyncIterator]() { return this; } };
      }
    };
    const orch = makeOrchestrator({ transport, faculty_label: 'stub' });
    const res = await orch.composeAgentic(
      { kind: 'chat', content: 'rotate my key', options: { tools: [{ type: 'function', function: { name: 'mcp_call', parameters: { type: 'object' } } }] } },
      { tool_runner: async () => JSON.stringify({ created: true, api_key: SECRET }) }
    );
    assert(res && typeof res.text === 'string' && res.text.length, 'turn must produce text');
    assert(res.text.indexOf(SECRET) === -1, 'the secret must NOT reach final text; got ' + JSON.stringify(res.text));
    assert(res.text.includes(redactor.MARKER), 'the withheld marker must appear in final text');
  });

  test('REDACT-7: marker is secret-free and em-dash-free', () => {
    assert(!/—/.test(redactor.MARKER), 'no em-dash in the marker');
    assert(redactor.MARKER.length < 120, 'marker stays short');
  });
};
