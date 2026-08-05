// SPDX-License-Identifier: AGPL-3.0-only
// ActionRecord — the atomic unit of the troth substrate.
//
// Every externally-observable agent action becomes one of these: a structured
// record with provenance (who/when/where), input/output, verification, and
// outcome. Append-only. Immutable. Deterministically queryable.
//
// This module is PURE DATA LAYER — no DB writes, no side effects. Construction
// and validation only. Persistence lives in state.js. Hooks use this to shape
// their writes; queries use this to shape their reads.
//
// Design principles (see the substrate design notes):
//   - Append-only: ActionRecords are never mutated. Outcome updates are
//     separate events that reference the original by id.
//   - Verification is first-class: not a metadata blob. A record without
//     verification can't be trusted downstream.
//   - Causality explicit: parent_id edges let us trace "why" back to root.
//   - Type registry: known types have schemas; unknown types fail validation
//     rather than silently corrupting the store.
//
// See the substrate design notes for context.

const crypto = require('crypto');

// ── UUIDv7 — chronologically sortable UUIDs ────────────────────────────────
// Embeds the timestamp in the first 48 bits so ORDER BY id is ORDER BY time,
// improving B-tree locality without a separate timestamp index for recency
// queries. Format: 48 bits ms-since-epoch + 12 random bits + 62 random bits +
// version/variant markers.
function uuidv7(now) {
  const ts = BigInt(typeof now === 'number' ? now : Date.now());
  // 48 high bits from timestamp, 4-bit version (7), 12 bits random
  const tsHex = ts.toString(16).padStart(12, '0');
  const randA = crypto.randomBytes(2).readUInt16BE(0) & 0x0FFF;
  const randB = crypto.randomBytes(8);
  // Set version 7 in high nibble of byte 6
  randB[0] = (randB[0] & 0x3F) | 0x80; // variant 10
  const randBHex = Array.from(randB, b => b.toString(16).padStart(2, '0')).join('');
  const randAHex = ('7' + randA.toString(16).padStart(3, '0')); // version 7 prefix
  // Assemble: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
  return (
    tsHex.slice(0, 8) + '-' +
    tsHex.slice(8, 12) + '-' +
    randAHex + '-' +
    randBHex.slice(0, 4) + '-' +
    randBHex.slice(4, 16)
  );
}

// Extract timestamp (ms since epoch) from a UUIDv7 string. Useful for queries
// that need the record's write time without parsing the full row.
function uuidv7Timestamp(id) {
  if (typeof id !== 'string' || id.length !== 36) return null;
  const hex = id.slice(0, 8) + id.slice(9, 13);
  return parseInt(hex, 16);
}

// ── Type registry ──────────────────────────────────────────────────────────
// First wave: coding-domain types. The schema is generic enough that research,
// support, ops, and data agent types slot in later without structural change.
//
// For each type:
//   required:  fields that MUST be present in input/output for validity
//   optional:  fields commonly present but not required
//   verifies:  which verification slots are expected (hints for consumers)
const TYPES = {
  // ── Coding domain ────────────────────────────────────────────────────────
  edit: {
    description: 'File modification (hashline, str_replace, apply_patch, etc.).',
    required: { input: ['file_path', 'format'], output: ['hash_after'] },
    optional: { input: ['hash_before', 'edits'], output: ['diff', 'lines_changed'] },
    verifies: ['ast', 'content_hash', 'tests', 'types']
  },
  read: {
    description: 'File content fetched.',
    required: { input: ['file_path'], output: ['hash'] },
    optional: { input: ['start_line', 'end_line'], output: ['line_count', 'bytes'] },
    verifies: ['content_hash']
  },
  search: {
    description: 'Grep/Glob/semantic search query.',
    required: { input: ['query', 'kind'], output: ['result_count'] },
    optional: { input: ['scope', 'filters'], output: ['result_paths'] },
    verifies: []
  },
  tool_call: {
    description: 'Generic tool invocation (bash, MCP, etc.).',
    required: { input: ['tool_name'], output: ['status'] },
    optional: { input: ['args'], output: ['exit_code', 'bytes', 'compressed'] },
    verifies: []
  },
  decision: {
    description: 'Agent routing, mode detection, critic verdict, guardrail block.',
    required: { input: ['kind'], output: ['decision'] },
    optional: { input: ['signals'], output: ['reason', 'confidence'] },
    verifies: []
  },
  compact: {
    description: 'Working-set swap / context compaction event.',
    required: { input: ['trigger'], output: ['removed_count', 'kept_count'] },
    optional: { input: ['budget'], output: ['removed_ids', 'kept_ids'] },
    verifies: []
  },
  lesson: {
    description: 'Learned failure pattern or success heuristic.',
    required: { input: ['source', 'fingerprint'], output: ['text'] },
    optional: { input: ['failing_action_id'], output: ['applicable_scope'] },
    verifies: []
  },
  // P16 — Verified Intent Layer (GMP v0.2). Captures the user's goal +
  // chosen path so the substrate can answer "why" alongside "what". Verified
  // post-hoc via typed edges in action_record_edges (satisfies, supersedes,
  // contradicts_prior, etc.). See the GMP spec (published separately).
  intent: {
    description: 'User goal + acceptance criteria + chosen path. The "why" behind subsequent actions.',
    required: { input: ['goal', 'source_message_hash'], output: ['chosen_path'] },
    optional: {
      input:  ['constraint', 'acceptance_criteria'],
      output: ['agent_proposal', 'alternatives_considered']
    },
    verifies: ['user_approved', 'led_to_commit']
  },
  // P16.5 I1 — Negative-knowledge substrate. A path the agent considered,
  // attempted, or was about to attempt — and rejected, blocked, or
  // reverted. Surfaced at inference time to prevent repeated failure.
  // reason_kind enum: critic_block | loopbreaker | verification_fail |
  // user_revert | timeout | budget_exceeded.
  avoided_path: {
    description: 'A rejected/blocked/reverted path. Negative knowledge for re-injection at next turn.',
    required: { input: ['fingerprint', 'reason_kind'], output: ['avoidance_text'] },
    optional: {
      input:  ['attempted_action_id', 'lesson_id', 'critic_verdict_id'],
      output: ['suggest_instead', 'cost_avoided_estimate']
    },
    verifies: ['user_confirmed', 'expired']
  },
  // Mind layer — append-only mind-state snapshot. Each persist call
  // writes one of these. Mind state at any point is the latest snapshot
  // for the user (per Q5: append-only, view computed at read time).
  // Schema details validated by shared-core/mind-state.js.
  mind_snapshot: {
    description: 'Mind mind-state snapshot: working context (projects, decisions, intent) at a point in time.',
    required: { input: ['schema_version'], output: ['mind_state'] },
    optional: { input: ['trigger', 'prev_snapshot_id'], output: ['summary'] },
    verifies: ['schema_valid']
  },
  // Substrate-as-Entity v0.1 — first-class commitment record. Anchors,
  // refusals, hard commitments, hypotheses, opinions, methodologies all
  // share this shape. Immutable per event-sourced principle: revisions
  // create a new commitment with output.lifetime.supersedes pointing at
  // the prior id; "current" view follows the supersession chain.
  commitment: {
    description: 'Substrate-recorded position the entity holds (anchor / refusal / hard / hypothesis / opinion / methodology / factual). Immutable; revisions are new commitments with supersedes pointer.',
    required: { input: ['source'], output: ['statement', 'commitment_type'] },
    optional: {
      input:  ['trigger_text', 'trigger_context_ref'],
      // `provenance` added — { file_path?, codelens_entity_id?,
      // source_module?, lines? } — bridges substrate engrams to their
      // on-disk anchor so CodeLens entities and substrate commitments can
      // join. Engram producer (shared-core/engram.js) populates it.
      output: ['confidence', 'evidence_refs', 'scope', 'revision_policy', 'lifetime', 'provenance']
    },
    verifies: ['user_confirmed']
  },
  // implementation step — compiled procedure. A recurring tool-call
  // sequence the substrate detected across multiple sessions, persisted
  // as a deterministic template the substrate can replay without an LLM
  // turn. Closes the "skills compiled into behavior" gap from the dream
  // paper Property #3 + #5. Detector lives in shared-core/procedure-
  // compiler.js; the substrate scans action_records.tool_call sequences
  // grouped by session_id, finds n-grams appearing in ≥2 distinct
  // sessions (Trace2Skill threshold), records the survivors here.
  compiled_procedure: {
    description: 'Detected recurring tool-call sequence stored as a deterministic template. Replayed by the substrate when a user request matches the trigger pattern, bypassing the LLM for known workflows.',
    required: {
      input:  ['pattern_signature', 'occurrences'],
      output: ['template', 'status']
    },
    optional: {
      input:  ['detected_in_sessions', 'sample_window_ms'],
      output: ['name', 'trigger_keywords', 'parameter_slots', 'first_seen_ts', 'last_seen_ts']
    },
    verifies: ['user_approved', 'replay_succeeded']
  }
};

const ALL_TYPES = Object.freeze(Object.keys(TYPES));

// ── Validation ─────────────────────────────────────────────────────────────
// Returns { ok, errors }. Errors are structured so callers can react
// programmatically (e.g., drop bad records to a dead-letter log) rather than
// parse free-form strings.
function validate(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, errors: [{ kind: 'not_object' }] };
  }

  // Required top-level fields
  for (const f of ['id', 'timestamp', 'type', 'agent_id']) {
    if (record[f] === undefined || record[f] === null) {
      errors.push({ kind: 'missing_top_level', field: f });
    }
  }

  if (typeof record.id !== 'string' || record.id.length !== 36) {
    errors.push({ kind: 'bad_id', got: record.id });
  }
  if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
    errors.push({ kind: 'bad_timestamp', got: record.timestamp });
  }
  if (typeof record.type !== 'string' || !ALL_TYPES.includes(record.type)) {
    errors.push({ kind: 'unknown_type', got: record.type, known: ALL_TYPES });
  }
  if (typeof record.agent_id !== 'string' || !record.agent_id) {
    errors.push({ kind: 'bad_agent_id', got: record.agent_id });
  }

  // Type-specific required input/output fields
  const schema = TYPES[record.type];
  if (schema) {
    const input = record.input || {};
    for (const f of schema.required.input) {
      if (input[f] === undefined || input[f] === null) {
        errors.push({ kind: 'missing_input_field', type: record.type, field: f });
      }
    }
    const output = record.output || {};
    for (const f of schema.required.output) {
      if (output[f] === undefined || output[f] === null) {
        errors.push({ kind: 'missing_output_field', type: record.type, field: f });
      }
    }
  }

  // Verification must be an object with ok-shaped slots
  if (record.verification !== undefined && record.verification !== null) {
    if (typeof record.verification !== 'object') {
      errors.push({ kind: 'bad_verification_shape' });
    } else {
      for (const slot of Object.keys(record.verification)) {
        const v = record.verification[slot];
        if (v !== null && v !== undefined && typeof v !== 'object') {
          errors.push({ kind: 'bad_verification_slot', slot, got: typeof v });
        }
      }
    }
  }

  // parent_id — if present, must be a valid UUID string (same format as id).
  if (record.parent_id !== undefined && record.parent_id !== null) {
    if (typeof record.parent_id !== 'string' || record.parent_id.length !== 36) {
      errors.push({ kind: 'bad_parent_id', got: record.parent_id });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Construction ───────────────────────────────────────────────────────────
// Factory that fills in defaults (id, timestamp) and shapes the record. Does
// NOT write to DB. Caller receives a valid record they can persist.
//
// Required args: type, agent_id. Everything else optional.
function create(args) {
  args = args || {};
  const now = Date.now();
  const record = {
    id: args.id || uuidv7(now),
    timestamp: args.timestamp || now,
    type: args.type,

    // Who/Where
    agent_id: args.agent_id,
    session_id: args.session_id || null,
    user_id: args.user_id || null,
    cwd: args.cwd || null,
    // principal_id — read-side brain identity. Optional here; state.recordAction
    // default-stamps from env TROTH_PRINCIPAL || 'partner' if absent. Callers
    // that need a non-default brain (L3 team, L4 deployed) pass it explicitly.
    principal_id: args.principal_id || null,

    // Causality
    parent_id: args.parent_id || null,
    context_hash: args.context_hash || null,

    // Content
    input: args.input || {},
    output: args.output || {},

    // Verification (pluggable slots — see shared-core/verification.js when it lands)
    verification: args.verification || {},

    // Outcome (often updated post-hoc via separate outcome events)
    outcome: args.outcome || {
      accepted: null,  // null = unknown, true = accepted, false = reverted
      reverted: false,
      led_to_commit: null,
      time_to_next_action_ms: null
    }
  };
  return record;
}

// ── Serialization ──────────────────────────────────────────────────────────
// Convert to/from the shape we store in SQLite. The core columns (id,
// timestamp, type, agent_id, session_id, user_id, cwd, parent_id,
// context_hash) become first-class SQL columns. input/output/verification/
// outcome live as JSON TEXT columns so we don't pre-commit to a column per
// field (extensible without migrations).
function toRow(record) {
  return {
    id: record.id,
    timestamp: record.timestamp,
    type: record.type,
    agent_id: record.agent_id,
    session_id: record.session_id,
    user_id: record.user_id,
    cwd: record.cwd,
    parent_id: record.parent_id,
    context_hash: record.context_hash,
    input: JSON.stringify(record.input || {}),
    output: JSON.stringify(record.output || {}),
    verification: JSON.stringify(record.verification || {}),
    outcome: JSON.stringify(record.outcome || {}),
    principal_id: record.principal_id || null
  };
}

function fromRow(row) {
  if (!row) return null;
  const safeParse = (s) => {
    if (!s) return {};
    try { return JSON.parse(s); } catch { return {}; }
  };
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type,
    agent_id: row.agent_id,
    session_id: row.session_id,
    user_id: row.user_id,
    cwd: row.cwd,
    parent_id: row.parent_id,
    context_hash: row.context_hash,
    input: safeParse(row.input),
    output: safeParse(row.output),
    verification: safeParse(row.verification),
    outcome: safeParse(row.outcome),
    principal_id: row.principal_id || null,
    //  audience + memory_class are top-level columns
    // on action_records (see state.js CREATE TABLE). Surfaced here so the
    // unified recall layer can filter and project without re-querying.
    audience: row.audience || null,
    memory_class: row.memory_class || null
  };
}

// ── FTS5 searchable text extraction ────────────────────────────────────────
// For the FTS5 companion table we flatten a record into a single search
// string. We deliberately include type + agent + content fields so queries
// like "edit auth.ts" or "decision loop_prevention" work without custom
// SQL. Long tool outputs and edit diffs skip FTS indexing (the archive MCP
// handles those separately).
function toSearchText(record) {
  const parts = [
    record.type || '',
    record.agent_id || '',
    record.session_id || '',
    record.cwd || ''
  ];
  // Curriculum chunks store their full body in output.text and are typically
  // 1-2KB — well above the generic 500-char cap below. Index the full body so
  // FTS queries hit research content; other long fields stay capped to avoid
  // polluting the index with tool_result blobs.
  const isLesson = record.type === 'lesson';
  // Commitments (engram / anchor / refusal / etc.) put their canonical
  // payload in output.statement. Statements routinely exceed 500 chars
  // (multi-sentence engrams, methodology rules), and dropping them from
  // FTS made `troth_search_actions` miss exactly the rows that matter
  // most for substrate recall. Always index commitment statements in
  // full, regardless of length. Other fields stay capped.
  const isCommitment = record.type === 'commitment';
  // Flatten input/output values that are strings or short arrays
  const flatten = (obj, side) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        if (v.length < 500) parts.push(v);
        else if (isLesson && k === 'text') parts.push(v);
        else if (isCommitment && side === 'output' && k === 'statement') parts.push(v);
      }
      else if (typeof v === 'number') parts.push(String(v));
      else if (Array.isArray(v) && v.length < 10) {
        for (const item of v) {
          if (typeof item === 'string' && item.length < 500) parts.push(item);
        }
      }
    }
  };
  flatten(record.input, 'input');
  flatten(record.output, 'output');
  return parts.filter(Boolean).join(' ');
}

module.exports = {
  // Construction
  create,
  // Validation
  validate,
  // UUIDs
  uuidv7,
  uuidv7Timestamp,
  // Registry
  TYPES,
  ALL_TYPES,
  // Serialization
  toRow,
  fromRow,
  toSearchText
};
