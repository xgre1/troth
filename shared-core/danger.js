// SPDX-License-Identifier: AGPL-3.0-only
// Destructive-command classifier. Used by the LoopBreaker / VerifyFirst
// chain today for extra-verbose logging, and (v10.1) will gate
// provider-diverse verification — route a second cheap model to
// double-check the intent before the proxy sends an irreversible op.
//
// Pattern-based; intentionally narrow. A false positive here costs the
// user a confirmation prompt, a false negative could wipe their
// machine, so the regex list is short and surgical.

const PATTERNS = [
  // Filesystem nukes
  { kind: 'rm_rf',            re: /\brm\s+-[rf]{1,2}[a-zA-Z]*\s+/i,         severity: 'high'   },
  { kind: 'rm_root',          re: /\brm\s+[-\w\s]*\s+\/\s*$/i,              severity: 'critical' },

  // Git footguns
  { kind: 'git_force_push',   re: /\bgit\s+push\s+(?:-f|--force)(?!-with-lease)/i, severity: 'high' },
  { kind: 'git_reset_hard',   re: /\bgit\s+reset\s+--hard\b/i,              severity: 'high'   },
  { kind: 'git_clean_force',  re: /\bgit\s+clean\s+-[a-z]*f/i,              severity: 'high'   },
  { kind: 'git_branch_delete',re: /\bgit\s+branch\s+-D\b/i,                 severity: 'medium' },
  { kind: 'git_checkout_overwrite', re: /\bgit\s+checkout\s+--\s*[^-]/i,    severity: 'medium' },

  // DB footguns
  { kind: 'sql_drop_table',   re: /\bDROP\s+TABLE\b/i,                      severity: 'critical' },
  { kind: 'sql_drop_database',re: /\bDROP\s+DATABASE\b/i,                   severity: 'critical' },
  { kind: 'sql_truncate',     re: /\bTRUNCATE\s+TABLE\b/i,                  severity: 'high'   },
  { kind: 'sql_delete_where_none', re: /\bDELETE\s+FROM\s+\w+\s*;?\s*$/im, severity: 'critical' },

  // Hook bypass — users should never disable our own safety
  { kind: 'no_verify',        re: /--no-verify\b/i,                         severity: 'medium' },
  { kind: 'no_gpg_sign',      re: /--no-gpg-sign\b|-c\s*commit\.gpgsign=false\b/i, severity: 'medium' },

  // Process nukes
  { kind: 'kill_all_pattern', re: /\bpkill\b.*-9|\bkillall\b/i,              severity: 'medium' },

  // Network / cloud
  { kind: 'curl_pipe_shell',  re: /curl[^|]+\|\s*(?:bash|sh|zsh)\b/i,       severity: 'high'   },
  { kind: 'wget_pipe_shell',  re: /wget[^|]+-O-[^|]*\|\s*(?:bash|sh|zsh)\b/i, severity: 'high' },

  // Force package removal without review
  { kind: 'npm_force_publish',re: /\bnpm\s+publish\b.*(?:--force|-f\b)/i,   severity: 'high'   },
  { kind: 'docker_rm_all',    re: /\bdocker\s+rm\s+-f\s+\$\(docker\s+ps\b/i, severity: 'high' }
];

function classify(command) {
  if (!command || typeof command !== 'string') return null;
  for (const p of PATTERNS) {
    if (p.re.test(command)) {
      return { kind: p.kind, severity: p.severity, pattern: p.re.source.slice(0, 80) };
    }
  }
  return null;
}

function severityWeight(sev) {
  switch (sev) {
    case 'critical': return 3;
    case 'high':     return 2;
    case 'medium':   return 1;
    default:         return 0;
  }
}

module.exports = { classify, severityWeight, PATTERNS };
