// SPDX-License-Identifier: AGPL-3.0-only
// Hook-side error taxonomy — complements proxy/modules/errortax.js which
// classifies API-level (400/429/5xx) errors from upstream LLMs. This
// module classifies TOOL-level errors: what happens when a Bash/Edit/
// Read/MCP call fails in the agent loop, and what recovery hint the
// model should get in context so it doesn't re-attempt the same broken
// thing.
//
// Intentionally pattern-based; zero false positives preferred over
// clever-but-brittle matching. Each classified error yields a one-line
// recovery nudge appended to the model's next turn via additionalContext.

const CLASSES = {
  permission_denied:  'Filesystem / OS permission refused (EACCES)',
  file_not_found:     'Path does not exist (ENOENT)',
  command_not_found:  'Shell command missing from PATH',
  string_not_found:   'Edit old_string mismatch (Edit tool rejection)',
  file_already_exists:'Write target already exists (Write without overwrite)',
  timeout:            'Tool exceeded its time budget',
  network:            'Network / DNS / TLS failure',
  mcp_error:          'MCP server returned an explicit error',
  nonzero_exit:       'Shell command completed with non-zero exit code',
  unknown:            'Unclassified tool failure'
};

const RECOVERY = {
  permission_denied:  'Read-only or owned-by-root path. Prefer writing inside the project dir, or ask the user before escalating privileges.',
  file_not_found:     'Double-check the exact path. Use Glob to confirm existence before the next attempt — do not guess.',
  command_not_found:  'The command is not installed in this environment. Either pick an installed equivalent (e.g. ripgrep→grep, bun→npm) or ask the user to install it.',
  string_not_found:   'The old_string you sent does not exist verbatim. Read the file and copy the exact substring — whitespace and punctuation matter.',
  file_already_exists:'The target file exists. Read it first and Edit, or explicitly confirm you want to overwrite.',
  timeout:            'The operation timed out. Try a narrower scope (smaller directory, tighter grep pattern, shorter command).',
  network:            'Network error — may be transient. If retry fails, check connectivity or use a cached alternative.',
  mcp_error:          'The MCP server returned an error. Check the server name and the required arguments; consider mcp_list if unsure.',
  nonzero_exit:       'Command ran but returned non-zero. Read stderr carefully — the error message usually contains the fix.',
  unknown:            ''
};

function classify(text) {
  const t = (text || '').toString();
  const lower = t.toLowerCase();

  if (/\beacces\b|permission denied|operation not permitted/i.test(t)) return 'permission_denied';
  if (/\benoent\b|no such file or directory|not a directory/i.test(t)) return 'file_not_found';
  if (/command not found|not found in \$?path|: command not found|\bnot installed\b/i.test(t)) return 'command_not_found';
  if (/string(?: to replace)? not found|old_string.*not.*found|does not appear in the file/i.test(t)) return 'string_not_found';
  if (/file already exists|destination.*exists|EEXIST/i.test(t)) return 'file_already_exists';
  if (/\btimed? ?out\b|SIGTERM|operation timeout/i.test(t)) return 'timeout';
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|DNS|getaddrinfo/i.test(t)) return 'network';
  if (/mcp server.*error|jsonrpc.*error|mcp: unknown tool/i.test(lower)) return 'mcp_error';
  if (/\bexit code [1-9]|\bexit: [1-9]|non-zero exit/i.test(t)) return 'nonzero_exit';
  return 'unknown';
}

// Public entrypoint. Returns {class, recovery} or null if no error / unknown.
function diagnose(text) {
  if (!text || typeof text !== 'string') return null;
  const cls = classify(text);
  if (cls === 'unknown') return null;
  return { class: cls, description: CLASSES[cls], recovery: RECOVERY[cls] };
}

// Which failure classes deserve a PERMANENT lesson.
//
// Measured before this existed: 283 durable errortax lessons on one
// substrate, 238 of them infrastructure weather — timeouts, MCP errors
// (76 about a router that had been retired for months), missing paths.
// A timeout is not a lesson; nobody can choose differently next week
// because a server was slow in July. Its recovery hint is worth exactly
// two moments: the failure itself (the hook's immediate context) and the
// next turn or two (the session queue). Persisting it teaches recall that
// "lessons" are noise.
//
// What persists is what changes a future CHOICE: an Edit sent without
// reading the file first, a Write over something that existed, a command
// this machine simply does not have. Those are about how the agent works
// and what this environment is — true next month, worth the shelf.
const DURABLE_CLASSES = new Set(['string_not_found', 'file_already_exists', 'command_not_found']);

function durable(cls) { return DURABLE_CLASSES.has(cls); }

module.exports = { classify, diagnose, durable, CLASSES, RECOVERY };
