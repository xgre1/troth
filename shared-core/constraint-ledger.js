// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The operator's "don't" becomes state, not sentence.
//
// Measured on 2026-08-15, the hard way: an explicit operator freeze ("μην
// κάνεις τίποτα") was violated by a git push a few turns later — while the
// freeze was still in the window. The literature has the numbers for why:
// omission constraints ("don't X") decay from 73% compliance at turn 5 to
// 33% by turn 16 while requirement-type constraints hold (arXiv:2604.20911),
// and models restate the very rule they are breaking up to 99% of the time
// (arXiv:2604.28031). Text does not bind. State gating the dispatch does:
// machine-checked action gates reach 100% conformance with utility UP
// (Agent-C, arXiv:2512.23738). This module is that state.
//
// Shape — append-only, tombstone-lifted (arXiv:2608.12599):
//   freeze: ActionRecord { type:'operator_constraint',
//                          input:{ kind:'freeze', scope, quote } }
//   lift:   ActionRecord { type:'operator_constraint',
//                          input:{ kind:'lift', scope, quote },
//                          parent_id: <freeze id> }
// Net state = freezes of the last WINDOW_MS minus lifted ones. Nothing is
// updated in place; the ledger reads like history because it is one.
//
// Scopes: 'outward' (everything that leaves the machine) or a single action
// class ('push' | 'upload' | 'notarize') for freezes shaped like "θα σου πω
// εγώ πότε push". A scoped lift requires the ACTION WORD itself, affirmative,
// in the operator's message; a generic continue-word lifts only the generic
// freeze. A negation near the verb never lifts anything — the operator's
// terse messages are read literally, and a wrong unlock is the whole failure
// class this module exists to end. Ambiguity resolves to STILL FROZEN; the
// deny message tells the agent to ask the operator in so many words.
//
// One classifier, many consumers (the memory-shaped.js pattern): the
// troth-bash server refuses at execution, the bash-steer hook refuses the
// native lane, the injector re-serves active freezes at the END of every
// turn context (both-ends placement is the measured winner for standing
// instructions), and the capture hook writes the rows. All of them call
// into here; none of them holds patterns of its own.

const path = require('path');

let _state = null;
function state() {
  if (!_state) _state = require(path.join(__dirname, 'state.js'));
  return _state;
}
let _ar = null;
function ar() {
  if (!_ar) _ar = require(path.join(__dirname, 'action-record.js'));
  return _ar;
}

// A freeze older than this is stale by policy: a week-old "wait" almost
// certainly outlived its conversation, and a silently immortal freeze would
// brick the lane in a way nobody can see. The TTL is a safety floor, not a
// lift — the capture hook confirms registration to the operator, so a freeze
// they still mean gets restated and re-recorded long before this expires.
const WINDOW_MS = 7 * 24 * 3600 * 1000;

const TYPE = 'operator_constraint';

// ── Detection ────────────────────────────────────────────────────────────────
// Precision-first, trilingual (EN / ελληνικά / greeklish) — a missed freeze
// still has the operator repeating themselves; a false freeze blocks real
// work and teaches the operator to distrust the wall.

const FREEZE_PATTERNS = [
  // generic: stop everything / do nothing / wait
  /\b(?:do\s+nothing|don'?t\s+do\s+anything|stop\s+everything|freeze\s+everything|touch\s+nothing)\b/i,
  // JS \b is ASCII-only: between a space and a Greek letter there is NO word
  // boundary, so \b-wrapped Greek never matches (probe-caught 2026-08-15;
  // memory-shaped.js learned the same lesson). Greek runs bare, ASCII keeps \b.
  /μην?\s+κάν(?:εις|ετε)\s+τίποτα/i,
  /\bmin\s+kaneis\s+tipota\b/i,
  /σταμάτα\s+(?:τα\s+)?όλα/i,
  /\bstamata\s+(?:ta\s+)?(?:ola|panta)\b/i,
  // wait-for-my-word family
  /\b(?:wait\s+for\s+my\s+(?:word|signal|go)|until\s+i\s+say(?:\s+so)?)\b/i,
  /περίμενε\s+να\s+σου\s+πω/i,
  /\bperimene\s+na\s+sou\s+pw\b/i
];

// scoped: "θα σου πω εγώ πότε push" / "I'll tell you when to push" —
// the captured verb names the action class.
const SCOPED_PATTERNS = [
  /\b(?:i(?:'| wi)ll\s+tell\s+you\s+when(?:\s+to)?|wait\s+before\s+you)\s+([^\s.,;!?]+)/i,
  /θα\s+σου\s+πω\s+(?:εγώ\s+|εγω\s+)?πότε\s+([^\s.,;!?]+)/i,
  /\btha\s+sou\s+pw\s+(?:egw\s+)?pote\s+([^\s.,;!?]+)/i,
  /μην?\s+κάνεις\s+([^\s.,;!?]+)\s+(?:ακόμα|μέχρι|πριν)/i,
  /\bmin\s+kaneis\s+([^\s.,;!?]+)\s+(?:akoma|mexri|prin)/i
];

// Action-class vocabulary: the operator's verb → the class the gate blocks.
const ACTION_WORDS = {
  push: 'push', pusharei: 'push', πουσάρεις: 'push', 'πούσαρε': 'push',
  upload: 'upload', anevaseis: 'upload', ανεβάσεις: 'upload', deploy: 'upload',
  publish: 'upload', notarize: 'notarize'
};

function _actionClass(word) {
  if (!word) return null;
  return ACTION_WORDS[String(word).toLowerCase()] || null;
}

// Affirmative continue-words. Deliberately short: these lift ONLY the
// generic freeze, never a scoped one.
const LIFT_GENERIC = [
  /^(?:ok\s+)?(?:go|proceed|continue)\b/i,
  /προχώρα|προχωρα|συνέχισε|συνεχισε/i,
  /\b(?:proxora|sinexise|sinexizoume)\b/i
];

// A negation within reach of the verb flips the meaning of the whole
// message — "μην κάνεις push" contains "push" and must never read as a lift.
const NEGATION = /\b(?:min|mhn|don'?t|do\s+not|not|oxi|xoris|stop)\b|μην?\s|όχι|χωρίς/i;

function detectFreeze(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const re of SCOPED_PATTERNS) {
    const m = t.match(re);
    if (m) {
      const cls = _actionClass(m[1]);
      return { scope: cls || 'outward', quote: m[0].trim() };
    }
  }
  for (const re of FREEZE_PATTERNS) {
    const m = t.match(re);
    if (m) return { scope: 'outward', quote: m[0].trim() };
  }
  return null;
}

// detectLift(text, active) — which of the ACTIVE freezes does this message
// lift? Returns an array of freeze rows (possibly empty). Fail-closed by
// construction: no match, no lift; negation near an action word, no lift.
function detectLift(text, active) {
  const t = String(text || '');
  if (!t.trim() || !Array.isArray(active) || !active.length) return [];
  const lifted = [];
  const negated = NEGATION.test(t);
  for (const row of active) {
    const scope = row.input && row.input.scope;
    if (scope && scope !== 'outward') {
      // scoped: the action word itself, affirmative, must appear
      const words = Object.keys(ACTION_WORDS).filter(w => ACTION_WORDS[w] === scope);
      // \b only fences ASCII words; Greek action words match bare (same
      // ASCII-only-\b lesson as the pattern lists above).
      const hit = words.some(w => (/^[\x00-\x7F]+$/.test(w)
        ? new RegExp('\\b' + w + '\\b', 'i')
        : new RegExp(w, 'i')).test(t));
      if (hit && !negated) lifted.push(row);
    } else {
      // generic: continue-words lift it; a scoped action word alone does not
      if (!negated && LIFT_GENERIC.some(re => re.test(t))) lifted.push(row);
    }
  }
  return lifted;
}

// ── Ledger ───────────────────────────────────────────────────────────────────

function recordFreeze(opts) {
  opts = opts || {};
  const rec = {
    id: ar().uuidv7(),
    timestamp: Date.now(),
    type: TYPE,
    agent_id: opts.agent_id || 'claude-code',
    user_id: opts.user_id || 'default',
    cwd: opts.cwd || null,
    audience: 'model_visible',
    memory_class: 'procedural',
    input: { kind: 'freeze', scope: opts.scope || 'outward', quote: String(opts.quote || '') },
    output: { status: 'active' }
  };
  state().recordAction(rec, ar().toSearchText(rec));
  return rec.id;
}

function recordLift(freezeId, opts) {
  opts = opts || {};
  const rec = {
    id: ar().uuidv7(),
    timestamp: Date.now(),
    type: TYPE,
    agent_id: opts.agent_id || 'claude-code',
    user_id: opts.user_id || 'default',
    cwd: opts.cwd || null,
    parent_id: freezeId,
    audience: 'model_visible',
    memory_class: 'procedural',
    input: { kind: 'lift', scope: opts.scope || 'outward', quote: String(opts.quote || '') },
    output: { status: 'lift' }
  };
  state().recordAction(rec, ar().toSearchText(rec));
  return rec.id;
}

// Net state: freezes inside the window, minus those a lift points at.
function activeConstraints(opts) {
  opts = opts || {};
  const user_id = opts.user_id || 'default';
  let rows = [];
  try {
    rows = state().queryActions({
      type: TYPE, since: Date.now() - WINDOW_MS, limit: 200, order: 'asc'
    }) || [];
  } catch (_) { return []; /* no store, no state — nothing to enforce */ }
  const freezes = new Map();
  for (const raw of rows) {
    const rec = ar().fromRow(raw);
    if (!rec || (rec.user_id || 'default') !== user_id) continue;
    const kind = rec.input && rec.input.kind;
    if (kind === 'freeze') freezes.set(rec.id, rec);
    else if (kind === 'lift' && rec.parent_id) freezes.delete(rec.parent_id);
  }
  return Array.from(freezes.values());
}

// ── Outward classification ───────────────────────────────────────────────────
// What counts as leaving the machine. Local work (builds, tests, commits,
// reads) is never gated — the freeze protects the WORLD from us, not us
// from working.

const _LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(?::\d+)?$/i;

// git's SUBCOMMAND is the first non-option token — parsed, not pattern-
// matched. The first blind trial (2026-08-16) walked a push straight
// through the freeze as `git -C <path> push`: the old regex bridge had no
// room for `-C`'s uppercase or its path argument. Agents write options;
// a wall that reads tokens like git does cannot be dressed around — and
// `git log --grep push` stays free, because its subcommand is log.
const _GIT_OPT_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
function _gitSubcommands(c) {
  // EVERY shell segment gets its own read — `git status && git push` hides
  // the push in the second segment if only the first git is examined.
  const subs = [];
  for (const seg of String(c).split(/[|;&]+/)) {
    const m = seg.match(/\bgit\b(.*)/);
    if (!m) continue;
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (_GIT_OPT_WITH_ARG.has(t)) { i += 2; continue; }
      if (/^--?[A-Za-z]/.test(t)) { i += 1; continue; }
      subs.push(t);
      break;
    }
  }
  return subs;
}

function isOutwardCommand(cmd) {
  const c = String(cmd || '');
  if (!c.trim()) return { outward: false };

  if (_gitSubcommands(c).includes('push'))
    return { outward: true, action: 'push', why: 'git push publishes commits' };
  if (/\bgh\s+api\b/.test(c) && /(?:-X|--method)[=\s]+(?:POST|PUT|PATCH|DELETE)\b/i.test(c))
    return { outward: true, action: 'push', why: 'gh api mutation changes the remote' };
  if (/\bgh\s+(?:release\s+(?:create|upload|edit|delete)|pr\s+(?:create|merge|close)|repo\s+(?:create|delete|edit))\b/.test(c))
    return { outward: true, action: 'push', why: 'gh writes to the remote' };
  if (/\b(?:npm|pnpm|yarn)\s+publish\b/.test(c)) return { outward: true, action: 'upload', why: 'registry publish' };
  if (/\bwrangler\s+(?:publish|deploy|r2\s+object\s+put|pages\s+deploy)\b/.test(c))
    return { outward: true, action: 'upload', why: 'cloudflare deploy/upload' };
  if (/\bnotarytool\s+submit\b/.test(c)) return { outward: true, action: 'notarize', why: 'sends the artifact to Apple' };
  if (/\b(?:scp|sftp|rsync)\b[^|;&]*\s\S+@?\S*:/.test(c)) return { outward: true, action: 'upload', why: 'remote copy' };

  // curl/wget: mutating verb or a request body, aimed anywhere but this machine
  if (/\b(?:curl|wget)\b/.test(c)) {
    const mutating = /(?:-X|--request)[=\s]+(?:POST|PUT|PATCH|DELETE)\b/i.test(c) ||
                     /(?:\s|^)(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file)\b/.test(c);
    if (mutating) {
      const host = (c.match(/https?:\/\/([^\/\s"']+)/i) || [])[1] || '';
      if (!_LOCAL_HOST.test(host)) return { outward: true, action: 'upload', why: 'HTTP write to ' + (host || 'a remote host') };
    }
  }
  return { outward: false };
}

// ── The gate ─────────────────────────────────────────────────────────────────
// One call, one verdict. Fail-closed on scope: a generic 'outward' freeze
// blocks every outward class; a scoped freeze blocks its class only.

function gate(cmd, opts) {
  const verdict = isOutwardCommand(cmd);
  if (!verdict.outward) return { blocked: false };
  const active = activeConstraints(opts);
  for (const row of active) {
    const scope = (row.input && row.input.scope) || 'outward';
    if (scope === 'outward' || scope === verdict.action) {
      return {
        blocked: true,
        id: row.id,
        action: verdict.action,
        quote: (row.input && row.input.quote) || '',
        message: 'OPERATOR FREEZE active — the operator said: "' +
          ((row.input && row.input.quote) || 'wait') +
          '". This command (' + verdict.action + ': ' + verdict.why + ') stays blocked ' +
          'until the operator lifts it EXPLICITLY in a fresh message. Ask them in ' +
          'plain words; do not infer permission from earlier instructions.'
      };
    }
  }
  return { blocked: false };
}

module.exports = {
  detectFreeze, detectLift, recordFreeze, recordLift,
  activeConstraints, isOutwardCommand, gate,
  _WINDOW_MS: WINDOW_MS, _TYPE: TYPE
};
