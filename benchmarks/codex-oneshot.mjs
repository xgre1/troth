#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// codex-oneshot — one prompt in (stdin), one answer out (stdout), through the
// ChatGPT Responses endpoint (shared-core/transports/codex-oauth.js). Lets the
// LongMemEval harness route compose+judge to that model instead of `claude -p`,
// so the two arms can be graded by different families. Keeps the harness's
// synchronous spawn shape: one process per call, same as claude -p.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const codex = require(path.join(process.cwd(), 'shared-core', 'transports', 'codex-oauth.js'));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  try {
    const tx = codex.makeCodexOAuthTransport({});
    const stream = await tx.stream({
      system: 'Follow the instruction exactly. Output only what is asked, no preamble.',
      user: input,
    });
    let out = '';
    for await (const ch of stream) {
      if (ch && ch.delta) out += ch.delta;
      if (ch && ch.done) break;
    }
    process.stdout.write(out);
    process.exit(0);
  } catch (e) {
    process.stderr.write('codex-oneshot error: ' + (e && e.message || String(e)));
    process.exit(1);
  }
});
