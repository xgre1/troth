// SPDX-License-Identifier: AGPL-3.0-only
// Voice profile.
//
// Per the design work Part 2: stable rendering preferences
// (tone, verbosity, format, vocabulary) that survive LLM faculty swaps.
// Every LLM tick reads the current voice_profile and inflects responses
// accordingly. When operator swaps from Claude → local LLM → GPT, the
// SAME voice carries — because voice lives in substrate, not in the
// faculty's weights.
//
// Engram shape (operator-signed, scope='voice_profile'):
//   extra_output: {
//     name:                   'Felix' | null     (partner's identity name)
//     tone:                   'terse' | 'warm' | 'formal' | 'playful' | 'neutral'
//     verbosity:              'minimal' | 'normal' | 'verbose'
//     format_preferences:     { markdown: bool, code_blocks: bool, headers: bool, emoji_ok: bool }
//     vocabulary_preferences: {
//       prefer: ['list', 'of', 'preferred', 'terms'],
//       avoid:  ['list', 'of', 'avoided', 'terms / phrases']
//     }
//     style_examples:         ['short string showing desired voice']    (≤5)
//     notes:                  null | 'free-form operator note'
//     created_at_ms, updated_at_ms
//   }
//
// Tier-constrained supersedes (integration point) means each operator-signed
// voice update retires the prior — `getActiveVoiceProfile` returns
// the latest non-superseded. PLR may add fine-grained drift detection
// in Phase 5; v1 is operator-curated only.

'use strict';

const engram = require('./engram.js');
const opKey  = require('./operator-key.js');

const VOICE_PROFILE_SCOPE = 'voice_profile';

const VALID_TONE      = new Set(['terse', 'warm', 'formal', 'playful', 'neutral']);
const VALID_VERBOSITY = new Set(['minimal', 'normal', 'verbose']);

function _validate(profile) {
  if (!profile || typeof profile !== 'object') return 'profile_required';
  if (profile.tone && !VALID_TONE.has(profile.tone)) {
    return 'invalid_tone: must be one of ' + Array.from(VALID_TONE).join('|');
  }
  if (profile.verbosity && !VALID_VERBOSITY.has(profile.verbosity)) {
    return 'invalid_verbosity: must be one of ' + Array.from(VALID_VERBOSITY).join('|');
  }
  if (profile.format_preferences && typeof profile.format_preferences !== 'object') {
    return 'format_preferences must be an object';
  }
  if (profile.vocabulary_preferences) {
    const vp = profile.vocabulary_preferences;
    if (typeof vp !== 'object') return 'vocabulary_preferences must be an object';
    if (vp.prefer && !Array.isArray(vp.prefer)) return 'vocabulary_preferences.prefer must be an array';
    if (vp.avoid  && !Array.isArray(vp.avoid))  return 'vocabulary_preferences.avoid must be an array';
  }
  if (profile.style_examples) {
    if (!Array.isArray(profile.style_examples)) return 'style_examples must be an array';
    if (profile.style_examples.length > 5) return 'style_examples max 5 entries';
  }
  return null;
}

// Read the most recent voice_profile engram. Returns a parsed object
// with safe defaults when no profile has been written yet, so callers
// (LLM tick context assembly) always get a usable shape.
function getActiveVoiceProfile() {
  const defaults = {
    name: null,
    tone: 'neutral',
    verbosity: 'normal',
    format_preferences: { markdown: true, code_blocks: true, headers: true, emoji_ok: false },
    vocabulary_preferences: { prefer: [], avoid: [] },
    style_examples: [],
    notes: null,
    _exists: false,
    _id: null
  };
  try {
    const rows = engram.listEngrams({
      principal: null, audience: 'all',
      scope: VOICE_PROFILE_SCOPE, limit: 1
    }) || [];
    if (!rows.length) return defaults;
    const row = rows[0];
    // Voice profile fields are NOT in the listEngrams projection — pull
    // raw via state.getAction.
    let body = null;
    try {
      const state = require('./state.js');
      if (state.getAction) {
        const raw = state.getAction(row.id);
        if (raw) body = typeof raw.output === 'string' ? JSON.parse(raw.output) : raw.output;
      }
    } catch (_) {}
    if (!body) return defaults;
    return {
      name:               body.name || null,
      tone:               body.tone || 'neutral',
      verbosity:          body.verbosity || 'normal',
      format_preferences: body.format_preferences ||
        { markdown: true, code_blocks: true, headers: true, emoji_ok: false },
      vocabulary_preferences: body.vocabulary_preferences || { prefer: [], avoid: [] },
      style_examples:     Array.isArray(body.style_examples) ? body.style_examples : [],
      notes:              body.notes || null,
      _exists:            true,
      _id:                row.id,
      _ts:                row.ts
    };
  } catch (_) { return defaults; }
}

// Write (or update) the voice profile. Operator-signed. Tier-constrained
// supersedes retires the prior profile so getActiveVoiceProfile returns
// the latest.
function writeVoiceProfile(opts) {
  opts = opts || {};
  if (!opts.signer || typeof opts.signer.sign !== 'function') {
    return { ok: false, error: 'unlocked_signer_required' };
  }
  const profile = opts.profile || {};
  const invalid = _validate(profile);
  if (invalid) return { ok: false, error: 'invalid_profile: ' + invalid };

  // Merge with existing (partial updates supported — caller passes only
  // fields they want to change).
  const existing = getActiveVoiceProfile();
  const merged = {
    name:               profile.name              !== undefined ? profile.name : existing.name,
    tone:               profile.tone              || existing.tone,
    verbosity:          profile.verbosity         || existing.verbosity,
    format_preferences: profile.format_preferences || existing.format_preferences,
    vocabulary_preferences: profile.vocabulary_preferences || existing.vocabulary_preferences,
    style_examples:     profile.style_examples    || existing.style_examples,
    notes:              profile.notes             !== undefined ? profile.notes : existing.notes,
    created_at_ms:      existing._exists ? (existing.created_at_ms || existing._ts || Date.now()) : Date.now(),
    updated_at_ms:      Date.now()
  };

  const extra = Object.assign({}, merged);
  // Supersede prior profile if any (tier-constrained — both at
  // operator_confirmed tier so integration point accepts).
  if (existing._exists && existing._id) {
    extra.lifetime = { supersedes: existing._id, reason: 'voice_profile_update' };
  }

  const statement = 'voice_profile: ' +
    (merged.name ? merged.name + ' — ' : '') +
    merged.tone + ' / ' + merged.verbosity;
  const canon = opKey.canonicalEngramBody({
    statement,
    scope: VOICE_PROFILE_SCOPE,
    source_authority: 'operator_confirmed',
    extra_output: extra
  });
  const signature = opts.signer.sign(canon);
  const id = engram.recordEngram({
    agent_id: opts.agent_id || 'operator',
    user_id:  opts.user_id  || 'operator',
    cwd:      opts.cwd      || null,
    statement,
    source: 'voice-profile.writeVoiceProfile',
    source_authority: 'operator_confirmed',
    scope: VOICE_PROFILE_SCOPE,
    signature,
    extra_output: extra,
    auto_verify: false
  });
  if (!id) return { ok: false, error: 'voice_profile_write_refused' };
  return { ok: true, id, profile: merged };
}

// Render the active voice profile as a short directive string suitable
// for LLM tick context injection. Compact form so it can sit at the
// top of the system prompt without dominating it.
function renderForTick() {
  const v = getActiveVoiceProfile();
  const lines = [];
  if (v.name) lines.push('Name: ' + v.name);
  lines.push('Tone: ' + v.tone + ' / Verbosity: ' + v.verbosity);
  if (v.vocabulary_preferences && v.vocabulary_preferences.prefer && v.vocabulary_preferences.prefer.length) {
    lines.push('Prefer terms: ' + v.vocabulary_preferences.prefer.slice(0, 6).join(', '));
  }
  if (v.vocabulary_preferences && v.vocabulary_preferences.avoid && v.vocabulary_preferences.avoid.length) {
    lines.push('Avoid: ' + v.vocabulary_preferences.avoid.slice(0, 6).join(', '));
  }
  if (v.style_examples && v.style_examples.length) {
    lines.push('Recent style examples:');
    for (const ex of v.style_examples.slice(0, 3)) {
      lines.push('  - ' + String(ex).slice(0, 140));
    }
  }
  if (v.notes) lines.push('Operator note: ' + String(v.notes).slice(0, 240));
  return lines.join('\n');
}

module.exports = {
  getActiveVoiceProfile,
  writeVoiceProfile,
  renderForTick,
  VOICE_PROFILE_SCOPE,
  VALID_TONE,
  VALID_VERBOSITY,
  // Test surface
  _validate
};
