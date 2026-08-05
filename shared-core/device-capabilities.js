// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Device-capability detection for autonomy SAFETY (do not overload the user's box).
// DATA-DRIVEN: the concurrency caps come from MEASURED numbers, not guessed RAM
// tiers -
//   * true available memory  (macOS `memory_pressure` free %, NOT os.freemem which
//     lies on macOS by counting reclaimable cache as "used"),
//   * the ACTUAL local chat model size on disk (the gguf that would run),
//   * live swap usage (already-swapping = over budget).
// From those, fit how many local-inference slots actually fit, and whether local
// autonomy can run at all. FAIL-SAFE: any read failure assumes the WEAKEST case.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let _cache = null;

// Conservative safety constants (calibratable from a measured backtest later).
// They bias toward UNDER-admitting: a too-low cap costs latency, a too-high cap
// cooks the machine. We pay latency.
const OVERHEAD_GB = 3.0;        // macOS + app + KV graph baseline
const KV_PER_SLOT_GB = 1.0;     // per concurrent inference sequence (7B-class, moderate ctx)

function _sh(cmd, args) {
  try { return execFileSync(cmd, args, { timeout: 1500 }).toString(); } catch (_) { return ''; }
}

// TRUE available memory in GB. os.freemem() on macOS reports only wired+active and
// calls reclaimable file cache "used", so it massively understates free RAM
// (observed 3% reported when 70% was actually free). Use memory_pressure free %.
function _availableGb(totalGb) {
  const out = _sh('memory_pressure', []);
  const m = out.match(/free percentage:\s*(\d+)%/i);
  if (m) {
    const pct = parseInt(m[1], 10);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return (pct / 100) * totalGb;
  }
  return os.freemem() / 1e9; // pessimistic fallback (never over-admits -> safe)
}

function _swapUsedMb() {
  const out = _sh('sysctl', ['-n', 'vm.swapusage']);
  const m = out.match(/used\s*=\s*([\d.]+)M/i);
  return m ? parseFloat(m[1]) : 0;
}

function _perfCores(logical) {
  const out = _sh('sysctl', ['-n', 'hw.perflevel0.logicalcpu']).trim();
  const n = parseInt(out, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return Math.max(1, Math.floor(logical / 2));
}

// Largest CHAT gguf the machine would actually load (exclude embedding/reranker
// models - they are not the autonomy worker model).
function _localChatModelGb(modelsDir) {
  try {
    const dir = modelsDir || path.join(os.homedir(), '.troth', 'models');
    const files = fs.readdirSync(dir).filter(function (f) { return /\.gguf$/i.test(f); });
    let maxBytes = 0;
    for (const f of files) {
      if (/embed|rerank|bge|gemma-300|minilm/i.test(f)) continue; // not chat models
      const sz = fs.statSync(path.join(dir, f)).size;
      if (sz > maxBytes) maxBytes = sz;
    }
    return maxBytes / 1e9;
  } catch (_) { return 0; }
}

function detectCapabilities(opts) {
  if (_cache && !(opts && opts.fresh)) return _cache;
  let caps;
  try {
    const totalGb = os.totalmem() / 1e9;
    const cores = os.cpus().length;
    const platform = os.platform();
    const isAppleSilicon = platform === 'darwin' && os.arch() === 'arm64';
    const perfCores = platform === 'darwin' ? _perfCores(cores) : Math.max(1, Math.floor(cores / 2));

    const availGb = (opts && typeof opts.availGbOverride === 'number') ? opts.availGbOverride : _availableGb(totalGb);
    const swapMb = (opts && typeof opts.swapMbOverride === 'number') ? opts.swapMbOverride : _swapUsedMb();
    const modelGb = (opts && typeof opts.modelGbOverride === 'number') ? opts.modelGbOverride : _localChatModelGb(opts && opts.modelsDir);

    // MEASURED local-inference fit: how many model+KV slots fit in available RAM.
    // No local chat model present -> localFit 0 (nothing to run locally).
    let localFit = 0;
    if (modelGb > 0) {
      localFit = Math.floor((availGb - OVERHEAD_GB) / (modelGb + KV_PER_SLOT_GB));
      if (!Number.isFinite(localFit) || localFit < 0) localFit = 0;
    }
    if (swapMb > 1024) localFit = 0; // already swapping hard => over budget

    const maxLocalParallel = Math.max(0, Math.min(localFit, perfCores));
    const localCanRun = maxLocalParallel >= 1;
    const maxWorkerParallel = Math.max(1, Math.floor(perfCores / 2)); // process cap

    let tier;
    if (!localCanRun) tier = 'constrained';
    else if (maxLocalParallel >= 4) tier = 'workstation';
    else tier = 'standard';

    caps = {
      ramGb: Math.round(totalGb * 10) / 10,
      availGb: Math.round(availGb * 10) / 10,
      swapMb,
      localModelGb: Math.round(modelGb * 10) / 10,
      cores, perfCores, isAppleSilicon,
      tier,
      localCanRun,
      maxLocalParallel,
      maxWorkerParallel,
      localShouldLead: localCanRun && tier !== 'constrained',
      detected: true,
      basis: 'measured: avail=' + Math.round(availGb) + 'GB, model=' + (Math.round(modelGb * 10) / 10) + 'GB, swap=' + swapMb + 'MB -> fits ' + maxLocalParallel + ' local slot(s)'
    };
  } catch (e) {
    caps = { // FAIL-CLOSED: weakest case, never over-admit
      ramGb: null, availGb: null, swapMb: null, localModelGb: null,
      cores: 1, perfCores: 1, isAppleSilicon: false,
      tier: 'constrained', localCanRun: false,
      maxLocalParallel: 0, maxWorkerParallel: 1, localShouldLead: false,
      detected: false, error: String((e && e.message) || e)
    };
  }
  _cache = caps;
  return caps;
}

module.exports = { detectCapabilities };
