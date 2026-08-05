#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// troth-import-memory.js (#43) — migrate operator-curated ~/.claude memory *.md
// files into the substrate as SEMANTIC-class engrams (scope memory:*), so the
// auto-recall injector (recall.recall class:'all' → semantic) surfaces the clean
// curated facts and the model never falls back to Bash-grepping the .md files.
//
// Idempotent-ish: re-running re-ingests (chameleon records fresh chunks). Safe —
// additive, never deletes. Pair with ingest-watcher for ongoing freshness.
//
// Usage:
//   node bin/troth-import-memory.js
//   TROTH_MEMORY_DIRS=/path/a:/path/b TROTH_AGENT_ID=local-agent node bin/troth-import-memory.js
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const chameleon = require('../shared-core/chameleon.js');

const AGENT = process.env.TROTH_AGENT_ID || 'local-agent';
// Derive the Claude Code project-key for THIS user's home the same way Claude
// Code does (absolute path → '-'-escaped), so the default global-memory dir
// resolves on any installed machine — not just the dev box (#43 shipped a
// hardcoded path that only existed on the author's machine).
const _homeProjectKey = os.homedir().replace(/[/\\]/g, '-');
const MEM_DIRS = process.env.TROTH_MEMORY_DIRS
  ? process.env.TROTH_MEMORY_DIRS.split(':').filter(Boolean)
  : [path.join(os.homedir(), '.claude', 'projects', _homeProjectKey, 'memory')];
const EXTRA = [path.join(os.homedir(), '.claude', 'CLAUDE.md')];

function collect() {
  const out = [];
  for (const d of MEM_DIRS) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) out.push(path.join(d, f));
  }
  for (const f of EXTRA) if (fs.existsSync(f)) out.push(f);
  return out;
}

(async () => {
  const files = collect();
  console.log('[import-memory] ' + files.length + ' curated files → substrate (agent_id=' + AGENT + ', scope=memory:*, class=semantic)');
  let okF = 0, failF = 0, totRec = 0, totChunks = 0, embedded = 0;
  for (const f of files) {
    const base = path.basename(f).replace(/\.md$/, '');
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) {}
    if (!text.trim()) continue;
    try {
      const r = await chameleon.ingestDocument({
        agent_id: AGENT,
        scope: 'memory:' + base,
        title: base,
        text,
        source: 'ingest:claude-memory:' + f,
        salience: 1.5,
      });
      if (r && r.ok) {
        okF++; totRec += r.recorded || 0; totChunks += r.chunks || 0; embedded += r.embedded || 0;
        console.log('  ok  ' + base + '  ' + (r.recorded || 0) + '/' + (r.chunks || 0) + ' chunks' + (r.embedded ? ' (embedded)' : ' (lexical)'));
      } else { failF++; console.log('  FAIL ' + base + '  ' + (r && r.error)); }
    } catch (e) { failF++; console.log('  ERR  ' + base + '  ' + (e && e.message || e)); }
  }
  console.log('[import-memory] DONE files ok=' + okF + ' fail=' + failF + ', engrams=' + totRec + ' across ' + totChunks + ' chunks, embedded=' + embedded);
})().catch((e) => { console.error('[import-memory] fatal', e && e.message || e); process.exit(1); });
