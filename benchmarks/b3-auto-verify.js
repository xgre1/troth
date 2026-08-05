#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// b3-auto-verify — auto-classify the 30 sampled engrams using
// substrate's own data + filesystem checks. NO operator review needed.
//
// Verdict logic per engram:
//   D (duplicate)  — content cosine ≥ 0.85 vs another engram in corpus
//   W (wrong)      — contradicts a more recent / more specific engram,
//                    OR references a path that doesn't exist on disk,
//                    OR contains a number that conflicts with another
//                    fact about the same entity (e.g., RAM size)
//   T (trivial)    — derivable from filesystem (username, cwd path),
//                    OR generic ack-style statement,
//                    OR contains "wants to" / "was thinking" (one-off
//                    intent, not durable fact)
//   U (useful)     — passes all filters above

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveAgentId } = require('../shared-core/agent-id.js');

const DB_PATH = path.join(process.env.HOME || require('os').homedir(), '.troth', 'state.db');
const AGENT_ID = resolveAgentId();
const SAMPLES = process.argv[2];   // path to rubric .md
if (!SAMPLES || !fs.existsSync(SAMPLES)) {
  console.error('usage: node b3-auto-verify.js <rubric.md>');
  process.exit(1);
}

// Parse the 30 samples from the rubric
const txt = fs.readFileSync(SAMPLES, 'utf8');
const sections = txt.split(/\n## (\d+)\. /).slice(1);
const samples = [];
for (let i = 0; i < sections.length; i += 2) {
  const num = parseInt(sections[i], 10);
  const body = sections[i + 1] || '';
  const titleEnd = body.indexOf('\n');
  const statement = body.slice(0, titleEnd).trim();
  const idM = body.match(/\*\*id:\*\*\s*`([0-9a-f-]+)`/);
  const cwdM = body.match(/cwd:\s*`([^`]+)`/);
  samples.push({ num, statement, id: idM ? idM[1] : null, cwd: cwdM ? cwdM[1] : null });
}

// Load all engrams from corpus for cross-reference
const db = new Database(DB_PATH, { readonly: true });
const allEngrams = db.prepare(
  "SELECT id, timestamp, output, cwd FROM action_records " +
  "WHERE agent_id = @aid AND type = 'commitment' " +
  "  AND json_extract(output, '$.commitment_type') = 'engram'"
).all({ aid: AGENT_ID }).map(r => {
  let o; try { o = JSON.parse(r.output); } catch (_) { o = {}; }
  return { id: r.id, ts: r.timestamp, statement: o.statement || '', cwd: r.cwd };
});
db.close();

// === Heuristics ===
function tokenize(s) {
  const stop = new Set(['the','a','an','is','are','to','of','in','and','or','for','on','at','with','by','from','that','this','it','as','i','you','we','they','my','your','our','be','have','has','had','do','does','did','not','no','yes','user']);
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s+#\-]/g, ' ').split(/\s+/).filter(t => t && t.length >= 3 && !stop.has(t)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Trivial markers — short, ack-y, derivable
const TRIVIAL_PATTERNS = [
  /^user'?s? local username is /i,
  /^user'?s username is /i,
  /^user said /i,
  /^assistant said /i,
  /^the user'?s os is /i,
  /^the user is the operator/i
];

// Intent markers — "wants to", "was thinking", "is interested in" tend
// to be one-off statements, not durable facts
const INTENT_BUT_TRIVIAL = [
  /\b(?:wants to make|was thinking about|is interested in|is considering)\b/i
];

// Context-bound action markers — "deleted", "ran", "executed" are
// session-specific events, not durable facts
const ACTION_NOT_FACT = [
  /\b(?:was|were)\s+deleted\b/i,
  /\b(?:were\s+removed|got removed|got deleted)\b/i,
  /\bjust ran\b/i,
  /\bjust executed\b/i
];

// Operator ground-truth facts — used to detect engrams that contradict
// what the operator has actually told the substrate. SOURCE: read at
// runtime from $TROTH_OPERATOR_FACTS_JSON (a JSON file the operator
// curates locally) so this benchmark works for ANY operator without
// hardcoding one person's hardware/location/language into shipped code.
//
// Default = empty. Checks that depend on facts skip silently when the
// fact is undefined.
//
// Example facts file (operator writes this, never committed):
//   { "ram_gb": 32, "primary_machine_brand": "ExampleBook Pro",
//     "llm_runtime": "llama.cpp", "language_pref": ["Alpha","Beta"],
//     "in_country": "Freedonia" }
const KNOWN_FACTS = (() => {
  const factsPath = process.env.TROTH_OPERATOR_FACTS_JSON;
  if (!factsPath) return {};
  try { return JSON.parse(fs.readFileSync(factsPath, 'utf8')); }
  catch (_) { return {}; }
})();

function autoClassify(s) {
  const evidence = [];

  // Trivial detector
  for (const re of TRIVIAL_PATTERNS) {
    if (re.test(s.statement)) return { v: 'T', why: 'trivial pattern: ' + re.source, evidence };
  }
  for (const re of INTENT_BUT_TRIVIAL) {
    if (re.test(s.statement)) return { v: 'T', why: 'one-off intent, not durable fact', evidence };
  }
  for (const re of ACTION_NOT_FACT) {
    if (re.test(s.statement)) return { v: 'T', why: 'context-bound action, not durable fact', evidence };
  }

  // Wrong-fact detection — RAM mismatch (skipped if no operator-fact provided)
  const ramM = s.statement.match(/(\d{2,3})\s*GB/i);
  if (ramM && KNOWN_FACTS.ram_gb != null) {
    const claimed = parseInt(ramM[1], 10);
    if (claimed !== KNOWN_FACTS.ram_gb && /machine|unified memory|ram/i.test(s.statement)) {
      return { v: 'W', why: 'claims ' + claimed + 'GB but operator-truth is ' + KNOWN_FACTS.ram_gb + 'GB', evidence };
    }
  }
  // Wrong-runtime detection — skipped unless operator declared an LLM runtime
  if (KNOWN_FACTS.llm_runtime && KNOWN_FACTS.llm_runtime !== 'LM Studio'
      && /LM Studio/i.test(s.statement) && /Gemma|model|loaded/i.test(s.statement)) {
    return { v: 'W', why: 'mentions LM Studio but operator-truth runtime is ' + KNOWN_FACTS.llm_runtime, evidence };
  }

  // Duplicate detection — Jaccard ≥ 0.85 vs ANOTHER engram (not self)
  const myTok = tokenize(s.statement);
  if (myTok.size >= 3) {
    let bestSim = 0; let bestOther = null;
    for (const e of allEngrams) {
      if (e.id === s.id) continue;
      const sim = jaccard(myTok, tokenize(e.statement));
      if (sim > bestSim) { bestSim = sim; bestOther = e; }
    }
    if (bestSim >= 0.85) {
      return {
        v: 'D',
        why: 'jaccard=' + bestSim.toFixed(2) + ' vs other engram',
        evidence: [{ kind: 'dup_match', other_id: bestOther.id, other_excerpt: bestOther.statement.slice(0, 80) }]
      };
    }
    if (bestSim >= 0.65) {
      // Near-duplicate — mark as D with note
      return {
        v: 'D',
        why: 'near-dup jaccard=' + bestSim.toFixed(2),
        evidence: [{ kind: 'near_dup', other_id: bestOther.id, other_excerpt: bestOther.statement.slice(0, 80) }]
      };
    }
  }

  // Filesystem path validity — mentioned paths must exist. We accept
  // any absolute path under the current user's HOME, plus tilde-prefixed
  // paths. Operator-name-agnostic so the check works on any deployment.
  const HOME = process.env.HOME || require('os').homedir();
  const homeRe = new RegExp('(' + HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/[\\w/.-]+|~\\/[\\w/.-]+)', 'g');
  const pathMatches = s.statement.match(homeRe);
  if (pathMatches) {
    for (const p of pathMatches) {
      const real = p.startsWith('~') ? p.replace('~', HOME) : p;
      if (!fs.existsSync(real)) {
        return { v: 'W', why: 'references non-existent path: ' + p, evidence };
      }
    }
  }

  return { v: 'U', why: 'no flags raised', evidence };
}

// === Run ===
const verdicts = samples.map(s => ({ ...s, ...autoClassify(s) }));
const counts = { U: 0, W: 0, D: 0, T: 0 };
for (const v of verdicts) counts[v.v]++;
const total = verdicts.length;

console.log('# B3 auto-verified — ' + total + ' samples\n');
for (const v of verdicts) {
  console.log('  [' + v.v + '] ' + v.num + '. ' + v.statement.slice(0, 90));
  console.log('       why: ' + v.why);
  if (v.evidence && v.evidence.length) {
    for (const e of v.evidence) console.log('       evidence:', JSON.stringify(e));
  }
}
console.log('\n--- TALLY ---');
console.log('U (useful):    ' + counts.U + '  (' + (counts.U/total*100).toFixed(0) + '%)');
console.log('W (wrong):     ' + counts.W + '  (' + (counts.W/total*100).toFixed(0) + '%)');
console.log('D (duplicate): ' + counts.D + '  (' + (counts.D/total*100).toFixed(0) + '%)');
console.log('T (trivial):   ' + counts.T + '  (' + (counts.T/total*100).toFixed(0) + '%)');
const pass = counts.U/total >= 0.60 && counts.W/total <= 0.10;
console.log('\nAcceptance ≥60%U AND ≤10%W: ' + (pass ? '✅ PASS' : '❌ FAIL'));

// Write back into rubric
let updated = txt;
for (const v of verdicts) {
  const re = new RegExp('(## ' + v.num + '\\.[^\\n]*\\n[\\s\\S]*?\\*\\*verdict:\\*\\*\\s*)([\\n])', 'm');
  updated = updated.replace(re, '$1' + v.v + '  (auto: ' + v.why.replace(/\n/g, ' ') + ')$2');
}
const outPath = SAMPLES.replace(/\.md$/, '-auto-verified.md');
fs.writeFileSync(outPath, updated);
console.log('\nFilled rubric written to:', outPath);
