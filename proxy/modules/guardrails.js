// SPDX-License-Identifier: AGPL-3.0-only
// Output guardrails — Portkey-inspired validation functions.
//
// Research [MW]: Portkey 21-function plugin for inline validation. We
// implement the high-value subset: regex match, contains, jsonSchema,
// jsonKeys, wordCount, notNull, modelWhitelist, secretLeakDetect.
//
// Used by callers to validate response content meets requirements before
// surfacing to user. Returns { valid: bool, violations: [...] }.

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,                      // API keys (OpenAI/Anthropic style)
  /AKIA[0-9A-Z]{16}/,                          // AWS Access Key
  /AIza[0-9A-Za-z_-]{35}/,                     // Google API key
  /ghp_[a-zA-Z0-9]{36,}/,                      // GitHub personal token
  /-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/, // Private keys
  /xox[baprs]-[a-zA-Z0-9-]{10,}/,              // Slack tokens
];

function regexMatch(text, pattern) {
  return pattern.test(text);
}

function contains(text, needle) {
  return text.indexOf(needle) >= 0;
}

function notNull(value) {
  return value !== null && value !== undefined && value !== '';
}

function wordCount(text, min, max) {
  const words = (text.match(/\S+/g) || []).length;
  return words >= min && words <= max;
}

function detectSecrets(text) {
  const found = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) found.push(pattern.toString().slice(0, 40));
  }
  return found;
}

function modelWhitelist(modelName, allowed) {
  if (!modelName) return false;
  return allowed.some(m => modelName.toLowerCase().includes(m.toLowerCase()));
}

function jsonSchema(value, requiredKeys) {
  if (typeof value !== 'object' || value === null) return false;
  return requiredKeys.every(k => k in value);
}

function jsonKeys(value, allowedKeys) {
  if (typeof value !== 'object' || value === null) return false;
  return Object.keys(value).every(k => allowedKeys.includes(k));
}

// Validate a complete response body against a set of rules
function validateResponse(responseStr, rules) {
  const violations = [];
  rules = rules || {};
  try {
    const data = JSON.parse(responseStr);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

    if (rules.notNull && !notNull(text)) violations.push('NOTNULL: response is empty');
    if (rules.minWords && !wordCount(text, rules.minWords, Infinity)) violations.push('MIN_WORDS: too short (need ' + rules.minWords + ')');
    if (rules.maxWords && !wordCount(text, 0, rules.maxWords)) violations.push('MAX_WORDS: too long (max ' + rules.maxWords + ')');
    if (rules.mustContain) {
      for (const needle of rules.mustContain) {
        if (!contains(text, needle)) violations.push('MUST_CONTAIN: missing "' + needle + '"');
      }
    }
    if (rules.mustNotContain) {
      for (const needle of rules.mustNotContain) {
        if (contains(text, needle)) violations.push('MUST_NOT_CONTAIN: found "' + needle + '"');
      }
    }
    // Always run secret detection — high-value default
    const secrets = detectSecrets(text);
    if (secrets.length) violations.push('SECRET_LEAK: detected potential credentials in response');
  } catch (e) {
    violations.push('PARSE_ERROR: ' + e.message);
  }
  return { valid: violations.length === 0, violations };
}

module.exports = {
  regexMatch, contains, notNull, wordCount, detectSecrets,
  modelWhitelist, jsonSchema, jsonKeys, validateResponse,
};
