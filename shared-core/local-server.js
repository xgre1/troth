// SPDX-License-Identifier: AGPL-3.0-only
// Local-server lifecycle for the "Automatic" local tier.
//
//  this REPLACES the bespoke in-process chat (local-chat.js's
// complete()/local-inprocess transport) for the chat path. That island
// re-prefilled the full ~9.6K-token prefix (identity + ~37 tool schemas) every
// turn → ~47s for "hi", and bypassed the whole proven stack (cache_prompt,
// decode-constraints/STVC, transport-config, cost.js).
//
// Instead the Automatic tier now rides the SAME path as Custom/remote-server:
// a bundled `llama-server` (vendored at ~/.troth/bin/llama-server) running the
// device-picked GGUF, driven through shared-core/transports/llamacpp.js. That
// transport sends cache_prompt:true, so llama-server reuses the KV prefix
// across turns (partial-prefix match even when the system tail changes) —
// measured 47s→0.4s on the same 7B. STVC grammar/logit_bias, slot save/restore
// (kv-state), and cost accounting all come for free from the existing path.
//
// ensure() is idempotent: a no-op when the server is already healthy on the
// port. Returns false (caller degrades) when the binary or model isn't present.

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const serverLifecycle = require('./server-lifecycle.js');

const HOME       = process.env.HOME || os.homedir();
const PORT       = parseInt(process.env.TROTH_LOCAL_SERVER_PORT || '11436', 10);
const BIN        = process.env.TROTH_LLAMA_SERVER_BIN
  || path.join(HOME, '.troth', 'bin', 'llama-server');
// BOTH model locations: the shipped app's "Use on my Mac" downloader writes
// to ~/.troth/desktop/models, the npm/open path and older installs use
// ~/.troth/models. Reading only one cost real users their local tier
// entirely. TROTH_CHAT_DIR still overrides.
const MODELS_DIRS = process.env.TROTH_CHAT_DIR
  ? [process.env.TROTH_CHAT_DIR]
  : [
      path.join(HOME, '.troth', 'desktop', 'models'),
      path.join(HOME, '.troth', 'models'),
    ];
// TROTH_CHAT_CTX is the operator's override. Unset, the size comes from the
// model and the machine rather than a constant that is wrong for both: a fixed
// number throws away most of a modern window, and on a small machine reserves
// a KV cache that does not fit. llama.cpp allocates the whole cache at startup,
// so this is spent the moment the server comes up.
const CTX_OVERRIDE = parseInt(process.env.TROTH_CHAT_CTX || '0', 10) || 0;
function contextSizeFor(modelPath) {
  try {
    const chosen = require('./model-context.js').chooseContextSize(modelPath, { explicit: CTX_OVERRIDE });
    try {
      console.error('[local-server] context ' + chosen.size +
        ' (' + chosen.source + (chosen.trained ? ', model trained for ' + chosen.trained : '') + ')');
    } catch (_) {}
    return chosen.size;
  } catch (_) {
    return CTX_OVERRIDE || 16384;
  }
}
const LOG_PATH   = path.join(HOME, '.troth', 'desktop', 'local-llama-server.log');

// Explicit model override tokens (TROTH_CHAT_MODEL, Custom/BYO). The old
// hardcoded RAM-tier tokens (Qwen2.5 Q4_K_M) matched a model family the
// product no longer downloads, so a user's real download never resolved
//. Serving "what the user actually installed" is
// the contract now; the env override remains for pinning.
function pickModelTokens() {
  if (process.env.TROTH_CHAT_MODEL) {
    return String(process.env.TROTH_CHAT_MODEL).toLowerCase()
      .split(/[^a-z0-9]+/).filter((t) => t && t !== 'hf' && t !== 'gguf');
  }
  return [];
}

// Resolve the on-disk .gguf to serve, across BOTH model dirs (skip .ipull/
// .part partials and embed/rerank models that live beside chat models).
// Preference: TROTH_CHAT_MODEL token match (honest null when pinned but
// absent) → largest chat .gguf present (chat models dwarf everything else;
// deterministic, and matches whatever the UI downloaded).
function resolveModelPath() {
  const found = [];
  for (const dir of MODELS_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      const lc = f.toLowerCase();
      if (!lc.endsWith('.gguf')) continue;
      if (/embed|rerank|bge/.test(lc)) continue; // never serve the recall organs as chat
      const p = path.join(dir, f);
      let size = 0;
      try { size = fs.statSync(p).size; } catch (_) { continue; }
      found.push({ p, n: lc.replace(/[^a-z0-9]/g, ''), size });
    }
  }
  if (!found.length) return null;
  // GGUF split families (...-00002-of-00003.gguf) must be loaded via part 1;
  // llama.cpp refuses the other parts. Collapse each family to its first
  // part carrying the family's COMBINED size, so the largest-pick weighs the
  // whole model and can never hand llama-server a non-first part (the 122B
  // Automatic tier downloads as a 3-part split.
  const splitFams = new Map();
  const pickable = [];
  for (const m of found) {
    const sp = m.p.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
    if (!sp) { pickable.push(m); continue; }
    const key = sp[1] + '-of-' + sp[3];
    const fam = splitFams.get(key) || { first: null, size: 0 };
    fam.size += m.size;
    if (parseInt(sp[2], 10) === 1) fam.first = m;
    splitFams.set(key, fam);
  }
  for (const fam of splitFams.values()) {
    if (fam.first) pickable.push({ p: fam.first.p, n: fam.first.n, size: fam.size });
  }
  if (!pickable.length) return null; // only orphan non-first split parts on disk
  const want = pickModelTokens();
  if (want.length) {
    const hit = pickable.find((m) => want.every((t) => m.n.includes(t)));
    return hit ? hit.p : null; // pinned but not on disk: honest miss, no surprise model
  }
  pickable.sort((a, b) => b.size - a.size);
  return pickable[0].p;
}

function healthOk(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: timeoutMs || 1500 },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try { resolve(!!(JSON.parse(buf) || {}).status && JSON.parse(buf).status === 'ok'); }
          catch (_) { resolve(false); }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    req.end();
  });
}

// ── On-demand binary fetch (the SHIP path for other users) ──────────────────
// The app ships as an npm package + GUI shell and downloads models on demand to
// ~/.troth/models; the llama-server binary follows the SAME model — fetched once
// from a PINNED official llama.cpp release to ~/.troth/bin (not bundled, so it
// matches the user's arch and keeps the app small). Downloaded binaries are
// quarantined by Gatekeeper, so we strip the xattr + ad-hoc sign so they run.
// b9957: first pin past the GLM-5.2 loader fix (b9736, #24770)
// and the DeepSeek V4 CSA+HCA merge (#24162, ~06-29), so the top Automatic
// tiers can actually load. b9664 could not load either family.
const LLAMACPP_RELEASE = process.env.TROTH_LLAMACPP_RELEASE || 'b9957';
// Sidecar recording WHICH release the vendored binary came from, so a pin
// bump upgrades existing installs (the old existence-only check kept b9664
// forever on any machine that had ever fetched it).
const BIN_RELEASE_FILE = path.join(path.dirname(BIN), '.llamacpp-release');
const _https = require('https');
const { execFileSync } = require('child_process');

function _downloadFollow(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, depth) => {
      if (depth > 6) { reject(new Error('too many redirects')); return; }
      _https.get(u, { headers: { 'user-agent': 'troth' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); get(res.headers.location, depth + 1); return;
        }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(true)));
      }).on('error', reject);
    };
    get(url, 0);
  });
}

let _binPromise = null;
// Ensure ~/.troth/bin/llama-server exists; download+prepare the pinned release if
// not. arm64 only (Intel Macs degrade to BYOK per the onboarding recommendation).
async function ensureBinary() {
  if (process.env.TROTH_LLAMA_SERVER_BIN) return fs.existsSync(BIN); // explicit path, don't fetch
  // README promises TROTH_NO_MODEL_FETCH=1 suppresses ALL model AND binary
  // downloads (CI, metered networks, servers). local-embedder and
  // local-reranker honoured it; this path, the one that pulls a ~100 MB
  // llama.cpp release, did not. An already-present binary is still usable:
  // the flag forbids fetching, not running what is on disk.
  const noFetch = process.env.TROTH_NO_MODEL_FETCH === '1';
  if (fs.existsSync(BIN)) {
    // Version-aware: only trust an existing binary when its recorded release
    // matches the pin. Missing/other sidecar = stale (legacy installs never
    // wrote one) -> refresh from the pinned official release.
    try {
      if (fs.readFileSync(BIN_RELEASE_FILE, 'utf8').trim() === LLAMACPP_RELEASE) return true;
    } catch (_) {}
  }
  // A release that was already PROVEN unrunnable here is remembered, or the
  // failure is not a failure but a loop: the callers retry on 5- and 10-minute
  // backoffs and ensure() has none at all, so a glibc-too-old machine would
  // re-download the tarball and re-copy ~35 libraries every few minutes for as
  // long as troth runs. Bumping the pin retries naturally, and
  // TROTH_LLAMA_SERVER_BIN still overrides everything.
  try {
    if (!fs.existsSync(BIN) &&
        fs.readFileSync(BIN_RELEASE_FILE, 'utf8').trim() === LLAMACPP_RELEASE + ' unrunnable') {
      if (!_unrunnableLogged) {
        try { console.error('[local-server] llama-server ' + LLAMACPP_RELEASE +
          ' was already found unrunnable on this system — not re-fetching. ' +
          'Set TROTH_LLAMA_SERVER_BIN to your own build to enable the local server.'); } catch (_) {}
        _unrunnableLogged = true;
      }
      return false;
    }
  } catch (_) { /* no sidecar = never tried */ }
  // Which official asset fits THIS machine — resolved per platform, never
  // hard-coded to macOS-arm64: a single-platform download tells every Linux
  // box and Intel Mac the local stack is unavailable — no reranking, no bundled chat
  // server, and (before the doctor fix) a claim of semantic recall that
  // nothing could serve. The gate existed for a real reason: an earlier
  // version checked arch but not platform, so a Linux arm64 machine unpacked a
  // Mach-O binary and died at spawn with a bare ENOEXEC. The fix is to pick
  // the right asset per platform, not to refuse every platform but one.
  // Names verified against the b9957 release listing; ubuntu-arm64,
  // ubuntu-x64 and macos-x64 all ship llama-server.
  const _plat =
    process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64')
    : process.platform === 'linux' ? (process.arch === 'arm64' ? 'ubuntu-arm64'
                                    : process.arch === 'x64' ? 'ubuntu-x64' : null)
    : null;   // Windows ships .zip, which this tar-based path cannot unpack
  if (!_plat) return fs.existsSync(BIN);
  if (noFetch) {
    if (!_noFetchLogged) {
      try { console.error('[local-server] TROTH_NO_MODEL_FETCH=1 — not fetching llama-server. ' +
        'Point TROTH_LLAMA_SERVER_BIN at your own binary, or unset the flag.'); } catch (_) {}
      _noFetchLogged = true;
    }
    return fs.existsSync(BIN);
  }
  if (_binPromise) return _binPromise;
  _binPromise = (async () => {
    const asset = 'llama-' + LLAMACPP_RELEASE + '-bin-' + _plat + '.tar.gz';
    const url = 'https://github.com/ggml-org/llama.cpp/releases/download/' + LLAMACPP_RELEASE + '/' + asset;
    const binDir = path.dirname(BIN);
    fs.mkdirSync(binDir, { recursive: true });
    const tmpTar = path.join(os.tmpdir(), asset);
    const exDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'troth-llamacpp-'));
    try {
      try { console.error('[local-server] fetching llama-server ' + LLAMACPP_RELEASE + '…'); } catch (_) {}
      await _downloadFollow(url, tmpTar);
      execFileSync('tar', ['xzf', tmpTar, '-C', exDir]);
      // The tarball nests files under llama-<rel>/ — copy llama-server and
      // every shared library next to it.
      //
      // The pattern has to accept VERSIONED sonames. macOS ships
      // libllama.dylib and the old /\.(dylib|so)$/ matched it, but the Linux
      // build ships libllama-common.so.0 — which that pattern misses, so the
      // binary landed without its libraries and died at exec with
      // "error while loading shared libraries". Co-location alone is also not
      // enough on Linux (no @loader_path equivalent), so every spawn sets
      // LD_LIBRARY_PATH to this directory.
      let found = null;
      (function walk(d) {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          const st = fs.statSync(p);
          if (st.isDirectory()) { walk(p); continue; }
          if (f === 'llama-server') found = p;
          if (f === 'llama-server' || /\.(dylib|so)(\.\d+)*$/.test(f)) {
            // Atomic rename-swap: an UPGRADE can land while an old server
            // (e.g. the embedder) is running; writing over an executing
            // image corrupts it, a rename leaves the old inode alive.
            const dst = path.join(binDir, f);
            fs.copyFileSync(p, dst + '.new');
            fs.renameSync(dst + '.new', dst);
          }
        }
      })(exDir);
      if (!found) return false;
      fs.chmodSync(BIN, 0o755);
      // macOS only: strip the Gatekeeper quarantine flag and ad-hoc sign, so a
      // freshly-downloaded binary is allowed to execute locally without
      // notarization. Neither tool exists on Linux, and both are already
      // wrapped in try/catch, but skipping them keeps the intent readable.
      if (process.platform === 'darwin') {
        try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', binDir]); } catch (_) {}
        try { execFileSync('codesign', ['--force', '--sign', '-', BIN]); } catch (_) {}
      }
      // Prove it can actually execute before claiming success. The official
      // Linux builds are compiled on Ubuntu 24.04 and need glibc 2.38+, so on
      // Debian bookworm, Ubuntu 22.04 and anything older the download
      // succeeds and every later spawn dies with "version GLIBC_2.38 not
      // found" — a broken binary sitting on disk looking installed, which is
      // worse than none. One --version run settles it; on failure the files
      // go and the reason is named, so the operator can build llama.cpp and
      // point TROTH_LLAMA_SERVER_BIN at it instead of guessing.
      try {
        execFileSync(BIN, ['--version'], {
          // stderr PIPED, not ignored: the dynamic loader writes the actual
          // reason there ("version `GLIBC_2.38' not found"), and with
          // stdio:'ignore' e.stderr is null — so the log could only ever say
          // "Command failed", which is useless to whoever has to act on it.
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 20000,
          env: Object.assign({}, process.env, {
            LD_LIBRARY_PATH: binDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '')
          })
        });
      } catch (e) {
        const raw = String((e && e.stderr) || '').trim() || String((e && e.message) || e);
        const why = raw.split('\n')[0].slice(0, 200);
        try {
          console.error('[local-server] the official llama-server build for ' + _plat +
            ' will not run on this system: ' + why);
          console.error('[local-server] build llama.cpp yourself and set TROTH_LLAMA_SERVER_BIN to it ' +
            '(the memory model still works without this binary).');
        } catch (_) {}
        // Remove the whole unusable payload, not just the executable: the
        // ~35 copied shared objects are dead weight (hundreds of MB) once the
        // binary they belong to is gone.
        try { fs.rmSync(BIN, { force: true }); } catch (_) {}
        try {
          for (const f of fs.readdirSync(binDir)) {
            if (/\.(dylib|so)(\.\d+)*$/.test(f)) fs.rmSync(path.join(binDir, f), { force: true });
          }
        } catch (_) {}
        // Durable marker so this is attempted ONCE per pinned release.
        try { fs.writeFileSync(BIN_RELEASE_FILE, LLAMACPP_RELEASE + ' unrunnable\n'); } catch (_) {}
        return false;
      }
      try { fs.writeFileSync(BIN_RELEASE_FILE, LLAMACPP_RELEASE + '\n'); } catch (_) {}
      return fs.existsSync(BIN);
    } catch (e) {
      try { console.error('[local-server] llama-server fetch failed: ' + (e && e.message || e)); } catch (_) {}
      return false;
    } finally {
      try { fs.rmSync(tmpTar, { force: true }); } catch (_) {}
      try { fs.rmSync(exDir, { recursive: true, force: true }); } catch (_) {}
    }
  })().finally(() => { _binPromise = null; });
  return _binPromise;
}

let _ensurePromise = null;
let _unavailableLogged = false;
let _noFetchLogged = false;
// Said once per process when a release is already known unrunnable here — the
// callers ask on 5- and 10-minute backoffs and would otherwise repeat it all day.
let _unrunnableLogged = false;

// Ensure a healthy local llama-server on PORT. Idempotent + concurrency-safe.
// Returns true when the server is up (so the llamacpp transport can be used),
// false when we can't run it (missing binary / model not downloaded) — caller
// degrades to another faculty rather than hanging.
async function ensure() {
  if (await healthOk()) return true;
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    // Fetch the binary on first use (the ship path) if it isn't present yet.
    if (!fs.existsSync(BIN)) {
      const got = await ensureBinary();
      if (!got) {
        if (!_unavailableLogged) { try { console.error('[local-server] llama-server unavailable (not on disk and could not fetch — Intel Mac? offline?)'); } catch (_) {} _unavailableLogged = true; }
        return false;
      }
    }
    const modelPath = resolveModelPath();
    if (!modelPath) {
      if (!_unavailableLogged) { try { console.error('[local-server] no local chat model found in ' + MODELS_DIRS.join(' or ') + ' — download one in Settings, or set TROTH_CHAT_MODEL'); } catch (_) {} _unavailableLogged = true; }
      return false;
    }
    try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch (_) {}
    try {
      const r = await serverLifecycle.restartLocal({
        bin:           BIN,
        model_path:    modelPath,
        port:          PORT,
        // Bundled Automatic local server = THIS Mac only. Bind loopback so the
        // operator's personal model is never exposed to LAN/Tailscale (no auth).
        bind_host:     '127.0.0.1',
        context_size:  contextSizeFor(modelPath),
        ngl:           999,
        log_path:      LOG_PATH,
        kill_existing: true
      });
      if (!r.ok) { try { console.error('[local-server] llama-server failed health: ' + (r.error || '?')); } catch (_) {} }
      return !!r.ok;
    } catch (e) {
      try { console.error('[local-server] spawn failed: ' + (e && e.message || e)); } catch (_) {}
      return false;
    }
  })().finally(() => { _ensurePromise = null; });
  return _ensurePromise;
}

module.exports = { ensure, ensureBinary, resolveModelPath, healthOk, downloadFollow: _downloadFollow, PORT, BIN };
