#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Critic — Stop hook. Fires after the model decides the turn is done;
// runs the heuristic checks in shared-core/critic.js. If any check
// fails the hook blocks the stop (returning decision:"block" plus a
// reason) so the model is forced to regenerate with the failure
// reason in context.
//
// No second-LLM call here (unlike the proxy's async Flash critic) —
// that'd cost a turn's worth of quota for every Stop, negating the
// win. Pattern-based only; false-positive rate kept near zero by
// being specific about what "bailed out" looks like.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readStdinJson, allow, log, state, recordAction, featureEnabled } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const critic = require(pluginRoot + '/../shared-core/critic.js');

function block(reason) {
  // Stop hook schema (Claude Code 2.1.x): decision + reason are top-level,
  // NOT nested under hookSpecificOutput. Only PreToolUse / UserPromptSubmit
  // / PostToolUse use hookSpecificOutput. The old nested shape was silently
  // rejected with "Hook JSON output validation failed — (root): Invalid input".
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason
  }));
  process.exit(0);
}

// Layer 3 (fidelity): write a job file and spawn a DETACHED, unref'd worker that
// judges the operator HOW-rules with a cheap reasoning model out-of-band. Adds ZERO
// latency to this turn (spawn + unref + return); the verdict surfaces as a lesson on
// the NEXT turn. Gated by featureEnabled('fidelity'); fail-open on everything.
function spawnFidelityWorker(turn, payload) {
  const cp = require('node:child_process');
  const fsm = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const text = (turn && turn.text) || '';
  if (text.trim().length < 40) return;   // trivial turn — worker would skip anyway
  const job = {
    turnText: text,
    toolSequence: (turn && turn.toolSequence) || [],
    cwd: payload.cwd || process.cwd(),
    sessionId: payload.session_id || null,
    producerModel: payload.model || process.env.TROTH_PRODUCER_MODEL || 'claude',
    project: null,
    clientWork: false
  };
  const jobPath = path.join(os.tmpdir(), 'troth-fidelity-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.json');
  fsm.writeFileSync(jobPath, JSON.stringify(job), 'utf8');
  const workerPath = pluginRoot + '/../shared-core/fidelity-worker.js';
  const child = cp.spawn(process.execPath, [workerPath, jobPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

// Pull the last assistant message text and count how many tool uses
// appeared in that turn. Payload shape: {transcript_path, stop_hook_active, …}
// The transcript is a JSONL file; we read the tail looking for the most
// recent assistant message.
function loadLastAssistantTurn(transcriptPath) {
  if (!transcriptPath) return { text: '', toolCalls: 0, toolSequence: [] };
  try {
    const { readFileSync } = require('node:fs');
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n').reverse();
    let toolCalls = 0;
    let toolSeq = [];
    let text = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const role = msg.role || (msg.message && msg.message.role);
      const content = msg.content || (msg.message && msg.message.content);
      if (role !== 'assistant') {
        // Hit a non-assistant → we've walked past the current turn.
        if (text || toolCalls) break;
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block) continue;
          if (block.type === 'text' && block.text) text = block.text + '\n' + text;
          if (block.type === 'tool_use') {
            toolCalls++;
            const inp = block.input || {};
            const tgt = inp.file_path || inp.path || inp.notebook_path || inp.command || inp.url || inp.query || '';
            toolSeq.push({ name: block.name || '', target: String(tgt).slice(0, 256) });
          }
        }
      } else if (typeof content === 'string') {
        text = content + '\n' + text;
      }
    }
    return { text: text.trim(), toolCalls, toolSequence: toolSeq.reverse() };
  } catch (e) {
    return { text: '', toolCalls: 0, toolSequence: [] };
  }
}

const payload = await readStdinJson();

// When stop_hook_active is true we've already blocked once this turn;
// don't double-block (avoids infinite regeneration loop).
if (payload.stop_hook_active) {
  log('Stop.critic', { session_id: payload.session_id, reason: 'already_blocked_this_turn' });
  allow();
}

const turn = loadLastAssistantTurn(payload.transcript_path);
const result = critic.review(turn.text, { toolCallsInTurn: turn.toolCalls, toolSequence: turn.toolSequence, how_rules: featureEnabled('how_rails') });

if (result.ok) {
  // #51 — verify-evidence promotion. When the deterministic verify-evidence
  // HOW-rule fired AND the operator armed blocking AND its FP-clean window holds
  // (enough judged turns at a low flag-rate), harden the WARN into a hard BLOCK
  // so the model must regenerate WITH the check shown. Triple-gated (how_rails on
  // for detection + verify_evidence_block on + FP-clean) and never on a re-block
  // tick (stop_hook_active returned above), so it cannot false-block until
  // measurement proves the rule safe.
  const veWarn = Array.isArray(result.warnings)
    ? result.warnings.find((w) => typeof w === 'string' && w.indexOf('verify-evidence') !== -1)
    : null;
  if (veWarn && featureEnabled('verify_evidence_block')) {
    let clean = false;
    try { clean = require(pluginRoot + '/../shared-core/critic-verdict.js').verifyEvidenceFpClean({ cwd: payload.cwd }); } catch (_) { clean = false; }
    if (clean) {
      log('Stop.critic', { session_id: payload.session_id, decision: 'block', reason: 'verify_evidence_promoted' });
      recordAction({
        type: 'decision', session_id: payload.session_id, cwd: payload.cwd,
        input: { kind: 'critic', signals: [{ rule_id: 'verify-evidence' }] },
        output: { decision: 'block', reason: 'verify_evidence_promoted' }
      });
      block(veWarn);
    }
  }
  // Layer 2 WARN-first: surface warn-severity HOW-rule hits as a lesson for the
  // next turn (no block) so false-positives are measured before promotion to block.
  if (Array.isArray(result.warnings) && result.warnings.length) {
    try {
      const wfp = createHash('sha1').update('howwarn|' + result.warnings.join('|')).digest('hex').slice(0, 12);
      // "next turn" is the whole audience — queue-only, same reasoning as the
      // fidelity warning in fidelity-run.js.
      state.recordLesson(payload.session_id, payload.cwd || process.cwd(), 'how_rails_warn', wfp,
        'HOW-rule WARNING (not blocked): ' + result.warnings.join('; ') + '. Follow the operator working-style rule next turn.', { durable: false });
    } catch (_) { /* telemetry must never break the hook */ }
  }
  // Layer 3 fidelity critic — out-of-band, never blocks this turn.
  if (featureEnabled('fidelity')) {
    try { spawnFidelityWorker(turn, payload); } catch (_) { /* never break the hook */ }
  }
  log('Stop.critic', {
    session_id: payload.session_id,
    decision: 'allow',
    metadata: { tool_calls: turn.toolCalls, text_len: turn.text.length }
  });
  recordAction({
    type: 'decision',
    session_id: payload.session_id,
    cwd: payload.cwd,
    input: { kind: 'critic', tool_calls: turn.toolCalls, text_len: turn.text.length },
    output: { decision: 'allow' }
  });
  allow();
}

log('Stop.critic', {
  session_id: payload.session_id,
  decision: 'block',
  reason: 'heuristic_fail',
  metadata: { reasons: result.reasons }
});
recordAction({
  type: 'decision',
  session_id: payload.session_id,
  cwd: payload.cwd,
  input: { kind: 'critic', tool_calls: turn.toolCalls, text_len: turn.text.length, signals: result.reasons },
  output: { decision: 'block', reason: 'heuristic_fail' }
});

// record a lesson for the injector to surface on the next turn.
// Fingerprint collapses similar fails so we don't spam the same
// reminder over and over within a session.
try {
  const fp = createHash('sha1').update('critic|' + result.reasons.join('|')).digest('hex').slice(0, 12);
  state.recordLesson(
    payload.session_id,
    payload.cwd || process.cwd(),
    'critic',
    fp,
    'Previous turn was blocked by the critic because: ' + result.reasons.join('; ') +
    '. Avoid the same failure mode in the next response (deliver substantive output, no placeholders, no bail).'
  );
} catch (e) { /* telemetry must never break the hook */ }

// P16.5 I1 — emit a first-class avoided_path record so the negative-
// precedent surfacer can find it on the next prompt. Gated on
// TROTH_NEGATIVE_KNOWLEDGE=1 so off-by-default users pay nothing.
if (featureEnabled('negative_knowledge')) {
  try {
    const avoided = require(pluginRoot + '/../shared-core/avoided.js');
    avoided.recordAvoidance(state, {
      session_id: payload.session_id,
      cwd: payload.cwd,
      reason_kind: 'critic_block',
      signals: result.reasons,
      avoidance_text: 'Critic blocked previous turn: ' + result.reasons.join('; '),
      suggest_instead: 'deliver substantive output instead of placeholder/bail',
      agent_id: 'troth-plugin'
    });
  } catch (e) { /* never break the hook */ }
}

block(
  '[troth/critic] This turn looks like a bail rather than a completion:\n  - ' +
  result.reasons.join('\n  - ') +
  '\nContinue the task. If you genuinely need clarification, ask a specific concrete question instead of restating.'
);
