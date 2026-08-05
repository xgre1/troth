// SPDX-License-Identifier: AGPL-3.0-only
// JSON repair — fix common LLM output errors before parsing.
//
// Models occasionally produce malformed JSON: trailing commas, single quotes,
// unquoted keys, missing closing braces, extra commas. This module attempts
// repair before throwing. Used by tool-call argument parsing.

function tryRepair(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return null;
  // Quick exit if already valid
  try { JSON.parse(jsonStr); return jsonStr; } catch (e) {}

  let s = jsonStr.trim();

  // Strip code fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  // Remove JS-style line comments
  s = s.replace(/\/\/[^\n]*/g, '');
  // Remove block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');

  // Replace single quotes with double quotes (careful with apostrophes inside strings)
  // This is heuristic — only safe for keys and primitive values
  s = s.replace(/'([^']*)'(\s*[:,\]\}])/g, '"$1"$2');
  s = s.replace(/([:\[\,]\s*)'([^']*)'/g, '$1"$2"');

  // Quote unquoted keys: {key: → {"key":
  s = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

  // Remove trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // Try parse
  try { JSON.parse(s); return s; } catch (e) {}

  // Last resort: try adding missing closing braces/brackets
  let opens = (s.match(/\{/g) || []).length;
  let closes = (s.match(/\}/g) || []).length;
  while (opens > closes) { s += '}'; closes++; }
  let arrayOpens = (s.match(/\[/g) || []).length;
  let arrayCloses = (s.match(/\]/g) || []).length;
  while (arrayOpens > arrayCloses) { s += ']'; arrayCloses++; }

  try { JSON.parse(s); return s; } catch (e) { return null; }
}

function safeParse(jsonStr, fallback) {
  const repaired = tryRepair(jsonStr);
  if (!repaired) return fallback === undefined ? null : fallback;
  try { return JSON.parse(repaired); } catch (e) { return fallback === undefined ? null : fallback; }
}

module.exports = { tryRepair, safeParse };
