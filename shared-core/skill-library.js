// SPDX-License-Identifier: AGPL-3.0-only Skill library — core design aligned.
// Skills are NOT tools the LLM calls. They are RECIPE MEMORIES the substrate
// considers part of its own knowing — procedural memory in the same sense
// Anderson 1983 (ACT-R) describes: declarative knowledge compiled into "how I
// do things" through practice. Design invariant (anti-drift checklist item
// 1+2): - No new "tool catalog" envelope. Skills surface as procedural
// memories retrieved alongside identity/semantic/episodic recall. - When a
// goal lands, recall surfaces relevant skills INTO the planning prompt as "you
// have learned to do this kind of thing this way" — biasing the mind toward
// known patterns. Not as a separate "available_skills" list bolted on top. -
// When a goal succeeds, the mind absorbs newly-discovered patterns as part of
// its capability (skill extraction is self-observation, not external
// annotation). Storage: engram type='commitment', commitment_type='engram',
// memory_class='procedural', scope='skill:<class_hint>' output: { name,
// trigger_pattern, triggers, preconditions, recipe, evidence_of_success,
// version, superseded_by? } Recall integration: existing
// recall.recallProcedural() already pulls memory_class='procedural' with topic
// + overlap scoring. Skills surface through that path WITHOUT a parallel
// retrieval system — single recall surface. Versioning + rollback: - New
// version of same name → recordSkill bumps version, sets parent_id to previous
// version. Previous version stays in substrate (append-only) but listSkills
// filters out superseded by default. - rollbackSkill(id, reason) writes a
// 'system:skill-rolled-back' marker; future recall ignores rolled-back skills.
// - Voyager (Wang et al. arXiv 2305.16291): autonomous skill library for
// embodied agents drives compositional growth; novel-skill extraction
// post-success is the key learning mechanism. - Anderson 1983 ACT-R:
// procedural compilation from declarative knowledge through practice. -
// Andrews-Hanna 2014 (Nat Rev Neurosci): procedural memory is part of the
// unified self-network, NOT a separate subsystem. - versions append-only;
// rollback via marker engram not UPDATE. - design substrate-as-mind: skills
// are part of the mind, not external tool catalog.

'use strict';

const engram = require('./engram.js');
const state  = require('./state.js');

const SKILL_SCOPE_PREFIX = 'skill:';
const ROLLBACK_SCOPE     = 'system:skill-rolled-back';
const DEFAULT_MAX_PRECONDITIONS = 6;
const DEFAULT_MAX_RECIPE_STEPS  = 12;
const DEFAULT_MAX_EVIDENCE      = 10;
const STOP_WORDS = new Set([
  'the','a','an','of','to','for','and','or','is','are','was','were','be','been',
  'in','on','at','by','with','from','as','this','that','these','those','it','its',
  'will','would','should','can','may','might','i','we','you','they','he','she'
]);

function _tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function _topicTokens(text, max) {
  max = max || 8;
  const counts = {};
  for (const t of _tokenize(text)) {
    if (t.length < 4 || STOP_WORDS.has(t)) continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, max);
}

function _validateRecipe(recipe) {
  if (!Array.isArray(recipe)) return { ok: false, reason: 'recipe_must_be_array' };
  if (recipe.length === 0) return { ok: false, reason: 'recipe_empty' };
  if (recipe.length > DEFAULT_MAX_RECIPE_STEPS) {
    return { ok: false, reason: 'recipe_too_long', max: DEFAULT_MAX_RECIPE_STEPS };
  }
  for (const step of recipe) {
    if (!step || typeof step !== 'object') return { ok: false, reason: 'recipe_step_not_object' };
    if (typeof step.step_name !== 'string' || step.step_name.length < 2) {
      return { ok: false, reason: 'recipe_step_missing_name' };
    }
    if (typeof step.action_description !== 'string' || step.action_description.length < 4) {
      return { ok: false, reason: 'recipe_step_missing_action_description' };
    }
  }
  return { ok: true };
}

// Find latest version of a named skill (across all class_hints). Returns
// {id, version, scope, statement} or null. Used by recordSkill for
// version bump + parent_id chain.
function _findLatestByName(name) {
  if (!name) return null;
  const rows = state.queryActions({ type: 'commitment', limit: 1000, order: 'desc' }) || [];
  let best = null;
  for (const r of rows) {
    let out; try { out = JSON.parse(r.output); } catch (_) { continue; }
    if (!out || typeof out.scope !== 'string' || out.scope.indexOf(SKILL_SCOPE_PREFIX) !== 0) continue;
    if (out.name !== name) continue;
    const v = typeof out.version === 'number' ? out.version : 1;
    if (!best || v > best.version || (v === best.version && r.timestamp > best.ts)) {
      best = { id: r.id, version: v, scope: out.scope, statement: out.statement, ts: r.timestamp };
    }
  }
  return best;
}

function _isRolledBack(skillId) {
  if (!skillId) return false;
  try {
    const rows = state.queryActions({ type: 'commitment', parent_id: skillId, limit: 20 }) || [];
    for (const r of rows) {
      let out; try { out = JSON.parse(r.output); } catch (_) { continue; }
      if (out && out.scope === ROLLBACK_SCOPE) return true;
    }
  } catch (_) {}
  return false;
}

// Record a new skill, or a new version of an existing one.
//   opts.name              — required, unique per substrate
//   opts.class_hint        — goal_class this skill applies to (code/research/...)
//   opts.recipe            — required, array of {step_name, action_description, worker_role?}
//   opts.trigger_pattern   — optional string (regex OR natural-language fingerprint)
//   opts.preconditions     — optional array of strings
//   opts.evidence_of_success — optional array of goal_ids or briefing refs
//   opts.statement         — human-readable description (defaults to name + recipe summary)
//   opts.agent_id, opts.cwd, opts.user_id, opts.source
// Returns { id, version, superseded_id? } or { error, reason }.
function recordSkill(opts) {
  opts = opts || {};
  if (typeof opts.name !== 'string' || opts.name.length < 2) {
    return { error: true, reason: 'name_required' };
  }
  const recipeCheck = _validateRecipe(opts.recipe);
  if (!recipeCheck.ok) return { error: true, reason: recipeCheck.reason };
  if (Array.isArray(opts.preconditions) && opts.preconditions.length > DEFAULT_MAX_PRECONDITIONS) {
    return { error: true, reason: 'too_many_preconditions', max: DEFAULT_MAX_PRECONDITIONS };
  }
  const classHint = typeof opts.class_hint === 'string' ? opts.class_hint : 'general';
  const prior = _findLatestByName(opts.name);
  const version = prior ? prior.version + 1 : 1;
  const fingerprint = String(opts.trigger_pattern || opts.statement || opts.name);
  const triggerTokens = _topicTokens(fingerprint + ' ' + opts.name);

  // Statement embeds trigger_pattern so the FTS index actually contains
  // the descriptive text — without it, recall.recallProcedural's text
  // scoring against the query has nothing to match against (name alone
  // is opaque). Design principle: the mind reads its own skills by their
  // meaning, not their internal id.
  const statement = typeof opts.statement === 'string'
    ? opts.statement.slice(0, 400)
    : ('SKILL: ' + opts.name + ' — ' + fingerprint +
       ' (v' + version + ', ' + classHint + ', ' + opts.recipe.length + ' steps)').slice(0, 400);

  const evidence = Array.isArray(opts.evidence_of_success)
    ? opts.evidence_of_success.slice(0, DEFAULT_MAX_EVIDENCE)
    : [];

  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'l4-skill-library',
    cwd:      opts.cwd || null,
    user_id:  opts.user_id || null,
    statement,
    salience: 1,
    scope:    SKILL_SCOPE_PREFIX + classHint,
    parent_id: prior ? prior.id : null,
    source:   opts.source || 'l4:skill-library',
    audience: 'model_visible',
    memory_class: 'procedural',
    // Embed structured skill payload via the output blob — engram.js
    // passes through unknown fields as-is into the JSON output column.
    extra_output: {
      name:                  opts.name,
      class_hint:            classHint,
      trigger_pattern:       fingerprint.slice(0, 200),
      // Field name 'triggers' matches recall.recallProcedural's existing
      // shape contract (array.join(' ') → blob). Substrate-as-mind: ONE
      // recall path, no parallel skill retrieval API.
      triggers:              triggerTokens,
      preconditions:         Array.isArray(opts.preconditions) ? opts.preconditions.slice(0, DEFAULT_MAX_PRECONDITIONS) : [],
      recipe:                opts.recipe,
      evidence_of_success:   evidence,
      version,
      supersedes_id:         prior ? prior.id : null
    }
  });

  if (!id) return { error: true, reason: 'engram_record_failed' };
  return { id, version, superseded_id: prior ? prior.id : null };
}

// Mark a skill as rolled back. Best-effort marker engram (R23 — no UPDATE).
function rollbackSkill(skillId, reason, opts) {
  if (!skillId) return { error: true, reason: 'skill_id_required' };
  const id = engram.recordEngram({
    agent_id:  (opts && opts.agent_id) || 'l4-skill-library',
    cwd:       (opts && opts.cwd) || null,
    user_id:   (opts && opts.user_id) || null,
    statement: 'SKILL ROLLED BACK: ' + (reason || skillId).toString().slice(0, 200),
    salience:  1,
    scope:     ROLLBACK_SCOPE,
    parent_id: skillId,
    source:    (opts && opts.source) || 'l4:skill-library:rollback',
    audience:  'substrate_internal',
    memory_class: 'operational'
  });
  return id ? { id } : { error: true, reason: 'rollback_marker_failed' };
}

// List active skills (latest version per name, excluding rolled-back).
//   opts.class_hint — filter to one class (e.g. 'code')
//   opts.limit      — default 50
//
// Reads raw substrate rows via state.queryActions rather than going
// through engram.listEngrams because the latter projects to a fixed
// field list (statement, scope, salience, etc.) and drops the
// structured skill payload (name/version/recipe/...) that lives in
// extra_output.
function listSkills(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(500, opts.limit || 50));
  const rows = state.queryActions({
    type: 'commitment',
    limit: limit * 20,
    order: 'desc'
  }) || [];
  const byName = new Map();
  for (const r of rows) {
    let out; try { out = JSON.parse(r.output); } catch (_) { continue; }
    if (!out || typeof out.scope !== 'string' || out.scope.indexOf(SKILL_SCOPE_PREFIX) !== 0) continue;
    if (!out.name) continue;
    if (opts.class_hint && out.class_hint !== opts.class_hint) continue;
    if (_isRolledBack(r.id)) continue;
    const existing = byName.get(out.name);
    if (!existing || (out.version || 1) > (existing.version || 1)) {
      byName.set(out.name, {
        id:                  r.id,
        name:                out.name,
        version:             out.version || 1,
        class_hint:          out.class_hint,
        trigger_pattern:     out.trigger_pattern,
        triggers:      out.triggers || [],
        preconditions:       out.preconditions || [],
        recipe:              out.recipe || [],
        evidence_of_success: out.evidence_of_success || [],
        ts:                  r.timestamp
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// Retrieve top-K skills relevant to a goal. Used by planning-prompt
// builders to surface "you have learned to do this kind of thing this
// way" as procedural-memory context — NOT as a separate available-tools
// list (core design anti-drift item 2).
//
// Scoring: text overlap on (goal_text + class) against (trigger_pattern
// + name + recipe-step-names), boosted by triggers hit count.
function retrieveRelevant(opts) {
  opts = opts || {};
  const goalText  = String(opts.goal_text || '');
  const goalClass = opts.goal_class || null;
  const k         = Math.max(1, Math.min(10, opts.limit || 3));

  const skills = listSkills({ class_hint: goalClass || undefined, limit: 500 });
  if (!skills.length) return [];

  const qTokens = new Set(_tokenize(goalText).filter(t => t.length >= 4 && !STOP_WORDS.has(t)));
  if (!qTokens.size) return [];

  const scored = [];
  for (const s of skills) {
    const blob = [
      s.trigger_pattern || '',
      s.name || '',
      (s.recipe || []).map(r => r.step_name + ' ' + r.action_description).join(' ')
    ].join(' ').toLowerCase();
    const bTokens = new Set(_tokenize(blob).filter(t => t.length >= 4));
    let overlap = 0;
    for (const t of qTokens) if (bTokens.has(t)) overlap++;
    let triggerHit = 0;
    for (const t of (s.triggers || [])) if (qTokens.has(t)) triggerHit++;
    if (overlap === 0 && triggerHit === 0) continue;
    // Weights: trigger tokens (the fingerprint the operator annotated)
    // worth more than incidental recipe-text overlap.
    const score = (triggerHit / Math.max(1, (s.triggers || []).length)) * 0.6
                + (overlap / qTokens.size) * 0.4;
    scored.push({ skill: s, score: Number(score.toFixed(3)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

module.exports = {
  recordSkill,
  rollbackSkill,
  listSkills,
  retrieveRelevant,
  // exposed for tests
  _validateRecipe,
  _topicTokens,
  _findLatestByName,
  _isRolledBack,
  SKILL_SCOPE_PREFIX,
  ROLLBACK_SCOPE
};
