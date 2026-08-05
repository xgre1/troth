// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// S1 — Substrate-as-subject. No substrate-native module imports a COGNITIVE
// LLM transport directly; only the sanctioned faculty seam (faculty.js) may.
// Census-based; prints offenders so faculty workstream has an explicit migration target.
//
// What counts as a "cognitive LLM transport": anything under shared-core/
// transports/ (anthropic.js, llamacpp.js, ollama.js, codex-oauth.js,
// router.js, subprocess-cli.js) — these produce tokens the substrate would
// then have to react to.
//
// What does NOT count: shared-core/transport-config.js. transport-config is
// a pure CONFIG layer — its exports are { get, llamacppHost, embeddingHost,
// snapshot, … } (no request method). Importing it to read an env var or an
// embedding-host URL does not make a module an LLM-loop-driver. Treating
// transport-config imports as thesis violations conflated "reads config"
// with "calls the LLM" and falsely flagged 12 substrate-native modules
// (auto-engram, recall, background-worker embedding_backfill, etc.) that
// only ever read host strings.
const fs = require('fs');
const path = require('path');

const SHARED = path.join(__dirname, '..', '..', 'shared-core');
// Sanctioned to import cognitive transports directly: the faculty seam and
// the transports dir itself (the router stitches them).
const SANCTIONED = new Set([
  'faculty.js',
]);
const TRANSPORT_RE = /require\(['"]\.\/transports\/|require\(['"]\.\/transports['"]/;

module.exports = {
  id: 'S1',
  title: 'Substrate-as-subject (LLM is not the loop driver)',
  expect: 'pass',
  owedBy: 'faculty workstream (route every cognitive wake through faculty.wake)',
  run() {
    let files = [];
    try { files = fs.readdirSync(SHARED).filter(f => f.endsWith('.js')); }
    catch (e) { return { pass: false, detail: 'cannot read shared-core: ' + e.message }; }
    const offenders = [];
    for (const f of files) {
      if (SANCTIONED.has(f)) continue;
      let src = '';
      try { src = fs.readFileSync(path.join(SHARED, f), 'utf8'); } catch (_) { continue; }
      if (TRANSPORT_RE.test(src)) offenders.push(f);
    }
    if (!offenders.length) return { pass: true, detail: 'no substrate-native module imports a transport directly' };
    return {
      pass: false,
      detail: `${offenders.length} module(s) import a transport directly: ${offenders.join(', ')} — migrate behind faculty.wake`,
    };
  },
};
