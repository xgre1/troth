#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// llamacpp-oneshot — one prompt in (stdin JSON {prompt, boost}), one answer out,
// via the local llama.cpp server's raw chat endpoint. This is the second
// LongMemEval arm: same retrieval + same judge as the hosted arm, but the
// ANSWER is produced by the local model. Deliberately mirrors the judge's
// call shape (temp 0, thinking off, bounded tokens, non-stream): that path
// is the one proven stable against the same server, and determinism is a
// property the hosted claude -p arm cannot offer.
// NOTE: the boost field is accepted for interface compatibility but not
// sent — a vanilla llama-server silently ignores unknown decode fields, so
// sending them would only pretend a mechanism was active that is not.

const HOST = process.env.TROTH_LLAMACPP_HOST || 'http://localhost:1234';
const MAX_TOKENS = parseInt(process.env.TROTH_BENCH_LOCAL_MAX_TOKENS || '6144', 10);
const TIMEOUT_MS = parseInt(process.env.TROTH_BENCH_LOCAL_TIMEOUT_MS || '240000', 10);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let payload;
  try { payload = JSON.parse(input); } catch { payload = { prompt: input }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(HOST + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Follow the instructions in the user message exactly, including any final Answer: line format they ask for.' },
          { role: 'user', content: payload.prompt || '' }
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS,
        stream: false,
        chat_template_kwargs: { enable_thinking: false }
      })
    });
    if (!res.ok) {
      process.stderr.write('llamacpp http ' + res.status + ': ' + (await res.text()).slice(0, 300));
      process.exit(1);
    }
    const j = await res.json();
    const out = j && j.choices && j.choices[0] && j.choices[0].message
      ? String(j.choices[0].message.content || '')
      : '';
    if (!out.trim()) {
      process.stderr.write('llamacpp empty completion');
      process.exit(1);
    }
    process.stdout.write(out);
    process.exit(0);
  } catch (e) {
    process.stderr.write('llamacpp fetch error: ' + String(e && e.message || e).slice(0, 300));
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
});
