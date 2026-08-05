// SPDX-License-Identifier: AGPL-3.0-only
// Server Lifecycle — substrate-driven llama-server invocation.
//
// Substrate produces decode-time artefacts (control vectors, future
// LoRA adapters) that llama-server applies via startup flags. Until
// now the operator has had to restart the server by hand. This module
// composes the canonical invocation for the current substrate state
// and (optionally) spawns it.
//
// Two modes:
//   - `composeCommand({...})` — pure: returns {bin, args, command_string}
//     for the operator to run themselves. Always available.
//   - `restartLocal({...})` — actually kills and respawns a local
//     llama-server process, then waits for /health=ok. Use only when
//     the substrate is co-located with the server (e.g., dev box).
//     Remote servers (e.g. over Tailscale / SSH) should consume the
//     composed command via the operator's own remote-exec workflow.
//
// Substrate-aware: caller passes the latest control_vector_path,
// lora_path, slot_save_path, etc., and the module formats them with
// the same per-flag conventions the rest of the codebase uses.

const { spawn } = require('child_process');
const http      = require('http');
const { URL }   = require('url');

const cfg          = require('./transport-config.js');

function composeCommand(opts) {
  opts = opts || {};
  const bin       = opts.bin       || 'llama-server';
  const modelPath = opts.model_path;
  if (!modelPath) throw new Error('server-lifecycle: model_path required');

  const port = opts.port || 11436;
  // SECURE DEFAULT: loopback. This is the LOCAL-only lifecycle (docs: "local-only,
  // no remote SSH") and llama-server has NO auth — binding 0.0.0.0 silently
  // exposed the operator's personal model to the whole LAN (this was observed
  // in the wild). A caller that genuinely wants to serve the LAN must opt
  // in EXPLICITLY with bind_host:'0.0.0.0'. Fail closed.
  const host = opts.bind_host || '127.0.0.1';
  const ctx  = opts.context_size || 4096;
  const ngl  = opts.ngl != null ? opts.ngl : 999;

  const args = [
    '-m', modelPath,
    '--port', String(port),
    '--host', host,
    '-c', String(ctx),
    '-ngl', String(ngl),
    '--jinja',
    // Route Qwen3/DeepSeek-R1 <think>…</think> into delta.reasoning_content
    // instead of dumping it into delta.content. Without this flag, recent
    // builds emit the entire chain-of-thought as user-facing text — the
    // model appears to monologue its planning instead of acting. Transport
    // also has a defensive <think> stripper as a fallback for builds where
    // the template doesn't honor this flag.
    '--reasoning-format', 'deepseek',
    '--embeddings',
    // KV-cache reuse for SHIFTED prefixes. Without this, only an EXACT
    // prefix match reuses the KV cache — any prefix shift (identity
    // envelope / dialogue window sliding) re-prefills the whole prompt
    //.
    // 256 = min chunk size (tokens) llama-server attempts to reuse via
    // KV shifting. Chat server only — embedder/reranker don't need it.
    '--cache-reuse', '256'
  ];

  const slotPath = opts.slot_save_path || cfg.slotSavePath();
  if (slotPath) args.push('--slot-save-path', slotPath);

  // Substrate decode-time artefacts. Each is optional; substrate may
  // have produced any subset. control_vector_path takes precedence
  // over control_vector_scaled (distinct flag forms).
  if (opts.control_vector_scaled) {
    // {path, scale}
    args.push('--control-vector-scaled', opts.control_vector_scaled.path + ':' + opts.control_vector_scaled.scale);
  } else if (opts.control_vector_path) {
    args.push('--control-vector', opts.control_vector_path);
  }

  // LoRA adapter (single or scaled). When training pipeline produces
  // a `.gguf` adapter, substrate flags it here for the next restart.
  if (opts.lora_scaled) {
    // {path, scale}
    args.push('--lora-scaled', opts.lora_scaled.path, String(opts.lora_scaled.scale));
  } else if (opts.lora_path) {
    args.push('--lora', opts.lora_path);
  }

  if (Array.isArray(opts.extra_args)) {
    for (const a of opts.extra_args) args.push(String(a));
  }

  // Pre-quote args that have shell-meaningful chars so the
  // command_string copy-pastes safely. Best-effort, not bullet-proof.
  function shQuote(s) {
    s = String(s);
    if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  const command_string = [bin, ...args].map(shQuote).join(' ');

  return { bin, args, command_string };
}

// Wait for /health to flip to ok. Returns true on success, false on
// timeout. Pure read — no side effects.
// last-use stamp — lets the proxy's idle reaper tell "busy" from "abandoned".
// See shared-core/local-reranker.js for why: detached children here have no
// exit path of their own, so something long-lived has to retire them.
function _touchUse(port) {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    const dir = path.join(os.homedir(), '.troth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lastuse-' + port + '.txt'), String(Date.now()));
  } catch (_) {}
}

function waitForHealth(opts) {
  _touchUse(opts.port || 11436);
  opts = opts || {};
  const probeUrl  = opts.url || ('http://127.0.0.1:' + (opts.port || 11436) + '/health');
  const timeoutMs = opts.timeout_ms || 90000;
  const intervalMs = opts.interval_ms || 1000;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    function probe() {
      try {
        const u = new URL(probeUrl);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 3000 }, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(buf);
              if (j && j.status === 'ok') { resolve(true); return; }
            } catch (_) {}
            if (Date.now() > deadline) resolve(false);
            else setTimeout(probe, intervalMs);
          });
        });
        req.on('error', () => {
          if (Date.now() > deadline) resolve(false);
          else setTimeout(probe, intervalMs);
        });
        req.end();
      } catch (_) {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(probe, intervalMs);
      }
    }
    probe();
  });
}

// Local-only restart: spawns the composed command in a detached
// child, optionally killing any existing match first. Returns
// {ok, pid, command_string, ready_after_ms}. Substrate-as-orchestrator
// callers (e.g., the entity daemon when it has root over its server)
// can drive their own continuous-improvement loop via this API.
async function restartLocal(opts) {
  opts = opts || {};
  const cmd = composeCommand(opts);
  // llama-server refuses to start if --slot-save-path points at a non-existent
  // directory ("error: not a directory"). composeCommand always passes the
  // flag (cfg.slotSavePath() default /tmp/llama-slots), so ensure it exists
  // before spawning — otherwise the server dies instantly and health never goes
  // ok.
  try {
    const slotPath = opts.slot_save_path || cfg.slotSavePath();
    if (slotPath) require('fs').mkdirSync(slotPath, { recursive: true });
  } catch (_) { /* best-effort; spawn will surface the real error if it matters */ }
  // Best-effort kill of an existing process on the same port. We don't
  // assume any specific PID file — the substrate's contract is just
  // "the new server should be the one answering on this port".
  if (opts.kill_existing !== false) {
    try {
      const { execSync } = require('child_process');
      execSync('pkill -f "llama-server.*' + (opts.port || 11436) + '" || true', { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 500));
    } catch (_) { /* best-effort */ }
  }
  // Honest fast-fail when the port is held by something we did NOT kill (a
  // foreign process: the pkill above is llama-server-scoped on purpose).
  // Without this, the spawn fails to bind and the only surfaced error was a
  // generic health timeout after 90s.
  {
    const port = opts.port || 11436;
    // Retry the bind probe: our own just-SIGTERM'd server can hold the socket
    // past the 500ms grace under load, and a single probe misread it as a
    // FOREIGN process. ~2s of retries
    // separates "dying, let go" from "someone else lives here".
    const tryBind = () => new Promise((resolve) => {
      const s = require('net').createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '127.0.0.1');
    });
    let free = false;
    for (let i = 0; i < 4 && !free; i++) {
      free = await tryBind();
      if (!free) await new Promise(r => setTimeout(r, 500));
    }
    if (!free) {
      return {
        ok: false,
        pid: null,
        command_string: cmd.command_string,
        ready_after_ms: null,
        error: 'port ' + port + ' is already in use by another process — stop it or set a different port'
      };
    }
  }
  const t0 = Date.now();
  // Linux has no @loader_path: llama-server ships libllama-common.so.0 and
  // friends beside itself, and the loader will not look in the executable's
  // own directory unless told. macOS resolves this through rpath and is
  // unaffected; setting the variable there is harmless.
  const _binDir = require('path').dirname(cmd.bin);
  const _env = Object.assign({}, process.env, {
    LD_LIBRARY_PATH: _binDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '')
  });
  const child = spawn(cmd.bin, cmd.args, {
    detached: true,
    env:      _env,
    stdio:    opts.log_path
      ? [ 'ignore', require('fs').openSync(opts.log_path, 'a'), require('fs').openSync(opts.log_path, 'a') ]
      : [ 'ignore', 'ignore', 'ignore' ]
  });
  child.unref();
  // Race health against an immediate child death (bad flags, missing dylib,
  // corrupt model): a dead server can never turn healthy, so waiting the
  // full health window on it was a silent 90s tax.
  const died = new Promise((resolve) => child.once('exit', () => setTimeout(() => resolve('__died'), 300)));
  const ready = await Promise.race([
    waitForHealth({ port: opts.port || 11436, timeout_ms: opts.health_timeout_ms || 90000 }),
    died
  ]);
  if (ready === '__died') {
    return {
      ok: false,
      pid: child.pid,
      command_string: cmd.command_string,
      ready_after_ms: null,
      error: 'llama-server exited immediately' + (opts.log_path ? ' — see ' + opts.log_path : '')
    };
  }
  return {
    ok:              !!ready,
    pid:             child.pid,
    command_string:  cmd.command_string,
    ready_after_ms:  ready ? (Date.now() - t0) : null,
    error:           ready ? null : 'health probe timeout'
  };
}

module.exports = {
  composeCommand,
  waitForHealth,
  restartLocal
};
