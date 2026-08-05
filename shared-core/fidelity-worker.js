// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Detached out-of-band fidelity critic worker (Claude Code host). Spawned by the Stop
// hook AFTER the turn completes: zero latency, not bound by the 10s Stop budget. Reads
// a job file, delegates to fidelity-run.runAndRecord (shared with the app entity), then
// deletes the job file. WARN-first: never blocks.
//
// Usage: node fidelity-worker.js <jobfile.json>
// jobfile: { turnText, toolSequence, cwd, sessionId, producerModel, project,
//            clientWork, _testVerdict? }  (_testVerdict is a test-only stub)
const fs = require('fs');

// Load ~/.troth/.env into process.env so the router can backfill provider keys.
// The worker is a bare node process spawned by the hook; nothing else loads .env.
try {
  const _os = require('os'), _path = require('path');
  const _env = fs.readFileSync(_path.join(_os.homedir(), '.troth', '.env'), 'utf8');
  _env.split('\n').forEach(function (line) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch (_) {}

(async function main() {
  const jobPath = process.argv[2];
  let job = null;
  try { job = JSON.parse(fs.readFileSync(jobPath, 'utf8')); } catch (_) { process.exit(0); }
  function cleanup() { try { fs.unlinkSync(jobPath); } catch (_) {} }
  try {
    const fidelityRun = require(__dirname + '/fidelity-run.js');
    const judge = (typeof job._testVerdict === 'string')
      ? (async function () { return job._testVerdict; })
      : undefined;
    await fidelityRun.runAndRecord({
      turnText: job.turnText, toolSequence: job.toolSequence, cwd: job.cwd,
      sessionId: job.sessionId, producerModel: job.producerModel,
      project: job.project, clientWork: job.clientWork, judge: judge
    });
  } catch (_) { /* never throw */ } finally {
    cleanup();
    process.exit(0);
  }
})();
