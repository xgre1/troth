// SPDX-License-Identifier: AGPL-3.0-only
// Dialogue Memory — substrate-side persistence of conversation turns.
//
// Each successful llm response is recorded as a `tool_call` action
// with input.tool_name === 'dialogue.turn'. On the next call the
// substrate can query the most recent N turns and surface them into
// the language faculty's identity prefix. This is what gives the
// substrate-as-entity continuous identity across calls — the model
// no longer sees each user input as a fresh context, but as a turn
// in an ongoing conversation the substrate is steering.
//
// Why store as ActionRecord rather than a separate dialogue table:
// L1 is the substrate's only durable surface — putting dialogue here
// means it gets the same causal-parent linkage, search-text indexing,
// and replay-on-boot behavior as every other substrate event. No
// special-casing in the recovery path.

const actionRec = require('./action-record.js');
const state     = require('./state.js');

const TOOL_NAME = 'dialogue.turn';

//  per-surface dedup window. The watcher (and any other
// driver) can re-fire the same (user_text, assistant_text) pair within
// seconds due to cursor races / process restarts / hook double-fire.
// Six identical rows landed in 7s on  — pure noise that
// polluted recall and made the operator's working memory look broken.
//
// Discipline (substrate-as-mind preserved):
//   - SAME agent_id + same content within window → SKIP (race-condition guard)
//   - DIFFERENT agent_id (voice vs chat vs CLI vs watcher) → ALWAYS allowed,
//     because the thesis says each surface is a legitimate cognitive moment.
//   - SAME agent_id, content matches but >window → ALLOWED (operator legitimately
//     repeating themselves; meaningful signal, not noise).
const DEDUP_WINDOW_MS = 30 * 1000;

function _isRecentDuplicate(agent_id, user_id, user_text, assistant_text) {
  if (!agent_id || (!user_text && !assistant_text)) return false;
  try {
    const since = Date.now() - DEDUP_WINDOW_MS;
    const rows = state.queryActions({
      type: 'tool_call',
      agent_id,
      since,
      limit: 10,
      order: 'desc'
    }) || [];
    for (const row of rows) {
      const rec = actionRec.fromRow(row);
      if (!rec || !rec.input || rec.input.tool_name !== TOOL_NAME) continue;
      if ((rec.user_id || 'default') !== user_id) continue;
      const prevUser = (rec.input.args && rec.input.args.user_text) || '';
      const prevAsst = (rec.output && rec.output.assistant_text)    || '';
      if (prevUser === user_text && prevAsst === assistant_text) return true;
      // Mirror-echo halves. A per-role mirror (the desktop record-turn
      // endpoint fires once per role) lands the SAME exchange as half
      // rows around the daemon's paired row: (U,'') and ('',A) beside
      // (U,A). Whole-tuple equality never catches them, so the same
      // assistant text was written twice and RE-MOUNTED into the prompt
      // window on every following turn — measured ~4.1K tokens of pure
      // duplication in one 14h window. A HALF whose non-empty side
      // matches the corresponding side of any recent turn is an echo of
      // an exchange the substrate already holds.
      const _incomingHalf = (!user_text && assistant_text) || (user_text && !assistant_text);
      if (_incomingHalf) {
        if (assistant_text && prevAsst && prevAsst === assistant_text) return true;
        if (user_text && prevUser && prevUser === user_text) return true;
      }
    }
  } catch (_) { /* best-effort — if the dedup probe fails, fall through and write */ }
  return false;
}

// Record one turn (user input + assistant response). Best-effort: if
// the substrate write surface is unavailable (e.g., tests with no
// SQLite), this returns false rather than throwing.
function recordTurn(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id;
  const user_id  = opts.user_id || 'default';
  const cwd      = opts.cwd || null;
  const user_text      = String(opts.user_text || '');
  const assistant_text = String(opts.assistant_text || '');
  const faculty  = opts.faculty || null;
  const parent_id = opts.parent_id || null;
  // Conversation thread this turn belongs to. Stored in the EXISTING
  // session_id column (SQL-filterable), so recentTurns({conversation_id})
  // can scope the injected working window to one thread. Null = unscoped
  // surface (bare CLI, legacy rows).
  const conversation_id = opts.conversation_id || null;
  if (!agent_id) return false;

  if (_isRecentDuplicate(agent_id, user_id, user_text, assistant_text)) return false;
  try {
    const rec = {
      // A replicated turn carries its author's id — one record fleet-wide.
      id: (typeof opts.id === 'string' && /^[0-9a-f][0-9a-f-]{15,}$/i.test(opts.id)) ? opts.id : actionRec.uuidv7(),
      timestamp: Date.now(),
      type: 'tool_call',
      agent_id,
      cwd,
      user_id,
      parent_id,
      session_id: conversation_id,
      //  dialogue turns ARE the conversation thread,
      // model needs to recall them. Audience model_visible, episodic class.
      audience: 'model_visible',
      memory_class: 'episodic',
      input:  {
        tool_name: TOOL_NAME,
        args: { user_text }
      },
      output: {
        status: 'recorded',
        assistant_text,
        faculty,
        elapsed_ms: opts.elapsed_ms || null,
        fragments:  opts.fragments  || null
      }
    };
    const v = actionRec.validate(rec);
    if (!v.ok) return false;
    const _wrote = state.recordAction(rec, actionRec.toSearchText(rec));
    // One mind, many devices: the recorded turn rides the outbox with its
    // id. _local marks an apply of a foreign event — never re-queued.
    if (_wrote && !opts._local) {
      try {
        const _evArgs = {
          id: rec.id,
          user_text, assistant_text, faculty,
          conversation_id,
          elapsed_ms: opts.elapsed_ms || null
        };
        const _evCtx = { agent_id, user_id, cwd };
        const rc = require('./sync/remote-client.js');
        if (rc.active()) rc.queueWrite('dialogue_turn', _evArgs, _evCtx);
        else require('./sync/hub-journal.js').maybeJournal('dialogue_turn', _evArgs, _evCtx);
      } catch (_) { /* local record stands; the flusher retries */ }
    }
    // Fire-and-forget: substrate-side classical classifier scans the
    // operator turn for directive shape (audit gap 1+3 wiring). On
    // detection, a draft active_project lands at llm_inferred tier;
    // operator confirms via `troth drafts list` → `drafts confirm`.
    // Failures are silent (best-effort; the conversation is unaffected
    // if the classifier errors). NO LLM call — pure classical regex
    // pass, cheap. Toggle off via process.env.TROTH_DISABLE_DIALOGUE_CLASSIFIER='1'.
    // DISABLED BY DEFAULT: this auto-wrote a "draft active_project"
    // commitment on EVERY directive-shaped turn with NO dedup — 8597 drafts
    // accumulated ("schedule app", "potato", "bread"...) and leaked into the
    // identity envelope, so the partner conflated unrelated tasks ("you said
    // bread but mentioned schedule app"). Pure noise; the operator confirms
    // real projects explicitly. Opt back in with TROTH_ENABLE_DIALOGUE_CLASSIFIER=1.
    if (user_text && process.env.TROTH_ENABLE_DIALOGUE_CLASSIFIER === '1') {
      try {
        const ap = require('./active-project.js');
        ap.proposeFromDialogue(user_text, {
          agent_id: agent_id,
          user_id:  user_id,
          cwd:      cwd
        });
      } catch (_) { /* best-effort */ }
    }
    return true;
  } catch (_) { return false; }
}

// Pull the most recent N turns for an agent. Returns array of
// { ts, user_text, assistant_text, faculty } in CHRONOLOGICAL order
// so callers can append directly to the prefix without re-sorting.
function recentTurns(opts) {
  opts = opts || {};
  // Substrate-as-mind invariant: the BRAIN identity at READ
  // time is `principal_id` (default 'partner'), not `agent_id`. Personal
  // mind sees turns from every surface. agent_id remains an OPTIONAL
  // secondary hard filter for tests + per-surface inspection. Pass
  // principal:null to bypass principal filtering entirely.
  const agent_id = opts.agent_id || null;
  const principal_id = (opts.principal === null)
    ? null
    : (opts.principal || process.env.TROTH_PRINCIPAL || 'partner');
  const limit    = Math.max(1, Math.min(100, opts.limit || 6));
  // No early-return: default path hits the partner brain across every
  // surface that wrote dialogue.turn rows. principal:null is the
  // explicit no-isolation mode for admin/migration use.
  const strict = !!opts.strict_isolation;
  // same_cwd: hard SQL filter on cwd WITHOUT the rest of strict semantics.
  // The silently INJECTED working window uses it so parallel projects stop
  // mixing (operator-reported: two projects through the plugin
  // cross-bled because cwd was ignored here without strict). EXPLICIT
  // recall keeps the cross-cwd default: the one mind answers about
  // everything when asked.
  const cwd    = (strict || opts.same_cwd) ? (opts.cwd || null) : null;
  // conversation_id: the ATTENTION scope. Turns are stamped with their
  // thread at write time (session_id column); a scoped read returns that
  // thread only, so a cockpit pane thinks inside its own conversation
  // while memory (identity/goals/engrams) stays global.
  const conversation_id = opts.conversation_id || null;
  try {
    const rows = state.queryActions({
      type: 'tool_call',
      tool_name: TOOL_NAME,        // SQL-prune to dialogue turns. Was: overfetch
                                   // limit*4 + JS-filter — but the background
                                   // worker floods tool_call rows (hypotheses/
                                   // lessons/summaries) under the same principal,
                                   // so the window held ~0 real turns and the
                                   // partner lost in-conversation memory.
      agent_id: agent_id || undefined,
      principal_id: principal_id || undefined,
      session_id: conversation_id || undefined,
      cwd,
      // Overfetch so incomplete rows below cannot starve the window; safe
      // against the background-flood problem the note above describes
      // because tool_name now prunes SQL-side. The loop still stops at
      // `limit` COMPLETE turns.
      limit: Math.min(100, limit * 4),
      order: 'desc'
    }) || [];
    const turns = [];
    for (const row of rows) {
      const rec = actionRec.fromRow(row);
      if (!rec || !rec.input || rec.input.tool_name !== TOOL_NAME) continue;
      const user_text      = (rec.input.args && rec.input.args.user_text) || '';
      const assistant_text = (rec.output && rec.output.assistant_text)    || '';
      const faculty        = (rec.output && rec.output.faculty)           || null;
      // A WINDOW turn is a COMPLETE exchange: both sides non-empty. The
      // app-side chat mirror writes HALF rows (a user-only row at send
      // time, an assistant-only "(cancelled)" row on aborts), and two of
      // those consumed the entire 3-turn window after two cancelled sends,
      // evicting the real context and leaving the partner amnesiac in its
      // own conversation. Structural filter,
      // no text matching: half rows never consume a slot. The entity's own
      // recorder only writes complete ok-turns, so real history is intact.
      if (!user_text || !assistant_text) continue;
      turns.push({
        //  surface id so callers (taskDriftScan) can dedup
        // by stable identity instead of timestamp+length synthetic keys
        // (ties collide silently when two turns share size+second).
        id: rec.id,
        ts: rec.timestamp,
        user_text,
        assistant_text,
        faculty,
        // cwd + agent_id surfaced as METADATA so callers can use them as
        // soft signals (same-cwd or same-surface turns slightly more
        // salient) without losing cross-folder/cross-surface continuity.
        cwd:      rec.cwd      || null,
        agent_id: rec.agent_id || null
      });
      if (turns.length >= limit) break;
    }
    // Reverse to chronological — latest at the end so it reads
    // naturally when appended to the identity prefix.
    return turns.reverse();
  } catch (_) { return []; }
}

// Render N recent turns into a prefix-friendly transcript block.
// Substrate caller decides where to insert — typically at the end of
// the identity envelope before the system instruction.
function renderTranscript(turns, opts) {
  opts = opts || {};
  if (!Array.isArray(turns) || !turns.length) return '';
  const maxChars = opts.max_chars || 1600;
  const lines = ['Recent dialogue (substrate continuity):'];
  for (const t of turns) {
    const u = (t.user_text      || '').replace(/\s+/g, ' ').trim();
    const a = (t.assistant_text || '').replace(/\s+/g, ' ').trim();
    if (u) lines.push('  user: '      + u);
    if (a) lines.push('  faculty: '   + a);
  }
  let block = lines.join('\n');
  if (block.length > maxChars) {
    // Trim from the front (oldest turns) so the latest exchange
    // always survives the budget cap.
    const overflow = block.length - maxChars;
    block = lines[0] + '\n  …(earlier turns elided)…\n' + block.slice(overflow + 32);
  }
  return block;
}

module.exports = {
  recordTurn,
  recentTurns,
  renderTranscript,
  TOOL_NAME
};
