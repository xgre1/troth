#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// latency-bench — measure end-to-end command turnaround through a single
// persistent troth-entity child. Confirms the Phase 7a/7b claim that
// deterministic skills resolve in <100 ms p95 once the entity is warm.
//
// Methodology:
//   1. Spawn entity (LLM=noop so the LLM-driven path runs at zero
//      transport cost — we are isolating the dispatch overhead, not the
//      model latency).
//   2. Wait for `kind:'ready'`.
//   3. For each phase {warm-up, deterministic, llm-driven, plain text}:
//        send N user_input events back-to-back
//        record (response_event_ts - send_ts) per turn
//   4. Report p50 / p95 / p99 / max per phase.
//
// p95 deterministic <100 ms is the production target. Anything above that
// means substrate write or executor overhead leaked.
const { spawn } = require('child_process');
const path = require('path');

const ENTITY = path.join(__dirname, '..', 'bin', 'troth-entity.js');
const N = 50;

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function summarise(label, samples) {
  return {
    phase: label,
    n: samples.length,
    p50: pct(samples, 0.5),
    p95: pct(samples, 0.95),
    p99: pct(samples, 0.99),
    max: samples.length ? Math.max(...samples) : 0
  };
}

(async () => {
  const child = spawn(process.execPath, [ENTITY], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: Object.assign({}, process.env, {
      TROTH_ENTITY_AGENTIC:  '1',
      TROTH_ENTITY_AGENT_ID: 'bench-' + Date.now(),
      TROTH_ENTITY_CWD:      '/tmp',
      TROTH_ENTITY_LLM:      'noop'
    })
  });

  let buf = '';
  let pendingT0 = null;
  const inflight = [];
  const phases = {
    'deterministic /goal': [],
    'deterministic /context': [],
    'llm-driven /think (noop)': [],
    'plain text (noop)': []
  };
  const phaseOrder = Object.keys(phases);
  let phaseIdx = 0;
  let phaseRemaining = 0;
  let ready = false;

  const PROMPTS = {
    'deterministic /goal':       (i) => '/goal bench iteration ' + i,
    'deterministic /context':    (_)  => '/context',
    'llm-driven /think (noop)':  (i) => '/think bench iteration ' + i,
    'plain text (noop)':         (i) => 'tell me a fact about agents (' + i + ')'
  };

  function sendOne() {
    if (phaseRemaining === 0) {
      phaseIdx++;
      if (phaseIdx >= phaseOrder.length) return finish();
      phaseRemaining = N;
    }
    const phase = phaseOrder[phaseIdx];
    const i = N - phaseRemaining;
    const text = PROMPTS[phase](i);
    pendingT0 = Date.now();
    inflight.push({ phase, t0: pendingT0 });
    child.stdin.write(JSON.stringify({
      type: 'user_input', input: { text }, options: { agentic: true }
    }) + '\n');
  }

  function finish() {
    try { child.kill(); } catch (_) {}
    const summary = phaseOrder.map((p) => summarise(p, phases[p]));
    console.log('\n=== latency-bench (LLM=noop, entity persistent) ===\n');
    for (const s of summary) {
      console.log('  ' + s.phase.padEnd(35) +
        '  n=' + s.n +
        '  p50=' + s.p50.toString().padStart(4) + 'ms' +
        '  p95=' + s.p95.toString().padStart(4) + 'ms' +
        '  p99=' + s.p99.toString().padStart(4) + 'ms' +
        '  max=' + s.max.toString().padStart(5) + 'ms');
    }
    console.log('');
    // Production target: deterministic p95 < 100 ms (Phase 7a/7b claim).
    const det = summary.filter((s) => s.phase.startsWith('deterministic'));
    const claim_holds = det.every((s) => s.p95 < 100);
    console.log(claim_holds
      ? 'CLAIM_HELD: deterministic p95 < 100ms across all measured phases'
      : 'CLAIM_FAILED: deterministic p95 exceeded 100ms');
    process.exit(claim_holds ? 0 : 1);
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.kind === 'ready') {
        ready = true;
        // Warm-up: discard the first turn from each phase's measurement.
        // Skipped here for simplicity — we treat phaseIdx starting at -1
        // and let the first 'response' bump it to 0.
        phaseIdx = 0;
        phaseRemaining = N;
        sendOne();
        continue;
      }
      if (msg.kind === 'response' && inflight.length) {
        const ent = inflight.shift();
        const dt = Date.now() - ent.t0;
        phases[ent.phase].push(dt);
        phaseRemaining--;
        sendOne();
      }
    }
  });

  setTimeout(() => {
    if (!ready) {
      console.log('BENCH_FAIL: entity never reported ready');
      try { child.kill(); } catch (_) {}
      process.exit(2);
    }
  }, 5000);
})();
