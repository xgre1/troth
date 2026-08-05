#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Seed substrate refusal records (commitment_type='refusal' with RPL
// predicates) so the refusal wall has something to enforce structurally.
//
// Before this script: the substrate has 0 refusal records → the
// evaluator runs but always returns 'proceed' → "safety" actually lives in
// prompt-text rules at proxy/prompts/* (hard walls beat soft
// instructions; prompt-injected pages bypass system prompts).
//
// After this script: a starter set of refusals exists, scoped
// 'hard-invariant'. The refusal evaluator checks every
// tool call against them BEFORE the call leaves for the LLM faculty.
//
// Idempotent: writes use stable statement text so re-running won't dup
// (engram.recordEngram auto_verify catches duplicates).
//
// Usage:
//   node scripts/seed-refusals.js                # plan + write (with backup)
//   node scripts/seed-refusals.js --dry-run      # plan only
//   node scripts/seed-refusals.js --list         # show currently-active refusals
//
// Pre-backup state.db is taken at /tmp/state.db.pre-seed-refusals-<ISO>.

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const engram = require(path.join(__dirname, '..', 'shared-core', 'engram.js'));
const state  = require(path.join(__dirname, '..', 'shared-core', 'state.js'));

const DRY = process.argv.includes('--dry-run');
const LIST = process.argv.includes('--list');

// Refusal seed set — categorized per refusal-taxonomy.js.
// Each entry carries a `category` from HARD_CATEGORIES / SOFT_CATEGORIES
// so audit views and operator-UI can group + filter. Pattern kind v1 ships;
// tool_class + rate_limit also covered in v1 (B redesign). Semantic kind
// deferred to v2 (needs cheap-classifier choice).
//
// Adding new seeds: append to this array with proper category + predicate.
// Script is idempotent (skip-if-statement-present) so re-run on extend.
const SEED = [
  // ── DESTRUCTIVE_FILESYSTEM ─────────────────────────────────────────────
  {
    category:  'DESTRUCTIVE_FILESYSTEM',
    statement: 'no destructive rm -rf on absolute paths outside the project sandbox',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-rf|-fr)\\s+/',
      action: 'reject',
      reason: 'rm -rf on absolute path requires operator approval (prompt-injection risk)'
    }
  },
  {
    category:  'DESTRUCTIVE_FILESYSTEM',
    statement: 'no writes to ~/.ssh or ~/.aws credentials directories',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.file_path',
      regex: '(^|/)\\.ssh/|(^|/)\\.aws/(?!config$)',
      action: 'reject',
      reason: 'writing to ~/.ssh or ~/.aws credentials is destructive of secrets'
    }
  },

  // ── DESTRUCTIVE_VCS ────────────────────────────────────────────────────
  {
    category:  'DESTRUCTIVE_VCS',
    statement: 'no force-push to git remotes',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: 'git\\s+push\\s+(--force|-f)\\b',
      action: 'escalate_to_operator',
      reason: 'force-push rewrites history; requires explicit operator OK'
    }
  },
  {
    category:  'DESTRUCTIVE_VCS',
    statement: 'no git reset --hard against remote tracking branches',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: 'git\\s+reset\\s+--hard\\s+origin/',
      action: 'escalate_to_operator',
      reason: 'hard reset to remote discards local commits irreversibly'
    }
  },

  // ── DESTRUCTIVE_DATA ───────────────────────────────────────────────────
  {
    category:  'DESTRUCTIVE_DATA',
    statement: 'no DROP TABLE / TRUNCATE on any database',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: '\\b(DROP\\s+TABLE|TRUNCATE\\s+TABLE)\\b',
      flags: 'i',
      action: 'reject',
      reason: 'destructive SQL on any table requires explicit confirm'
    }
  },
  {
    category:  'DESTRUCTIVE_DATA',
    statement: 'no DROP DATABASE / DROP SCHEMA',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: '\\b(DROP\\s+DATABASE|DROP\\s+SCHEMA)\\b',
      flags: 'i',
      action: 'reject',
      reason: 'whole-database destruction always requires explicit operator override'
    }
  },

  // ── UNTRUSTED_REMOTE_EXEC ──────────────────────────────────────────────
  {
    category:  'UNTRUSTED_REMOTE_EXEC',
    statement: 'no curl-pipe-shell pattern (untrusted code execution)',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: '(curl|wget)[^|]*\\|\\s*(bash|sh|zsh|fish)\\b',
      action: 'reject',
      reason: 'curl|sh pattern executes untrusted remote code'
    }
  },
  {
    category:  'UNTRUSTED_REMOTE_EXEC',
    statement: 'no curl-pipe-python pattern',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: '(curl|wget)[^|]*\\|\\s*python[23]?\\b',
      action: 'reject',
      reason: 'remote-fetched script executed via python interpreter is untrusted exec'
    }
  },

  // ── CODE_INJECTION_SINK ────────────────────────────────────────────────
  {
    category:  'CODE_INJECTION_SINK',
    statement: 'no eval() / exec() / Function() string constructors in JS Write content',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.content',
      regex: '\\b(eval|Function)\\s*\\(',
      action: 'reject_and_revise',
      reason: 'eval/Function-from-string in written code is a code-injection sink',
      revise_hint: 'replace dynamic eval with a typed dispatch table or AST-validated handler'
    }
  },

  // ── CREDENTIAL_EXPOSURE ────────────────────────────────────────────────
  {
    category:  'CREDENTIAL_EXPOSURE',
    statement: 'no writes containing AWS access key pattern',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.content',
      regex: 'AKIA[0-9A-Z]{16}',
      action: 'reject',
      reason: 'detected AWS access key in write content — secrets must not be hardcoded'
    }
  },
  {
    category:  'CREDENTIAL_EXPOSURE',
    statement: 'no writes containing OpenAI-style secret key pattern',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.content',
      regex: 'sk-[A-Za-z0-9]{32,}',
      action: 'reject',
      reason: 'detected OpenAI-shape secret in write content'
    }
  },
  {
    category:  'CREDENTIAL_EXPOSURE',
    statement: 'no writes to .env files (credentials channel)',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.file_path',
      regex: '(^|/)\\.env(\\.|$)',
      action: 'escalate_to_operator',
      reason: '.env files carry secrets — operator should confirm any agent-side write'
    }
  },

  // ── PRIVILEGE_ESCALATION ───────────────────────────────────────────────
  {
    category:  'PRIVILEGE_ESCALATION',
    statement: 'no sudo invocations',
    predicate: {
      kind: 'pattern',
      target: 'tool_args.command',
      regex: '\\bsudo\\b',
      action: 'escalate_to_operator',
      reason: 'sudo elevates privilege — requires explicit operator approval'
    }
  },

  // ── RATE_LIMIT (soft, per-time-window) ─────────────────────────────────
  {
    category:  'RATE_LIMIT',
    statement: 'cap Bash invocations at 50/minute (runaway-loop guard)',
    predicate: {
      kind: 'rate_limit',
      tool: 'Bash',
      max: 50,
      window_ms: 60000,
      action: 'reject_and_revise',
      reason: 'Bash rate exceeded — likely runaway loop; pivot or escalate'
    }
  },
  {
    category:  'RATE_LIMIT',
    statement: 'cap web_fetch invocations at 20/minute',
    predicate: {
      kind: 'rate_limit',
      tool: 'web_fetch',
      max: 20,
      window_ms: 60000,
      action: 'reject_and_revise',
      reason: 'web_fetch rate exceeded — possible exfil pattern or research loop without synthesis'
    }
  }
];

function listExisting() {
  const rows = state.queryActions({ type: 'commitment', limit: 500 }) || [];
  const refusals = [];
  for (const r of rows) {
    let out; try { out = typeof r.output === 'string' ? JSON.parse(r.output) : r.output; } catch (_) { continue; }
    if (!out || out.commitment_type !== 'refusal') continue;
    if (!out.predicate || typeof out.predicate.kind !== 'string') continue;
    refusals.push({
      id: r.id,
      statement: out.statement,
      kind: out.predicate.kind,
      action: out.predicate.action,
      target: out.predicate.target,
      scope: out.scope || null
    });
  }
  return refusals;
}

function main() {
  console.log('=== seed-refusals.js — B6 Wall 1 activation ===\n');

  if (LIST) {
    const existing = listExisting();
    console.log('Currently-active refusals: ' + existing.length);
    for (const r of existing) {
      console.log('  - [' + r.kind + '/' + r.action + '] ' + r.statement.slice(0, 80) + ' (id=' + r.id + ')');
    }
    return 0;
  }

  // Backup state.db before any write: a destructive write with no backup
  // has cost real work before.
  if (!DRY) {
    try {
      const dbPath = path.join(process.env.HOME, '.troth', 'state.db');
      if (fs.existsSync(dbPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = '/tmp/state.db.pre-seed-refusals-' + stamp;
        execSync('cp ' + JSON.stringify(dbPath) + ' ' + JSON.stringify(backupPath), { stdio: 'pipe' });
        console.log('BACKUP=' + backupPath + '\n');
      }
    } catch (e) {
      console.error('Backup failed (continuing): ' + (e && e.message || e));
    }
  }

  const existing = listExisting();
  const existingStatements = new Set(existing.map(r => String(r.statement || '').toLowerCase().trim()));

  let written = 0, skipped = 0;
  for (const seed of SEED) {
    const norm = String(seed.statement).toLowerCase().trim();
    if (existingStatements.has(norm)) {
      console.log('  · SKIP (already present): ' + seed.statement);
      skipped++;
      continue;
    }
    if (DRY) {
      console.log('  + DRY-RUN would write: ' + seed.statement);
      written++;
      continue;
    }
    try {
      const id = engram.recordEngram({
        agent_id: 'operator-seed',
        user_id:  'default',
        cwd:      null,
        statement: seed.statement,
        source:   'scripts/seed-refusals.js',
        scope:    'hard-invariant',
        salience: 2.0,           // refusals are high-salience
        auto_verify: false       // already deduped above; skip pool comparison
      });
      // Need to also persist the predicate JSON. recordEngram doesn't accept
      // arbitrary output fields, so we patch the just-written row's output.
      if (id) {
        const row = state.queryActions({ type: 'commitment', limit: 50 }).find(r => r.id === id);
        if (row) {
          let output; try { output = typeof row.output === 'string' ? JSON.parse(row.output) : row.output; } catch (_) { output = {}; }
          output.commitment_type = 'refusal';
          output.predicate = seed.predicate;
          // B redesign: persist category from taxonomy on the refusal row
          // so audit views + operator UI can group by canonical category.
          if (seed.category) output.category = seed.category;
          // Direct UPDATE via state helper if exposed; otherwise via better-sqlite3.
          try {
            const sqlite = require('better-sqlite3');
            const db = sqlite(path.join(process.env.HOME, '.troth', 'state.db'));
            db.prepare('UPDATE action_records SET output = ? WHERE id = ?').run(JSON.stringify(output), id);
            db.close();
          } catch (e) {
            console.error('  ✗ predicate patch failed for ' + id + ': ' + (e && e.message || e));
          }
        }
      }
      console.log('  + WROTE: [' + (seed.category || 'uncategorized') + '] ' + seed.statement + ' (id=' + id + ')');
      written++;
    } catch (e) {
      console.error('  ✗ write failed: ' + seed.statement + ' — ' + (e && e.message || e));
    }
  }

  console.log('\n=== Done: written=' + written + ', skipped=' + skipped + ' (DRY=' + DRY + ') ===');
  return 0;
}

process.exit(main());
