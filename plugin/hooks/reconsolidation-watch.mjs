#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// reconsolidation-watch — Stop hook. PLR (lability-window
// reconsolidation) post-response observer.
//
// What it does: pulls the assistant's just-completed turn text from the
// transcript, calls lability-reconsolidation.assessActionAgainstRetrieved
// against the engrams marked retrieved by injector.mjs in the matching
// UserPromptSubmit, and writes a `decision` record per detected
// contradiction. The record carries kind='reconsolidation_candidate' so
// the substrate ACCUMULATES evidence of stale beliefs without yet
// auto-superseding them.
//
// Why observation-only first: assessActionAgainstRetrieved uses Jaccard
// + negation heuristics — same shape as TMMA's verifier. Tuning a
// destructive auto-supersede on first-deploy day produces exactly the
// false-memory rewrites the substrate-as-mind thesis warns against.
// We let the candidate decisions accumulate for a session or two,
// then flip the auto-reconsolidate path on with confidence (or revise
// the threshold). The PLR module's reconsolidate() function stays
// available for explicit operator-driven runs in the meantime.
//
// Never blocks the Stop event — assessment failures emit allow().

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readStdinJson, allow, log, state } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const lr = require(pluginRoot + '/../shared-core/lability-reconsolidation.js');
const actionRec = require(pluginRoot + '/../shared-core/action-record.js');

// Mirror critic.mjs's transcript-tail walker. Walks the JSONL backwards,
// concatenating text blocks of the most recent assistant turn. Stops at
// the first non-assistant message — that's the user prompt that opened
// this turn.
function loadLastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n').reverse();
    let text = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const role    = msg.role    || (msg.message && msg.message.role);
      const content = msg.content || (msg.message && msg.message.content);
      if (role !== 'assistant') {
        if (text) break;
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'text' && block.text) text = block.text + '\n' + text;
        }
      } else if (typeof content === 'string') {
        text = content + '\n' + text;
      }
    }
    return text.trim();
  } catch (_) { return ''; }
}

const payload = await readStdinJson();
const cwd = payload.cwd || process.cwd();
const transcriptPath = payload.transcript_path || null;

const text = loadLastAssistantText(transcriptPath);
if (!text) { allow(); }

let candidates = [];
try {
  candidates = lr.assessActionAgainstRetrieved({
    state,
    action_text: text,
    cwd
  });
} catch (e) {
  log('Stop.reconsolidation_watch.error', { reason: 'assess_threw', message: String(e && e.message || e) });
  allow();
}

if (!candidates || !candidates.length) {
  log('Stop.reconsolidation_watch', { candidates: 0 });
  allow();
}

// Persist each candidate as its own decision record. The substrate
// learns "engram X was contradicted in turn Y at time Z" — queryable
// via state.queryActions({type:'decision', kind:'reconsolidation_candidate'}).
let written = 0;
for (const c of candidates) {
  try {
    const rec = {
      id: actionRec.uuidv7(),
      timestamp: Date.now(),
      type: 'decision',
      agent_id: 'troth-deliberator',
      cwd,
      user_id: 'default',
      input: {
        kind: 'reconsolidation_candidate',
        signals: {
          engram_id:           c.engram_id,
          contradiction_kind:  c.contradiction_kind,
          similarity:          c.similarity
        }
      },
      output: {
        decision: 'observed',
        reason:   c.contradiction_kind,
        prior_statement_excerpt: String(c.prior_statement || '').slice(0, 200),
        // Phase 3 — keep an excerpt of the contradicting assistant turn so
        // the BG reconsolidation_review task can ask an LLM to extract the
        // corrected fact (vs the phase-1 flag-only path that just retires
        // the prior). Capped at 600 chars per row to bound DB growth; the
        // BG task concatenates excerpts across consensus votes, so even a
        // tight cap composes a usable evidence bundle.
        contradicting_text_excerpt: String(text || '').trim().slice(0, 600)
      }
    };
    const v = actionRec.validate(rec);
    if (v.ok) { state.recordAction(rec, actionRec.toSearchText(rec)); written++; }
  } catch (_) { /* per-candidate write failures don't block subsequent ones */ }
}

log('Stop.reconsolidation_watch', { candidates: candidates.length, written });
allow();
