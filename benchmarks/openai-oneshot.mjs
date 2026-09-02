#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// openai-oneshot — one prompt in (stdin), one answer out (stdout), through any
// OpenAI-compatible chat endpoint (OpenRouter by default). The key is read
// from the environment of the process that runs the harness and never
// written anywhere by it. Same one-process-per-call shape as the other lanes.
//   TROTH_OAI_HOST        default https://openrouter.ai/api/v1
//   TROTH_OAI_MODEL       required (e.g. z-ai/glm-5.2:free)
//   TROTH_OAI_KEY_ENV     name of the env var holding the key (default OPENROUTER_API_KEY)
//   TROTH_OAI_TIMEOUT_MS  default 180000
const HOST = (process.env.TROTH_OAI_HOST || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const MODEL = process.env.TROTH_OAI_MODEL || '';
const KEY = process.env[process.env.TROTH_OAI_KEY_ENV || 'OPENROUTER_API_KEY'] || '';
const TIMEOUT_MS = parseInt(process.env.TROTH_OAI_TIMEOUT_MS || '180000', 10);
const SYSTEM = 'Follow the instruction exactly. Output only what is asked, no preamble.';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  if (!MODEL) { process.stderr.write('openai-oneshot: TROTH_OAI_MODEL is required'); process.exit(2); }
  if (!KEY) { process.stderr.write('openai-oneshot: no key in the environment'); process.exit(2); }
  // One retry on transport-class failures and on the endpoint's own
  // rate-limit answer; a bad reply is never retried.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(HOST + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + KEY, 'x-title': 'troth longmemeval' },
        body: JSON.stringify({
          model: MODEL, temperature: 0, max_tokens: 2048, stream: false,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: input }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 15000)); continue; }
      if (res.status !== 200) { process.stderr.write('openai-oneshot HTTP ' + res.status + ': ' + text.slice(0, 400)); process.exit(1); }
      const j = JSON.parse(text);
      const msg = j && j.choices && j.choices[0] && j.choices[0].message;
      const out = (msg && msg.content) || '';
      if (!out.trim() && attempt === 0) continue;
      process.stdout.write(out);
      process.exit(0);
    } catch (e) {
      if (attempt === 0) continue;
      process.stderr.write('openai-oneshot error: ' + (e && e.message || String(e)));
      process.exit(1);
    }
  }
  process.stderr.write('openai-oneshot: empty reply twice');
  process.exit(1);
});
