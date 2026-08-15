// SPDX-License-Identifier: AGPL-3.0-only
// A decision worth remembering is a strategy a weaker mind can re-run.
//
// The measured findings this shape stands on: distilled strategy items beat
// raw trajectories AND beat workflow abstractions; the reasoning's STRUCTURE
// is the transferable payload while exact content is secondary; a contrastive
// wrong-turn (mistake → why it fails → correct move) is the single
// best-performing addition; an abstraction ships WITH one grounding example
// because abstraction alone loses to the raw trace; trace-source quality can
// invert the whole effect, so provenance is a required field, not metadata;
// and 500-750 tokens is the measured sweet spot with verbose records costing
// roughly eight points per log-unit of length.
//
// The record is stored as a TEMPLATED STATEMENT, not as structured columns:
// the statement is the currency every recall path already carries, so every
// existing surface renders a decision with zero new renderers, and FTS
// indexes the WHEN line — the situation key — for free. Sections are ordered
// so truncation degrades gracefully: what transfers most survives longest.
// The composer is the only writer of the template; hand-written imitations
// drift, so the shape lives here once.

'use strict';

const CEILINGS = {
  strategy: 60,    // a name, not a paragraph
  trigger: 200,    // the situation shape this applies to
  step: 120,       // one move of the skeleton
  steps_max: 7,    // beyond this it is a transcript again
  contrast: 160,   // per contrast field
  example: 240,    // one grounding instance
  total: 3000      // ~750 tokens — the measured ceiling
};

const VERDICTS = ['operator_confirmed', 'test_passed', 'critic_confirmed', 'unverified'];

function _clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Validate the six fields. Returns { ok } or { ok:false, error, detail }.
function validate(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'bad_input', detail: 'object required' };
  if (!d.strategy || !String(d.strategy).trim()) return { ok: false, error: 'missing_strategy', detail: 'a decision record is named or it is noise' };
  if (!d.trigger || !String(d.trigger).trim()) return { ok: false, error: 'missing_trigger', detail: 'without a when-to-use, the record can never be selected' };
  if (!Array.isArray(d.steps) || d.steps.length < 2) return { ok: false, error: 'missing_steps', detail: 'the skeleton needs at least two moves — one move is a tip, not a strategy' };
  if (d.steps.length > CEILINGS.steps_max) return { ok: false, error: 'too_many_steps', detail: 'more than ' + CEILINGS.steps_max + ' steps is a transcript; distill it' };
  if (d.contrast) {
    const c = d.contrast;
    if (!c.mistake || !c.why || !c.correct) return { ok: false, error: 'partial_contrast', detail: 'contrast needs all three: mistake, why, correct' };
  }
  if (!d.provenance || !d.provenance.model) return { ok: false, error: 'missing_provenance', detail: 'who reasoned this matters — weak-source traces poison stronger consumers' };
  if (VERDICTS.indexOf(d.provenance.verdict || 'unverified') === -1) {
    return { ok: false, error: 'bad_verdict', detail: 'verdict must be one of: ' + VERDICTS.join('|') };
  }
  return { ok: true };
}

// Compose the templated statement. Sections in transfer order: the name and
// the situation key first, the skeleton next, contrast, then the example,
// provenance last — clipping from the tail never removes the shape.
function compose(d) {
  const v = validate(d);
  if (!v.ok) return v;
  const lines = [];
  lines.push('DECISION — ' + _clip(d.strategy, CEILINGS.strategy));
  lines.push('WHEN: ' + _clip(d.trigger, CEILINGS.trigger));
  lines.push('STEPS:');
  d.steps.forEach((s, i) => lines.push('  ' + (i + 1) + '. ' + _clip(s, CEILINGS.step)));
  if (d.contrast) {
    lines.push('CONTRAST: ✗ ' + _clip(d.contrast.mistake, CEILINGS.contrast) +
      ' — ' + _clip(d.contrast.why, CEILINGS.contrast) +
      ' → ✓ ' + _clip(d.contrast.correct, CEILINGS.contrast));
  }
  if (d.example) lines.push('EXAMPLE: ' + _clip(d.example, CEILINGS.example));
  lines.push('SOURCE: ' + _clip(d.provenance.model, 60) + ' · ' + (d.provenance.verdict || 'unverified'));

  let statement = lines.join('\n');
  if (statement.length > CEILINGS.total) statement = statement.slice(0, CEILINGS.total - 1) + '…';

  // The compact tier for weak consumers: name, situation key, skeleton.
  // Measured: gains vanish below ~3B params and verbose records actively
  // cost accuracy — the small consumer gets the shape and nothing else.
  const compactLines = lines.filter(l =>
    l.startsWith('DECISION') || l.startsWith('WHEN:') || l === 'STEPS:' || /^  \d+\. /.test(l));
  const compact = compactLines.join('\n');

  // The scope slug keys typed retrieval; derived from the strategy name so
  // related decisions cluster without the caller inventing taxonomy.
  const slug = _clip(d.strategy, CEILINGS.strategy).toLowerCase()
    .replace(/[^a-z0-9Ͱ-Ͽ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'unnamed';

  return { ok: true, statement, compact, scope: 'decision:' + slug };
}

module.exports = { compose, validate, CEILINGS, VERDICTS };
