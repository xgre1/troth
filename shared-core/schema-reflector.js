// SPDX-License-Identifier: AGPL-3.0-only LLM-evolved wire-format
// schema reflector. MemEvolve-style background pipeline (arXiv 2512.18746).
// Periodically samples recent ActionRecords for a given domain signature,
// prompts the frontier LLM with "design the most token-efficient TOON header
// for this domain", validates the proposed header against the canonical
// ActionRecord shape, and saves it as a candidate profile. Default OFF. Opt in
// via env TROTH_SCHEMA_REFLECTOR=1. The LLM driver is INJECTED — substrate
// code never calls APIs directly. Tests pass a deterministic mock; production
// passes a real driver (proxy callFlash, Anthropic SDK, etc.). This keeps
// shared-core black-box-API-friendly per constitution. Returned profiles must
// beat deterministic Tier 1 by ≥15% on stored `perf_score` to be promoted to
// active.

const wireFormat = require('./wire-format');
const actionRecord = require('./action-record');

// ── Domain signature: stable identifier per (cwd, agent_id, type-mix) ────
// We hash the dominant axes so a second run on the same project
// produces the same signature. Lowered to first 16 chars of SHA-256.
function computeDomainSignature(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'empty';
  const cwds = new Set();
  const agents = new Set();
  const typeCounts = {};
  for (const r of rows) {
    if (r.cwd) cwds.add(r.cwd);
    if (r.agent_id) agents.add(r.agent_id);
    typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
  }
  const topTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => t + ':' + n)
    .join(',');
  const cwdSample = [...cwds].sort().slice(0, 3).join('|');
  const agentSample = [...agents].sort().slice(0, 3).join('|');
  return require('crypto')
    .createHash('sha256')
    .update(cwdSample + '||' + agentSample + '||' + topTypes)
    .digest('hex')
    .slice(0, 16);
}

// ── Build the prompt ───────────────────────────────────────────────────── We
// give the LLM a small batch + the canonical TOON header from Tier 1 (the
// deterministic baseline) and ask it to propose a domain-tuned alias
// dictionary. Only aliases are LLM-evolved. This deliberately limits the LLM's
// degrees of freedom to prevent the concept-drift risk (the LLM dropping audit
// metadata).
function buildPrompt(rows, baseline_header) {
  const sample = rows.slice(0, 20).map(r => ({
    type: r.type, agent_id: r.agent_id, cwd: r.cwd,
    input_keys: Object.keys(r.input || {}),
    output_keys: Object.keys(r.output || {})
  }));
  return [
    'You are designing a tokenizer-aware compression dictionary for an',
    'append-only agent-memory substrate. The schema below ships with a',
    'fixed key order and column shape (DO NOT change them). Your job is',
    'to propose an `aliases` object that maps frequently-recurring string',
    'VALUES (not keys) to short tokens like "&0", "&1", ... so that BPE',
    'tokenizers consume fewer tokens per record at recall time.',
    '',
    '## Canonical schema (immutable):',
    JSON.stringify({ keys: baseline_header.keys, __toon: 1 }),
    '',
    '## Sample of 20 recent records (shape only):',
    JSON.stringify(sample, null, 2),
    '',
    '## Output requirements:',
    '1. Return ONLY a single JSON object matching the TOON header shape:',
    '   {"__toon":1,"keys":[...same as canonical...],"aliases":{"value":"&N",...}}',
    '2. Aliases ≤ 32 entries.',
    '3. Each aliased value MUST be a string that appears in the sample.',
    '4. Do NOT alias UUIDs, hashes, or other high-entropy values.',
    '5. Do NOT remove or reorder keys from the canonical list.',
    '',
    'Return the JSON object. No commentary.'
  ].join('\n');
}

// ── Validate a profile proposal ──────────────────────────────────────────
// Multiple guards because we never trust LLM output blindly. If validation
// fails, the profile is rejected and the deterministic Tier 1 stays active.
function validateProposal(proposal, baseline_header) {
  if (!proposal || typeof proposal !== 'object') return { ok: false, reason: 'not_object' };
  if (proposal.__toon !== 1) return { ok: false, reason: 'wrong_toon_version' };
  if (!Array.isArray(proposal.keys)) return { ok: false, reason: 'no_keys' };
  // Keys must match canonical exactly — order included.
  if (proposal.keys.length !== baseline_header.keys.length) {
    return { ok: false, reason: 'key_count_mismatch' };
  }
  for (let i = 0; i < proposal.keys.length; i++) {
    if (proposal.keys[i] !== baseline_header.keys[i]) {
      return { ok: false, reason: 'key_drift', at: i };
    }
  }
  if (!proposal.aliases || typeof proposal.aliases !== 'object') {
    return { ok: false, reason: 'no_aliases' };
  }
  const aliasEntries = Object.entries(proposal.aliases);
  if (aliasEntries.length > 32) return { ok: false, reason: 'too_many_aliases' };
  // Each alias must be unique (1:1 mapping) and shaped like &N.
  const seen = new Set();
  for (const [val, tok] of aliasEntries) {
    if (typeof val !== 'string' || typeof tok !== 'string') {
      return { ok: false, reason: 'bad_pair' };
    }
    if (!/^&\d+$/.test(tok)) return { ok: false, reason: 'bad_alias_token', tok };
    if (seen.has(tok)) return { ok: false, reason: 'duplicate_alias', tok };
    seen.add(tok);
    // Reject likely-UUID or likely-hash aliases (prevent the model from
    // aliasing entropy that won't repeat).
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
      return { ok: false, reason: 'aliased_uuid', val };
    }
    if (/^[0-9a-f]{32,}$/i.test(val)) {
      return { ok: false, reason: 'aliased_hash', val };
    }
  }
  return { ok: true };
}

// ── Run the reflector ────────────────────────────────────────────────────
// driver: async function (prompt) → string  (the proposed JSON header)
// Returns { ok, profile_id, reason }.
async function runReflector(state, opts) {
  if (!state || !opts || !opts.driver) return { ok: false, reason: 'missing_args' };
  const sample_size = opts.sample_size || 100;

  // Sample recent records from the chosen scope.
  const filter = {};
  if (opts.cwd)        filter.cwd = opts.cwd;
  if (opts.session_id) filter.session_id = opts.session_id;
  filter.limit = sample_size;
  const rows = (state.queryActions ? state.queryActions(filter) : []) || [];
  if (rows.length === 0) return { ok: false, reason: 'no_samples' };

  // Parse JSON columns into objects so the prompt sees the real shape.
  const parsed = rows.map(actionRecord.fromRow);
  const sig = computeDomainSignature(parsed);

  // Build the canonical baseline header by encoding an empty batch of
  // the same shape — gives us the immutable key order.
  const baseline_header_str = wireFormat.encodeBatch([]).split('\n')[0];
  const baseline_header = JSON.parse(baseline_header_str);

  // Skip if a candidate or active profile for this signature was made
  // recently (debounce — don't spam the LLM on every tick).
  const recent = state.listWireFormatProfiles
    ? state.listWireFormatProfiles({ domain_signature: sig, limit: 5 })
    : [];
  // Use explicit type check — `0 || default` would erase a deliberate
  // "no debounce" override.
  const debounce_ms = typeof opts.debounce_ms === 'number'
    ? opts.debounce_ms : 60 * 60 * 1000;  // 1h default
  if (recent.some(p => Date.now() - p.created_at < debounce_ms)) {
    return { ok: false, reason: 'debounced' };
  }

  // Build prompt + invoke driver.
  const prompt = buildPrompt(parsed, baseline_header);
  let raw;
  try { raw = await opts.driver(prompt); }
  catch (e) { return { ok: false, reason: 'driver_threw', message: e.message }; }
  if (typeof raw !== 'string') return { ok: false, reason: 'non_string_response' };

  // Strip code fences if the model wraps its output.
  raw = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let proposal;
  try { proposal = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'parse_failed', message: e.message }; }

  const v = validateProposal(proposal, baseline_header);
  if (!v.ok) return { ok: false, reason: 'invalid_proposal', detail: v };

  // Save as candidate. Caller (CLI / dashboard / future bench) promotes
  // to active after measuring perf_score via LMDT.
  const id = state.saveWireFormatProfile({
    domain_signature: sig,
    header_json: proposal,
    status: 'candidate',
    author: opts.author || 'reflector',
    sample_count: rows.length
  });
  if (!id) return { ok: false, reason: 'save_failed' };
  return { ok: true, profile_id: id, domain_signature: sig, sample_count: rows.length };
}

module.exports = {
  computeDomainSignature,
  buildPrompt,
  validateProposal,
  runReflector
};
