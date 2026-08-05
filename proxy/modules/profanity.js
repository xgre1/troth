// SPDX-License-Identifier: AGPL-3.0-only
// Profanity / sentiment filter — flag concerning patterns in agent output.
//
// Useful for: detecting model frustration loops ("this is impossible",
// "I give up"), abusive output, ranting. These are signals the agent is
// stuck and should escalate.

const FRUSTRATION_PATTERNS = [
  /\b(impossible|hopeless|give up|i can't do this|i cannot)\b/i,
  /\b(stupid|broken|terrible|awful)\b.*\b(code|approach|design)\b/i,
  /\b(this (?:is|won't) (?:work|fix))\b/i,
  /\b(refuse to|won't try)\b/i,
  /\bI'm (?:done|stuck|lost)\b/i,
];

function checkText(text) {
  if (!text) return { ok: true, signals: [] };
  const signals = [];
  for (const p of FRUSTRATION_PATTERNS) {
    const m = text.match(p);
    if (m) signals.push(m[0]);
  }
  return { ok: signals.length === 0, signals };
}

function checkResponse(responseStr) {
  try {
    const data = JSON.parse(responseStr);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return checkText(text);
  } catch (e) { return { ok: true, signals: [] }; }
}

module.exports = { checkText, checkResponse };
