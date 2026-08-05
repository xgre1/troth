#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// llamacpp-oneshot — one prompt in (stdin JSON {prompt, boost}), one answer out,
// via the LOCAL llama.cpp transport WITH substrate decode-time constraints
// (compliance_boost_strings biases token sampling toward the retrieved memory).
// This is the second LongMemEval arm: same retrieval + same judge as the codex
// arm, but the ANSWER is produced by the local model with the decode-time
// mechanism the hosted/MCP path structurally cannot use (operator ask,
//). Isolates "local llama.cpp + decode bias" vs "cloud model".
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
const { makeLlamaCppTransport } = require(path.join(process.cwd(), 'shared-core', 'transports', 'llamacpp.js'));

const HOST = process.env.TROTH_LLAMACPP_HOST || 'http://localhost:1234';
const BOOST_AMT = parseFloat(process.env.TROTH_BENCH_BOOST || '3');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let payload;
  try { payload = JSON.parse(input); } catch { payload = { prompt: input, boost: [] }; }
  const boost = Array.isArray(payload.boost) ? payload.boost.filter(Boolean).slice(0, 40) : [];
  try {
    const tx = makeLlamaCppTransport({ host: HOST });
    const stream = await tx.stream({
      system: 'Answer using ONLY the provided memory statements. Be concise. If they do not contain the answer, say "unknown".',
      user: payload.prompt || '',
      options: {
        substrate_decode_constraints: {
          compliance_boost_strings: boost,
          compliance_boost_amount: BOOST_AMT,
          cache_prompt: true,
        },
      },
    });
    let out = '';
    for await (const ch of stream) {
      if (ch && ch.delta) out += ch.delta;
      if (ch && ch.done) break;
    }
    process.stdout.write(out.trim());
    process.exit(0);
  } catch (e) {
    process.stderr.write('llamacpp-oneshot error: ' + (e && e.message || String(e)));
    process.exit(1);
  }
});
