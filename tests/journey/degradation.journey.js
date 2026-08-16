// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A tier that dies must die of something real.
//
// The embedding server tier was dead for a whole release because the code that
// spawned it referenced a variable that was out of scope. The exception was
// caught by the fallback, recorded as "spawn failed", and everything carried
// on quietly one tier lower. Nothing measured it, so nothing noticed.
//
// A missing binary, a refused connection, an absent model: those are
// environment, and falling back is the right answer. A ReferenceError or a
// TypeError is a defect in this repository, and it must never be laundered
// through a fallback path into a slower answer.
module.exports.describe = 'a failed tier names an environment cause, never a programming one';

const PROGRAMMING_ERROR = /\b(ReferenceError|TypeError|SyntaxError|is not defined|is not a function|Cannot read propert)/;

module.exports.run = async (ctx, check) => {
  // The spawn path must actually be REACHED. With no binary the code bails
  // three lines before the spawn, so a probe run that way proves nothing — it
  // passed cleanly with the original defect put back, which is how this
  // scenario learned to distrust itself. A stand-in binary and a file named
  // like the model get the walk all the way to the spawn, where the defect was.
  const fsx = require('fs');
  const pathx = require('path');
  const binDir = pathx.join(ctx.home, '.troth', 'bin');
  const modelDir = pathx.join(ctx.home, '.troth', 'models');
  fsx.mkdirSync(binDir, { recursive: true });
  fsx.mkdirSync(modelDir, { recursive: true });
  const fakeBin = pathx.join(binDir, 'llama-server');
  // It must survive the --version probe, or the walk stops one step short of
  // the spawn and the scenario proves nothing again.
  fsx.writeFileSync(fakeBin, '#!/bin/sh\ncase "$1" in --version) echo "version: journey stand-in"; exit 0;; esac\nexit 1\n');
  try { fsx.chmodSync(fakeBin, 0o755); } catch (_) {}
  // Named so the embedder resolver recognises it; the contents never matter,
  // because the stand-in binary exits before reading anything.
  fsx.writeFileSync(pathx.join(modelDir, 'hf_ggml-org_embeddinggemma-300M.Q8_0.gguf'), 'not a model');

  const probe = `
    const emb = require(${JSON.stringify(require('path').join(ctx.root, 'shared-core', 'local-embedder.js'))});
    (async () => {
      let vec = null;
      try { vec = await emb.embed('degradation probe', { wait: true }); } catch (e) {
        console.log(JSON.stringify({ threw: String(e && e.stack || e) }));
        return;
      }
      const st = emb.status();
      console.log(JSON.stringify({
        dims: vec ? vec.length : null,
        dead: !!st.emb_server_dead,
        why: st.emb_server_last_error == null ? null : String(st.emb_server_last_error),
        unavailable: !!st.unavailable,
      }));
    })();
  `;
  const r = await ctx.cli(['--version'], {});           // warms nothing; keeps ctx honest
  void r;

  const { execFileSync } = require('child_process');
  let out = '';
  try {
    out = execFileSync(ctx.NODE, ['-e', probe], {
      encoding: 'utf8', timeout: 120000,
      env: Object.assign({}, process.env, {
        HOME: ctx.home,
        TROTH_LLAMA_SERVER_BIN: require('path').join(ctx.home, '.troth', 'bin', 'llama-server'),
        TROTH_NO_MODEL_FETCH: '1',
        // A port of its own. _ensureEmbServer asks the health endpoint first,
        // so an embed server already running on this machine answered and the
        // spawn — the only place the defect lived — was never reached. The
        // scenario was borrowing somebody else's server and calling it proof.
        TROTH_EMBED_PORT: String(21400 + (process.pid % 400)),
      }),
    });
  } catch (e) { out = String((e && e.stdout) || '') + String((e && e.stderr) || ''); }

  const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
  let st = {};
  try { st = JSON.parse(line); } catch (_) { st = { parse: line.slice(0, 160) }; }

  check('asking for an embedding never throws out of the module',
    !st.threw, String(st.threw || '').split('\n').slice(0, 2).join(' | '));

  check('a tier that declined says why in words that name the environment',
    !st.why || !PROGRAMMING_ERROR.test(st.why),
    'the reason given was a programming error: ' + String(st.why));

  // And the whole surface, from the outside: whatever the proxy reports about
  // the local stack must not be a swallowed exception either.
  const proxy = await ctx.proxy();
  const local = await proxy.get('/api/setup/local');
  const body = local.body || '';
  check('the local-stack report is free of programming errors',
    !PROGRAMMING_ERROR.test(body),
    (body.match(PROGRAMMING_ERROR) || [''])[0] + ' in /api/setup/local');

  const embStatus = await proxy.get('/api/embed/status');
  check('the embedder report is free of programming errors',
    !PROGRAMMING_ERROR.test(embStatus.body || ''),
    (String(embStatus.body).match(PROGRAMMING_ERROR) || [''])[0] + ' in /api/embed/status');

  check('the proxy log carries no swallowed programming error',
    !PROGRAMMING_ERROR.test(proxy.log()),
    (proxy.log().match(PROGRAMMING_ERROR) || [''])[0] + ' in the boot log');
};
