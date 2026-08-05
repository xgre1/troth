#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// bin/ingest-openapi.js — operator CLI for OpenAPI ingest.
//
// Usage:
//   node bin/ingest-openapi.js --spec ./openapi.json --service supabase
//   node bin/ingest-openapi.js --spec ./gh.json --service github --agent my-agent
//
// Substrate is append-only. Re-ingesting the same service produces parallel
// chunks; to replace, delete the existing scope via /forget-scope before
// re-ingesting. A state.db backup is taken before every write.

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const openapiIngest = require(path.join(__dirname, '..', 'shared-core', 'openapi-ingest.js'));

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const val = process.argv[idx + 1];
  return val !== undefined ? val : true;
}

const SPEC_PATH = arg('--spec', null);
const SERVICE   = arg('--service', null);
const AGENT     = arg('--agent', 'openapi-ingest');
const CWD_ARG   = arg('--cwd', null);
const DRY       = process.argv.includes('--dry-run');

if (!SPEC_PATH || !SERVICE) {
  console.error('Usage: ingest-openapi.js --spec <path.json> --service <name> [--agent <id>] [--cwd <path>] [--dry-run]');
  process.exit(2);
}

async function main() {
  console.log('=== ingest-openapi.js ===');
  console.log('Spec:    ' + SPEC_PATH);
  console.log('Service: ' + SERVICE);
  console.log('Agent:   ' + AGENT);
  console.log('Mode:    ' + (DRY ? 'DRY-RUN (parse only, no writes)' : 'COMMIT'));

  let raw;
  try { raw = fs.readFileSync(SPEC_PATH, 'utf8'); }
  catch (e) { console.error('Cannot read spec: ' + (e && e.message || e)); process.exit(2); }

  let spec;
  try { spec = JSON.parse(raw); }
  catch (e) {
    console.error('JSON parse failed. If this is YAML, convert first (e.g. `swagger-cli bundle -t json`).');
    console.error('Detail: ' + (e && e.message || e));
    process.exit(2);
  }

  const chunks = openapiIngest.buildChunks(spec);
  console.log('Parsed operations: ' + chunks.length);
  if (chunks.length === 0) {
    console.error('No operations parsed — wrong OpenAPI shape? Need 3.x.');
    process.exit(2);
  }

  if (DRY) {
    console.log('\n--- First 3 chunks preview ---');
    chunks.slice(0, 3).forEach((c, i) => {
      console.log('\n[' + (i + 1) + '] ' + c.operationId);
      console.log(c.text.slice(0, 400));
    });
    process.exit(0);
  }

  // Backup
  try {
    const dbPath = path.join(process.env.HOME, '.troth', 'state.db');
    if (fs.existsSync(dbPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Backups live NEXT TO the db (multi-user /tmp leaked the whole memory
        // DB to other macOS accounts — portability audit).
        const backupDir = path.join(path.dirname(dbPath), 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, 'state.db.pre-openapi-' + stamp);
      execSync('cp ' + JSON.stringify(dbPath) + ' ' + JSON.stringify(backupPath), { stdio: 'pipe' });
      console.log('BACKUP=' + backupPath);
    }
  } catch (e) {
    console.error('Backup failed (aborting): ' + (e && e.message || e));
    process.exit(2);
  }

  const res = await openapiIngest.ingestOpenAPI({
    spec,
    service:   SERVICE,
    agent_id:  AGENT,
    cwd:       CWD_ARG || null
  });

  console.log('\n--- Result ---');
  console.log(JSON.stringify({
    ok:         res.ok,
    scope:      res.scope,
    operations: res.operations,
    chunks:     res.chunks,
    recorded:   res.recorded,
    embedded:   res.embedded,
    error:      res.error || null
  }, null, 2));

  process.exit(res.ok ? 0 : 1);
}

main().catch(e => {
  console.error('ingest-openapi.js threw: ' + (e && e.stack || e));
  process.exit(3);
});
