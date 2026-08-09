// SPDX-License-Identifier: AGPL-3.0-only
// path-policy.js — L4 Wall 6: Write/Edit destination policy.
//
// permission.js gates WHICH tools may write (capability scope, auto_write).
// bash-safety.js refuses dangerous shell shapes pre-dispatch. But neither
// looks at WHERE Write/Edit point on disk. A prompt-injected partner with
// the code/edit step's allow list could write to /etc/passwd, ~/.ssh/
// authorized_keys, or the credential vault file itself.
//
// Two layers, mirroring bash-safety:
//
//   1. Path blocklist — system-critical paths the partner has no legitimate
//      reason to mutate. Operator-deliberate override is via the explicit
//      operator_request{kind:'approval', detail:{plan:"write to /etc/X"}}
//      path; not via a config knob (deliberate friction so a config typo
//      can't widen the attack surface).
//
//   2. Audience trip-wire — once external content is in the agentic loop
//      (subsystem sticky flag), ALL Write/Edit are refused. Same logic as
//      Bash: untrusted text could prompt-inject a write target.
//
// API:
//   isWritablePath(absPath, ctx) → { allowed, reason?, pattern?, detail? }
//
// Path normalization: caller passes the resolved absolute path (Write/Edit
// already do this for atomic-rename). This module does NOT do its own
// resolution — symlink-following is the caller's responsibility (Write
// tool uses fs.realpath before atomic rename).

const path = require('path');
const fs = require('fs');
const os   = require('os');

const HOME = process.env.HOME || os.homedir();

function _expandHome(p) {
  // Operator-readable patterns use ~/; expand to absolute HOME.
  if (typeof p !== 'string') return p;
  return p.replace(/^~\//, HOME + '/');
}

// Canonical blocked-path PREFIXES. Any absolute path that starts with one
// of these is refused. Order doesn't matter — first match wins on report.
// Keep TIGHT: every entry maps to a real attacker objective.
//
// A file entry matches by PREFIX, not by whole name, so ~/.zshrc also covers
// ~/.zshrc.local and ~/.env also covers ~/.envrc. That reads like sloppiness
// and is kept deliberately: both of those siblings are executed by the same
// startup path as the file named here, so blocking them is the answer the
// list would give anyway. The cost is that an inert neighbour such as
// config.json.example is refused too, which is an annoyance rather than a
// hole. Directory entries end in / and match only real children, so no
// entry here can capture a sibling directory that merely shares a prefix.
const BLOCKED_PREFIXES = Object.freeze([
  { name: 'etc',                prefix: '/etc/',                      why: 'system config — /etc/ holds OS-level config; partner writes here are privilege escalation' },
  { name: 'private_etc',        prefix: '/private/etc/',              why: 'macOS canonical /etc/ — same risk as /etc/' },
  { name: 'usr',                prefix: '/usr/',                      why: 'system binaries + libs; never partner-writable' },
  { name: 'sbin',               prefix: '/sbin/',                     why: 'system binaries; never partner-writable' },
  { name: 'bin',                prefix: '/bin/',                      why: 'system binaries; never partner-writable' },
  { name: 'macos_system',       prefix: '/System/',                   why: 'macOS system root — SIP-protected; writes are exfiltration attempts' },
  { name: 'macos_library',      prefix: '/Library/System/',           why: 'macOS system Library — daemon/launchd plists live here' },
  { name: 'launchdaemons',      prefix: '/Library/LaunchDaemons/',    why: 'launchd persistence — writes here are rootkit installation' },
  { name: 'launchagents',       prefix: '/Library/LaunchAgents/',     why: 'launchd persistence (user); writes here are persistence-implant' },
  { name: 'home_launchagents',  prefix: _expandHome('~/Library/LaunchAgents/'), why: 'launchd user-agent persistence — common malware persistence anchor' },
  { name: 'ssh_dir',            prefix: _expandHome('~/.ssh/'),       why: 'SSH credentials — writes here are credential implant or backdoor key insertion' },
  { name: 'aws_dir',            prefix: _expandHome('~/.aws/'),       why: 'AWS credentials — writes here are credential implant' },
  { name: 'gcp_dir',            prefix: _expandHome('~/.config/gcloud/'), why: 'GCP credentials — writes here are credential implant' },
  { name: 'credential_vault',   prefix: _expandHome('~/.troth/credentials.json'), why: 'L4 credential vault file — operator-only via dashboard/CLI' },
  { name: 'credential_vault_tmp', prefix: _expandHome('~/.troth/credentials.json.tmp'), why: 'L4 credential vault temp file (atomic-write target)' },
  { name: 'web_allowlist',      prefix: _expandHome('~/.troth/web-allowlist.json'), why: 'L4 web allowlist — operator-deliberate; not partner-writable' },
  { name: 'web_allowlist_tmp',  prefix: _expandHome('~/.troth/web-allowlist.json.tmp'), why: 'L4 web allowlist temp file (atomic-write target)' },
  { name: 'mcp_clients',        prefix: _expandHome('~/.troth/mcp-clients.json'), why: 'external MCP registry — operator-only; a partner-written entry is self-authorization' },
  { name: 'mcp_clients_tmp',    prefix: _expandHome('~/.troth/mcp-clients.json.tmp'), why: 'external MCP registry temp file (atomic-write target)' },
  // router.json is the gateway's OWN registry: every entry names a command
  // and its args, and the router spawns them. That is the same grant as a
  // hook entry in settings.json — one write buys arbitrary execution at the
  // next start — so it belongs beside mcp-clients.json, not outside the
  // list. It was missing while its sibling registry was blocked. Written
  // legitimately by `troth install-plugin` migration (bin/troth.js:441),
  // which runs as the operator through the CLI, not through this layer.
  { name: 'mcp_router',         prefix: _expandHome('~/.troth/router.json'), why: 'MCP router registry — each entry names a command the router spawns; a partner-written entry is arbitrary execution' },
  { name: 'mcp_router_tmp',     prefix: _expandHome('~/.troth/router.json.tmp'), why: 'MCP router registry temp file (atomic-write target)' },
  // DELIBERATELY NOT BLOCKED: ~/.troth/mcp-pending.json (+ its .tmp), the
  // staged-registration parking lot.
  // The partner STAGES a server there via mcp_register_request; the file is
  // inert (mcp-client loadDownstream never reads it), so a pending entry can
  // never resolve for mcp_list/mcp_call. Activation stays operator-only:
  // `troth mcp approve <name>` moves the entry into mcp-clients.json (the
  // blocked prefix above) and seals capability:mcp:<name>. The prefix match
  // on mcp-clients.json does not catch mcp-pending.json (different basename,
  // and prefix rules match from index 0). Pinned both ways by suite-18.
  { name: 'l4_config',          prefix: _expandHome('~/.troth/config.json'), why: 'L4 master config — operator-only' },
  // The substrate database. It was absent from this list while every OTHER
  // ~/.troth registry was on it, so the one file holding the partner's whole
  // memory was the one file a shell could rewrite. The prefix also covers the
  // -wal and -shm siblings, which are the same database.
  { name: 'substrate_db',       prefix: _expandHome('~/.troth/state.db'), why: 'the substrate database — a shell write here rewrites the partner\'s memory outside every audited path' },
  { name: 'shell_rc',           prefix: _expandHome('~/.bashrc'),     why: 'shell init — persistence-implant anchor' },
  { name: 'shell_rc_zsh',       prefix: _expandHome('~/.zshrc'),      why: 'shell init — persistence-implant anchor' },
  { name: 'shell_rc_profile',   prefix: _expandHome('~/.profile'),    why: 'shell init — persistence-implant anchor' },
  { name: 'shell_rc_bash_profile', prefix: _expandHome('~/.bash_profile'), why: 'shell init — persistence-implant anchor' },
  // ~/.zshenv is the STRONGEST zsh anchor: sourced by EVERY invocation,
  // including non-interactive `zsh -c` — and our own CLI installer writes it,
  // proof the write is trivially reachable. Was missing from this list while
  // the weaker.zshrc was blocked. The
  // installers are unaffected: they write via std::fs (Rust app), not the
  // partner Write/Edit tools that consult this policy.
  { name: 'shell_env_zsh',      prefix: _expandHome('~/.zshenv'),     why: 'shell init (every zsh invocation, incl. non-interactive) — the strongest zsh persistence-implant anchor' },
  { name: 'shell_zprofile',     prefix: _expandHome('~/.zprofile'),   why: 'shell init (zsh login) — persistence-implant anchor' },
  { name: 'shell_zlogin',       prefix: _expandHome('~/.zlogin'),     why: 'shell init (zsh login, post-rc) — persistence-implant anchor' },
  { name: 'shell_bash_login',   prefix: _expandHome('~/.bash_login'), why: 'shell init (bash login fallback) — persistence-implant anchor' },
  // Agent-host config carries the same weight as a shell rc file: a hook
  // entry in settings.json runs an arbitrary command on every tool use, so a
  // single write buys persistent execution by exactly the reasoning that
  // blocks ~/.zshenv above. The setup wizard still writes these, but it does
  // so through the CLI after asking the operator, not through this layer.
  { name: 'agent_host_settings',      prefix: _expandHome('~/.claude/settings.json'),        why: 'agent-host hooks — a hook entry executes an arbitrary command on every tool use' },
  { name: 'agent_host_settings_tmp',  prefix: _expandHome('~/.claude/settings.json.tmp'),    why: 'agent-host hooks (atomic-write target)' },
  { name: 'agent_host_settings_local', prefix: _expandHome('~/.claude/settings.local.json'), why: 'agent-host hooks (local override) — same execution reach' },
  { name: 'agent_host_hooks',         prefix: _expandHome('~/.claude/hooks/'),               why: 'agent-host hook scripts — written here, executed by the host' },
  { name: 'agent_host_plugins',       prefix: _expandHome('~/.claude/plugins/'),             why: 'agent-host plugin install root — a plugin is code the host loads' },
  { name: 'agent_host_agents',        prefix: _expandHome('~/.claude/agents/'),              why: 'agent-host subagent definitions — instructions the host executes unprompted' },
  // Whole fish startup tree: config.fish + conf.d/*.fish are ALL auto-sourced
  // at fish startup (we ship a conf.d drop-in ourselves — same reachability
  // proof as .zshenv).
  { name: 'fish_config_dir',    prefix: _expandHome('~/.config/fish/'), why: 'fish startup tree (config.fish + conf.d auto-sourced) — persistence-implant anchor' },
  { name: 'shell_envrc',        prefix: _expandHome('~/.env'),        why: 'env-var init — secret-leak vector' }
]);

// Strict-taint switch (default OFF). See the Layer-2 comment in isWritablePath.
function _strictTaint() {
  return /^(1|true|on|yes)$/i.test(String(process.env.TROTH_TAINT_STRICT || ''));
}

// Does the filesystem treat two spellings of one name as the same file?
//
// This decides whether the prefix comparison below may be case-sensitive.
// On a stock Mac it may not: APFS is case-INSENSITIVE by default, so
// ~/.SSH/authorized_keys and ~/.ssh/authorized_keys are one file, and a
// case-sensitive compare refuses the second spelling while permitting the
// first — a write through the permitted spelling lands in the refused file.
// realpath does not rescue this: macOS returns the spelling it was given,
// not the one stored on disk, so an all-caps ancestor survives resolution.
//
// The probe asks the filesystem instead of guessing: stat the path, stat a
// case-flipped spelling of its last component, and compare inode + device.
// Same file under both names means insensitive. Linux answers no and keeps
// its correct case-sensitive behaviour; a case-sensitive volume on a Mac
// answers no too, which is right for that volume.
//
// If the probe cannot run at all, fall back on the platform default, biased
// toward insensitive on darwin/win32. Over-blocking a genuinely distinct
// ~/.SSH is a cost nobody pays in practice; under-blocking is the hole.
let _caseFoldCache = null;
function _flipLastComponent(p) {
  const dir  = path.dirname(p);
  const base = path.basename(p);
  let flipped = '';
  for (const ch of base) {
    const lo = ch.toLowerCase(), up = ch.toUpperCase();
    flipped += (ch === lo && lo !== up) ? up : lo;
  }
  return flipped === base ? null : path.join(dir, flipped);
}
function _caseFolds() {
  if (_caseFoldCache !== null) return _caseFoldCache;
  _caseFoldCache = (process.platform === 'darwin' || process.platform === 'win32');
  try {
    const probe = HOME && fs.existsSync(HOME) ? HOME : path.sep;
    const other = _flipLastComponent(probe);
    if (other) {
      const a = fs.statSync(probe);
      let b = null;
      try { b = fs.statSync(other); } catch (_) { b = null; }
      _caseFoldCache = !!(b && a.ino === b.ino && a.dev === b.dev);
    }
  } catch (_) { /* keep the platform default */ }
  return _caseFoldCache;
}
// Comparison key for a path: identity where spelling matters, folded where
// the filesystem itself ignores it.
function _key(p) {
  return _caseFolds() ? String(p).toLowerCase() : String(p);
}


// The literal prefix plus its realpath form.
//
// Only a SUCCESSFUL resolution is cached. A protected directory often does
// not exist yet on a fresh machine, and caching that miss would freeze the
// literal form forever: the first call would decide there is no /private
// twin, and every later call, including ones made after the directory
// appears, would keep comparing against a prefix the filesystem no longer
// reports. That is precisely how a resolved target can sit under
// /private/var/... while the rule still reads /var/... and matches nothing.
const _prefixFormCache = new Map();
function _prefixForms(prefix) {
  const cached = _prefixFormCache.get(prefix);
  if (cached) return cached;
  const forms = [prefix];
  try {
    const trailing = prefix.endsWith('/');
    // Same ancestor walk the target paths get: a protected FILE (~/.zshenv)
    // usually does not exist, but the directory holding it does, and that
    // directory is where the /private twin comes from.
    const resolved = _resolveSymlinks(prefix.replace(/\/$/, ''));
    const withSlash = trailing ? resolved + '/' : resolved;
    if (withSlash !== prefix) forms.push(withSlash);
    // Only memoise once the ancestor actually resolved to something else;
    // otherwise recompute, because the directory may appear later.
    if (withSlash !== prefix) _prefixFormCache.set(prefix, forms);
  } catch (_) { /* not there yet: recompute next time rather than memoise a miss */ }
  return forms;
}

function isWritablePath(targetPath, ctx) {
  if (typeof targetPath !== 'string' || !targetPath.length) {
    return { allowed: false, reason: 'empty_path' };
  }

  // Layer 2 — external-content trip-wire (CaMeL taint). OFF BY DEFAULT.
  // Blocking ALL writes after any web_fetch makes the core "research → build"
  // workflow impossible (the partner can't write the app it just designed). It
  // also had no cwd carve-out and no working approval escape despite the hints,
  // so it dead-ended the operator. The REAL protections stay on regardless:
  // BLOCKED_PREFIXES below (sensitive targets: ssh/etc/launchd/creds), the
  // bash-safety dangerous-shapes (incl. exfiltrate_credentials), the web
  // allowlist (outbound), and the sandbox on the autonomous (l4_step) path.
  // Opt into the hard block with TROTH_TAINT_STRICT=1 (unattended/enterprise).
  // The taint FLAG itself still drives memory-audience provenance (runner.js).
  if (ctx && ctx._l4_external_seen === true && _strictTaint()) {
    return {
      allowed:  false,
      reason:   'external_content_taint',
      detail:   'Write/Edit refused (TROTH_TAINT_STRICT) while external (web-fetched) content is in the agentic loop.'
    };
  }

  // Normalize: resolve any leading ~/ then path.resolve for absolute.
  const expanded = _expandHome(targetPath);
  const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);

  // Follow symlinks before judging. path.normalize only removes '..'; it
  // cannot see that./notes is a link to ~/.ssh, so until  a link
  // planted anywhere inside an authorised root carried a write straight out
  // of it: isWritablePath said allowed for a path whose real target it
  // refused by name. Both the literal path and its resolved target are
  // checked from here on, so neither the link nor the destination can be the
  // one that slips.
  const real = _resolveSymlinks(abs);

  // Layer 1 — blocklist. Prefix match against the resolved absolute path.
  // Use path.normalize so /etc/../etc/ doesn't slip through.
  for (const entry of BLOCKED_PREFIXES) {
    // Compare against the prefix as written AND as the filesystem sees it.
    // On macOS /tmp and /var are themselves symlinks into /private, so a
    // resolved target legitimately reads /private/var/... while the prefix
    // reads /var/...; without this the resolution added above would miss
    // exactly the paths it was introduced to catch.
    for (const prefix of _prefixForms(entry.prefix)) {
      const bare = prefix.replace(/\/$/, '');
      for (const candidate of (real === abs ? [abs] : [abs, real])) {
        // Compared through _key so a case-folding filesystem cannot be
        // handed the same file under a spelling this list does not match.
        if (_key(candidate) === _key(bare) || _key(candidate).indexOf(_key(prefix)) === 0) {
          return {
            allowed:  false,
            reason:   'blocked_system_path',
            pattern:  entry.name,
            detail:   entry.why,
            path:     candidate,
            // Named so the refusal explains itself when the two differ: the
            // model asked for one path and the filesystem points at another.
            via:      candidate === real && real !== abs ? abs : undefined
          };
        }
      }
    }
  }

  return { allowed: true, path: abs };
}

// Resolve a path through symlinks even when it does not exist yet.
//
// Two shapes have to be caught. A link in a PARENT directory is found by
// realpath on the deepest existing ancestor. A link as the FINAL component
// pointing at something that does not exist yet is invisible to realpath,
// which fails outright, so it is read directly: a dangling link is not a
// harmless one, because writing through it is what creates the target.
function _resolveSymlinks(abs) {
  let current = abs;
  for (let hops = 0; hops < 40; hops++) {
    let head = current;
    const tail = [];
    let resolvedHead = null;
    for (;;) {
      try { resolvedHead = fs.realpathSync(head); break; }
      catch (_) {
        const parent = path.dirname(head);
        if (parent === head) break;
        tail.unshift(path.basename(head));
        head = parent;
      }
    }
    const next = resolvedHead ? (tail.length ? path.join(resolvedHead, ...tail) : resolvedHead) : current;
    let link = null;
    try { if (fs.lstatSync(next).isSymbolicLink()) link = fs.readlinkSync(next); } catch (_) { /* not a link */ }
    if (!link) return next;
    current = path.isAbsolute(link) ? path.normalize(link) : path.resolve(path.dirname(next), link);
  }
  // A link cycle deep enough to exhaust the hop budget is itself suspicious;
  // hand back what we have so the blocklist still gets a look at it.
  return current;
}


// ---------------------------------------------------------------------------
// Read policy.
//
// isWritablePath answers "may this be MUTATED". Nothing answered "may this be
// READ", and they are different questions wanting different lists: /usr/ and
// /etc/ must never be written and are read constantly, while a project's .env
// is rewritten by its owner every day and is the single file least suited to
// being handed to a model. Because no read policy existed at all, a plain
// `cat` of a credential file reached no policy — there was nothing to refuse
// it with, so it was not that the wall was weak, it was that no wall was
// consulted.
//
// Two rules, because one shape cannot cover both cases.

// 1. By LOCATION — directories and files whose entire purpose is holding
//    secrets. Everything under them is refused.
const SECRET_READ_PREFIXES = Object.freeze([
  { name: 'ssh_keys',         prefix: _expandHome('~/.ssh/'),                     why: 'SSH private keys and host inventory — the contents ARE the credential' },
  { name: 'aws_creds',        prefix: _expandHome('~/.aws/'),                     why: 'AWS credential and config store' },
  { name: 'gcp_creds',        prefix: _expandHome('~/.config/gcloud/'),           why: 'GCP credential store' },
  { name: 'gnupg',            prefix: _expandHome('~/.gnupg/'),                   why: 'GnuPG secret keyring' },
  { name: 'kube_config',      prefix: _expandHome('~/.kube/'),                    why: 'a kubeconfig is a live cluster token' },
  { name: 'docker_config',    prefix: _expandHome('~/.docker/config.json'),       why: 'container registry auth tokens' },
  { name: 'gh_hosts',         prefix: _expandHome('~/.config/gh/hosts.yml'),      why: 'GitHub CLI OAuth token' },
  { name: 'keychains',        prefix: _expandHome('~/Library/Keychains/'),        why: 'macOS keychain databases' },
  { name: 'agent_host_creds', prefix: _expandHome('~/.claude/.credentials.json'), why: 'agent-host OAuth credentials' },
  { name: 'troth_vault',      prefix: _expandHome('~/.troth/credentials.json'),   why: 'the partner credential vault' },
  // Every archived tool output lives in the substrate, which is where secrets
  // that were once printed to a terminal now sit at rest. The substrate tools
  // apply their own policy on the way out; a raw sqlite3 read is the way
  // around all of it.
  { name: 'substrate_db',     prefix: _expandHome('~/.troth/state.db'),           why: 'the substrate database — a raw read bypasses every substrate-level policy' },
  { name: 'unix_shadow',      prefix: '/etc/shadow',                              why: 'system password hashes' },
  { name: 'unix_master_pw',   prefix: '/etc/master.passwd',                       why: 'system password hashes (BSD/macOS)' },
  { name: 'unix_master_pw_p', prefix: '/private/etc/master.passwd',               why: 'system password hashes (macOS canonical path)' }
]);

// 2. By NAME, anywhere on disk. A prefix list can only protect paths that live
//    where it expects, and the file that actually leaked did not: a project's
//    .env sits under ~/Documents/<whatever>/, which no home-anchored prefix
//    will ever name. Matching the basename is the only rule that reaches it.
//
//    A bare `.key` extension is deliberately absent. It is common enough in
//    ordinary source trees that refusing it would teach people the wall is
//    noise, and a wall people route around protects nothing. The private-key
//    shapes worth having are named explicitly instead.
const SECRET_READ_NAMES = Object.freeze([
  { name: 'dotenv',       test: (b) => /^\.env(\..+)?$/i.test(b),                              why: 'a .env file is a credential file by convention' },
  { name: 'private_key',  test: (b) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[_.-][\w.-]+)?$/i.test(b), why: 'SSH private key' },
  { name: 'key_material', test: (b) => /\.(?:pem|p12|pfx|jks|keystore|asc)$/i.test(b),         why: 'key or certificate material' },
  { name: 'netrc',        test: (b) => /^_?\.?netrc$/i.test(b),                                why: 'netrc holds plaintext login credentials' },
  { name: 'pgpass',       test: (b) => /^\.pgpass$/i.test(b),                                  why: 'PostgreSQL password file' },
  { name: 'npmrc',        test: (b) => /^\.npmrc$/i.test(b),                                   why: 'npm registry auth token' },
  { name: 'pypirc',       test: (b) => /^\.pypirc$/i.test(b),                                  why: 'PyPI upload credentials' }
]);

// Names that match a rule above and hold nothing worth protecting. Checked
// first, and against the LOCATION rules too, so ~/.ssh/id_rsa.pub stays
// readable: a wall that refuses the file whose whole job is to be published
// is the kind of wall people stop believing.
const SECRET_READ_EXEMPT = Object.freeze([
  /\.pub$/i,
  /^\.env\.(?:example|sample|template|dist|defaults?|schema)$/i,
  /^\.npmrc\.example$/i
]);

function _isExemptName(base) {
  return SECRET_READ_EXEMPT.some((re) => re.test(base));
}

// isReadablePath(absPath, ctx) → { allowed, reason?, pattern?, detail?, path?, via? }
//
// Same normalization and symlink resolution as isWritablePath, for the same
// reason: ./notes pointing at ~/.ssh/id_rsa is a read of the key whatever the
// spelling asked for.
function isReadablePath(targetPath, ctx) {
  if (typeof targetPath !== 'string' || !targetPath.length) {
    return { allowed: false, reason: 'empty_path' };
  }
  const expanded = _expandHome(targetPath);
  const abs  = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
  const real = _resolveSymlinks(abs);

  for (const candidate of (real === abs ? [abs] : [abs, real])) {
    const base = path.basename(candidate);
    if (_isExemptName(base)) continue;
    const via = candidate === real && real !== abs ? abs : undefined;

    for (const entry of SECRET_READ_PREFIXES) {
      for (const prefix of _prefixForms(entry.prefix)) {
        const bare = prefix.replace(/\/$/, '');
        if (_key(candidate) === _key(bare) || _key(candidate).indexOf(_key(prefix)) === 0) {
          return { allowed: false, reason: 'blocked_secret_read', pattern: entry.name,
                   detail: entry.why, path: candidate, via };
        }
      }
    }
    for (const entry of SECRET_READ_NAMES) {
      if (entry.test(base)) {
        return { allowed: false, reason: 'blocked_secret_read', pattern: entry.name,
                 detail: entry.why, path: candidate, via };
      }
    }
  }
  return { allowed: true, path: abs };
}


module.exports = {
  isWritablePath,
  isReadablePath,
  SECRET_READ_PREFIXES,
  SECRET_READ_NAMES,
  BLOCKED_PREFIXES,
  // exposed for tests
  _expandHome
};
