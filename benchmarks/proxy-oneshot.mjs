#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// proxy-oneshot — one prompt in (stdin), one answer out (stdout), through the
// operator's own troth proxy (/v1/messages, Anthropic shape). The proxy holds
// the credentials and picks the engine (routing pin / lane); this process
// never sees a key or a token. Same one-process-per-call shape as
// codex-oneshot / claude -p, so the harness loop is unchanged.
//   TROTH_PROXY_HOST        default http://127.0.0.1:8000
//   TROTH_PROXY_MODEL       model id sent in the request (default gpt-5.5)
//   TROTH_PROXY_TIMEOUT_MS  default 180000
const HOST = (process.env.TROTH_PROXY_HOST || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const MODEL = process.env.TROTH_PROXY_MODEL || 'gpt-5.5';
const TIMEOUT_MS = parseInt(process.env.TROTH_PROXY_TIMEOUT_MS || '180000', 10);
const SYSTEM = 'Follow the instruction exactly. Output only what is asked, no preamble.';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  try {
    // The prompt rides the system field and the user turn is a short trigger:
    // the proxy's planning step keys off a long user message, and a bench
    // prompt must reach the engine as written, with nothing planned into it.
    const body = {
      model: MODEL,
      max_tokens: 2048,
      stream: false,
      system: SYSTEM + '\n\n' + input,
      messages: [{ role: 'user', content: 'Respond now, following the instructions above exactly.' }],
    };
    // A rate-limited or momentarily unreachable lane answers 429, 5xx, or 400
    // with the lane's own reason; two waits and two retries, then the
    // failure is reported. A bad reply is never retried.
    let res, text;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(HOST + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-troth-source': 'longmemeval-harness', 'x-troth-raw': '1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
      const transient = res.status === 429 || res.status === 502 || res.status === 503
        || (res.status === 400 && /rate limit|unreachable|network error|unavailable|errored repeatedly/i.test(text));
      if (attempt < 2 && transient) {
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      break;
    }
    if (res.status !== 200) {
      process.stderr.write('proxy-oneshot HTTP ' + res.status + ': ' + text.slice(0, 600));
      process.exit(1);
    }
    const j = JSON.parse(text);
    const out = (Array.isArray(j.content) ? j.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('');
    process.stdout.write(out);
    process.exit(0);
  } catch (e) {
    process.stderr.write('proxy-oneshot error: ' + (e && e.message || String(e)));
    process.exit(1);
  }
});
