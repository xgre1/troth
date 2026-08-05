#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// bin/reflect.js — manual CLI invocation of the memory reflector.
//
// Per v1 spec: NO background heartbeat (implementation step v2 feature). Operator
// runs this when they want to consolidate recent memories into reflected
// assertions. State.db backup is mandatory before any write.
//
// Usage:
//   node bin/reflect.js --dry-run              # plan only, no LLM call, no writes
//   node bin/reflect.js                        # full run (backup → LLM → write)
//   node bin/reflect.js --window 100           # smaller candidate window
//   node bin/reflect.js --max-clusters 3       # cap reflections per run
//
// Defaults match shared-core/reflector.js DEFAULTS (Park 2023 + A-MEM grounded).

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const reflector = require(path.join(__dirname, '..', 'shared-core', 'reflector.js'));
const transportCfg = require(path.join(__dirname, '..', 'shared-core', 'transport-config.js'));

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const val = process.argv[idx + 1];
  return val !== undefined ? val : true;
}

const DRY = process.argv.includes('--dry-run');
const WINDOW = parseInt(arg('--window', '200'), 10);
const MAX_CLUSTERS = parseInt(arg('--max-clusters', '5'), 10);

// LLM call wrapper — uses transport-config's default chat endpoint.
// For v1 we use whatever default the substrate has configured (router /
// anthropic / local). Cross-family enforcement is v2 work — for v1 single
// model.
async function llmCall(prompt) {
  // transport-config doesn't expose a dedicated chatHost — use the
  // llamacpp endpoint (local OpenAI-shape) as default v1 reflector
  // target. v1.1 will route through proxy with cross-family enforcement
  // per the reflection design.
  const host = (typeof transportCfg.chatHost === 'function' && transportCfg.chatHost())
    || (typeof transportCfg.llamacppHost === 'function' && transportCfg.llamacppHost());
  if (!host) throw new Error('no LLM chat host configured (transport-config exposes neither chatHost nor llamacppHost)');
  // POST to host/v1/chat/completions in OpenAI shape. Most local llama.cpp
  // and the troth proxy speak this.
  const url = new URL('/v1/chat/completions', host);
  const body = JSON.stringify({
    model: 'reflector',  // proxy / router will route; local backends ignore
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 2000,
    stream: false
  });
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('reflector_llm_timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== reflect.js — memory consolidation run ===');
  console.log('Mode: ' + (DRY ? 'DRY-RUN (no writes)' : 'COMMIT (will write)'));

  if (!DRY) {
    // Mandatory backup before any destructive write
    try {
      const dbPath = path.join(process.env.HOME, '.troth', 'state.db');
      if (fs.existsSync(dbPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        // Backups live NEXT TO the db (multi-user /tmp leaked the whole memory
        // DB to other macOS accounts — portability audit).
        const backupDir = path.join(path.dirname(dbPath), 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, 'state.db.pre-reflect-' + stamp);
        execSync('cp ' + JSON.stringify(dbPath) + ' ' + JSON.stringify(backupPath), { stdio: 'pipe' });
        console.log('BACKUP=' + backupPath);
      }
    } catch (e) {
      console.error('Backup failed (aborting): ' + (e && e.message || e));
      process.exit(2);
    }
  }

  const opts = {
    dry_run: DRY,
    window_size: WINDOW,
    max_clusters_per_run: MAX_CLUSTERS,
    llmCall: DRY
      ? async () => ''  // dry-run: LLM never called, but reflector requires the function
      : llmCall
  };

  console.log('Window=' + WINDOW + '  MaxClusters=' + MAX_CLUSTERS);
  const res = await reflector.runReflection(opts);
  console.log('\n--- Result ---');
  console.log(JSON.stringify({
    ok: res.ok,
    activity_id: res.activity_id,
    candidates_seen: res.candidates_seen,
    clusters_seen: res.clusters_seen,
    clusters_selected: res.clusters_selected,
    clusters_emitted: res.clusters_emitted,
    rejected_count: res.rejected_count
  }, null, 2));
  if (res.rejected_count) {
    console.log('\nRejected:');
    res.rejected.forEach((r, i) => console.log('  [' + i + '] ' + JSON.stringify(r).slice(0, 200)));
  }
  if (Array.isArray(res.written) && res.written.length) {
    console.log('\nWritten:');
    res.written.forEach((w, i) => {
      if (w.dry_run) {
        console.log('  [' + i + '] DRY: cluster_size=' + w.cluster_size + ' prompt: ' + w.prompt_preview.slice(0, 120) + '…');
      } else {
        console.log('  [' + i + '] id=' + w.id + ' conf=' + w.confidence + ' assert: ' + String(w.assertion).slice(0, 120));
        if (w.warnings && w.warnings.length) {
          w.warnings.forEach(wn => console.log('       warn: ' + wn.code + (wn.value !== undefined ? '=' + wn.value : '')));
        }
      }
    });
  }
  process.exit(res.ok ? 0 : 1);
}

main().catch(e => {
  console.error('reflect.js threw: ' + (e && e.stack || e));
  process.exit(3);
});
