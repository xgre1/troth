#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// bin/sweep-commitments.js — manual / cron CLI for the commitment drift
// sweeper (the autonomy layer).
//
// Pulls open commitments older than --min-age-hours, asks the configured
// critic LLM to judge each as fulfilled/retracted/active/drifted, and
// writes status markers per typed-commitment.js semantics.
//
// State.db backup mandatory before any write (a hard operator rule).
//
// Usage:
//   node bin/sweep-commitments.js --dry-run
//   node bin/sweep-commitments.js
//   node bin/sweep-commitments.js --max-batch 5 --min-age-hours 2
//   node bin/sweep-commitments.js --critic-model gpt-4o
//
// Cron suggestion (every 30 min):
//   */30 * * * * node <repo>/bin/sweep-commitments.js >> ~/.troth/sweep.log 2>&1
//
// Cross-family: pass --critic-family to enforce structural difference
// from --judge-family. Default leaves family_constraint='any' (caller
// trusts model id semantics) — recommend setting both in cron config.

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const tc = require(path.join(__dirname, '..', 'shared-core', 'typed-commitment.js'));
const transportCfg = require(path.join(__dirname, '..', 'shared-core', 'transport-config.js'));

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const val = process.argv[idx + 1];
  return val !== undefined ? val : true;
}

const DRY            = process.argv.includes('--dry-run');
const MAX_BATCH      = parseInt(arg('--max-batch', '10'), 10);
const MIN_AGE_HOURS  = parseFloat(arg('--min-age-hours', '1'));
const CRITIC_MODEL   = arg('--critic-model', 'critic');
const CRITIC_FAMILY  = arg('--critic-family', null);
const JUDGE_FAMILY   = arg('--judge-family', null);

function makeLlmCall() {
  const host = (typeof transportCfg.chatHost === 'function' && transportCfg.chatHost())
    || (typeof transportCfg.llamacppHost === 'function' && transportCfg.llamacppHost());
  if (!host) throw new Error('no LLM chat host configured');
  return async function llmCall(prompt) {
    const url = new URL('/v1/chat/completions', host);
    const body = JSON.stringify({
      model: CRITIC_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0,
      max_tokens: 800,
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
      req.on('timeout', () => { req.destroy(); reject(new Error('sweep_llm_timeout')); });
      req.write(body);
      req.end();
    });
  };
}

async function main() {
  console.log('=== sweep-commitments.js — drift judge run ===');
  console.log('Mode: ' + (DRY ? 'DRY-RUN (no writes)' : 'COMMIT (will write markers)'));

  if (!DRY) {
    try {
      const dbPath = process.env.TROTH_DATA_DIR
        ? path.join(process.env.TROTH_DATA_DIR, 'state.db')
        : path.join(process.env.HOME, '.troth', 'state.db');
      if (fs.existsSync(dbPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        // Backups live NEXT TO the db (multi-user /tmp leaked the whole memory
        // DB to other macOS accounts — portability audit).
        const backupDir = path.join(path.dirname(dbPath), 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, 'state.db.pre-sweep-' + stamp);
        execSync('cp ' + JSON.stringify(dbPath) + ' ' + JSON.stringify(backupPath), { stdio: 'pipe' });
        console.log('BACKUP=' + backupPath);
      }
    } catch (e) {
      console.error('Backup failed (aborting): ' + (e && e.message || e));
      process.exit(2);
    }
  }

  const llmCall = DRY
    ? async () => '{"verdict":"active","why":"dry-run noop","confidence":0.0}'
    : makeLlmCall();

  console.log('MaxBatch=' + MAX_BATCH + '  MinAgeHours=' + MIN_AGE_HOURS +
              '  CriticModel=' + CRITIC_MODEL +
              (JUDGE_FAMILY && CRITIC_FAMILY ? '  Families=' + JUDGE_FAMILY + '/' + CRITIC_FAMILY : ''));

  const res = await tc.sweepCommitments({
    llmCall,
    max_batch: MAX_BATCH,
    min_age_ms: MIN_AGE_HOURS * 60 * 60 * 1000,
    judge_family:  JUDGE_FAMILY  || undefined,
    critic_family: CRITIC_FAMILY || undefined
  });

  console.log('\n--- Result ---');
  console.log(JSON.stringify({
    ok: res.ok,
    error: res.error || null,
    total_open: res.total_open,
    batch_size: res.batch_size,
    judged_count: (res.judged || []).length,
    skipped_count: (res.skipped || []).length
  }, null, 2));

  if (res.judged && res.judged.length) {
    console.log('\nJudged:');
    res.judged.forEach((j, i) => {
      console.log('  [' + i + '] id=' + j.id + ' verdict=' + j.verdict +
                  ' conf=' + (j.confidence || '?') +
                  ' evidence=' + j.evidence_count);
      if (j.why) console.log('       why: ' + j.why);
    });
  }
  if (res.skipped && res.skipped.length) {
    console.log('\nSkipped:');
    res.skipped.forEach((s, i) => console.log('  [' + i + '] id=' + (s.id || '?') + ' reason=' + s.reason));
  }
  process.exit(res.ok ? 0 : 1);
}

main().catch(e => {
  console.error('sweep-commitments.js threw: ' + (e && e.stack || e));
  process.exit(3);
});
