// SPDX-License-Identifier: AGPL-3.0-only
// slash/parser — split a raw user line into a slash invocation or plain text.
//
// Adopts Claude Code's slash-command shape:
//   "/<name> <args...>"    →  { is_slash:true, name, raw_args, args_array }
//   "anything else"         →  { is_slash:false, text }
//
// Rules:
//   - Leading whitespace ignored before the slash.
//   - Name = chars after `/` up to first whitespace, lowercase-folded so the
//     model and the user can both spell with any case.
//   - Names support letters, digits, `-`, `_` (matches Anthropic's filename
//     rules for SKILL.md). A `/` followed by anything else (e.g. "/", "/123",
//     "/-x") is treated as plain text — never invoked.
//   - raw_args is the verbatim tail (preserves quoting, args with spaces).
//   - args_array is a quote-aware split for `$1..$9` substitution. We honor
//     single + double quotes the way Bourne shell does so the model can pass
//     '"two words"' as a single arg without escape gymnastics.
//   - Empty input or pure whitespace returns { is_slash:false, text:'' }.

const NAME_RE = /^([a-z][a-z0-9_-]*)/i;

function parse(input) {
  if (typeof input !== 'string') return { is_slash: false, text: '' };
  const trimmed = input.replace(/^\s+/, '');
  if (!trimmed.startsWith('/')) {
    return { is_slash: false, text: input };
  }
  const tail = trimmed.slice(1);
  const m = tail.match(NAME_RE);
  if (!m) return { is_slash: false, text: input };
  const name = m[1].toLowerCase();
  // A filesystem PATH is not a command: the
  // operator typed /Users/<name>/Desktop/<project> to point at the project and
  // the parser read it as the command "users" -> unknown_slash -> the whole
  // reply failed. A real slash command never has "/" or "." immediately
  // after its name; a path (/Users/..., /etc/hosts, /file.txt) always does.
  const afterName = tail[m[1].length];
  if (afterName === '/' || afterName === '.') {
    return { is_slash: false, text: input };
  }
  const after = tail.slice(m[1].length).trim();
  return {
    is_slash:    true,
    name,
    raw_args:    after,
    args_array:  splitQuoted(after)
  };
}

function splitQuoted(s) {
  const out = [];
  let cur = '';
  let i = 0;
  let quote = null;          // '\'' | '"' | null
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; i++; continue; }
      // Backslash escapes only inside double quotes (Bourne-ish).
      if (quote === '"' && c === '\\' && i + 1 < s.length) {
        cur += s[i + 1]; i += 2; continue;
      }
      cur += c; i++; continue;
    }
    if (c === '\'' || c === '"') { quote = c; i++; continue; }
    if (/\s/.test(c)) {
      if (cur.length) { out.push(cur); cur = ''; }
      i++; continue;
    }
    cur += c; i++;
  }
  if (cur.length) out.push(cur);
  return out;
}

module.exports = { parse, splitQuoted };
