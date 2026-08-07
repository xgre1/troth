// SPDX-License-Identifier: AGPL-3.0-only
// LMQL-style declarative prompting (Lite).
//
// Research [MW]: 26-85% inference cost reduction with declarative prompt
// templates. Full LMQL = different framework with custom syntax. Lite
// version: template variables + constraints in our prompt files.
//
// Templates use {{var}} substitution with optional :constraint. Constraints
// validate before sending. If a constraint fails, the template auto-falls-back
// to a simpler variant.

function fillTemplate(template, vars, constraints) {
  if (!template) return { ok: false, error: 'no template' };
  vars = vars || {};
  constraints = constraints || {};

  let filled = template;
  const seen = new Set();
  const failures = [];
  let m;
  const re = /\{\{(\w+)(?::([^}]+))?\}\}/g;
  while ((m = re.exec(template)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
    const name = m[1];
    const constraint = m[2];
    seen.add(name);
    let val = vars[name];
    if (val === undefined || val === null) {
      return { ok: false, error: 'missing variable: ' + name };
    }
    // Apply constraint — auto-fallback on failure
    if (constraint) {
      const constraintFn = parseConstraint(constraint);
      if (constraintFn && !constraintFn(val)) {
        // Auto-fallback: try to fix the value
        val = autoFallback(val, constraint);
        if (val !== null && constraintFn(val)) {
          failures.push({ name, constraint, action: 'auto-fixed' });
        } else {
          // Strip the variable and its surrounding text
          failures.push({ name, constraint, action: 'stripped' });
          val = '';
        }
      }
    }
    filled = filled.replace(m[0], String(val));
  }
  return { ok: true, prompt: filled, vars: Array.from(seen), fallbacks: failures.length > 0 ? failures : undefined };
}

// Auto-fallback: try to fix a value that fails its constraint.
// Returns fixed value or null if unfixable.
function autoFallback(val, constraint) {
  if (!constraint) return null;
  constraint = constraint.trim();
  // len< constraint: truncate
  if (constraint.startsWith('len<')) {
    var max = parseInt(constraint.slice(4));
    if (typeof val === 'string' && val.length >= max) {
      return val.slice(0, max - 4) + '...';
    }
  }
  // len> constraint: can't pad meaningfully
  if (constraint.startsWith('len>')) return null;
  // type constraint: try coercion
  if (constraint === 'string') return String(val);
  if (constraint === 'number') { var n = Number(val); return isNaN(n) ? null : n; }
  // matches: can't auto-fix regex failures
  return null;
}

// Parse constraint like "len<200", "type:string", "matches:^foo"
function parseConstraint(c) {
  if (!c) return null;
  c = c.trim();
  if (c.startsWith('len<')) {
    const max = parseInt(c.slice(4));
    return (v) => String(v).length < max;
  }
  if (c.startsWith('len>')) {
    const min = parseInt(c.slice(4));
    return (v) => String(v).length > min;
  }
  if (c.startsWith('matches:')) {
    const re = new RegExp(c.slice(8));
    return (v) => re.test(String(v));
  }
  if (c === 'string') return (v) => typeof v === 'string';
  if (c === 'number') return (v) => typeof v === 'number';
  if (c === 'truthy') return (v) => !!v;
  return null;
}

module.exports = { fillTemplate, parseConstraint };
