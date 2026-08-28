// SPDX-License-Identifier: AGPL-3.0-only
// sandbox-seatbelt.js — macOS Seatbelt (sandbox-exec) adapter: the sandbox
// that exists on EVERY Mac with zero installs.
//
// Why this adapter exists: the selector's first two choices (apple-container,
// docker) are real container runtimes, but a fresh Mac has neither, so in
// practice the selector always landed on bare-exec's refusal and no operator
// ever had a working sandbox. Seatbelt ships inside macOS itself. It is
// weaker than a container (shared kernel, no memory/pid caps) which is why it
// sits BELOW docker in the priority order, but it turns "no isolation on any
// stock Mac" into "deny-default isolation on every stock Mac".
//
// The jail model (deny default, allowances carved in — never a deny-list):
//   * the WORK dir (opts.cwd) is the project: the only writable place, and
//     where downloaded packages land, execute, and stay.
//   * the toolchain (node's own install tree) and the OS runtime dirs are
//     readable/executable so real work (node, npm, git, cc) functions.
//   * everything else — ~/.troth, ~/.ssh, Keychains, Documents — is not
//     denied by name; it simply was never allowed. New secrets are protected
//     by default instead of each needing its own rule.
//   * network is OFF unless the caller asks ('full'), because SBPL cannot
//     scope network per-host; per-destination policy is the egress filter's
//     job one layer up, not this file's.
//
// The child's environment is BUILT, not inherited: whatever secrets ride in
// the parent's process.env stay in the parent. HOME and TMPDIR point inside
// the jail so dotfile-writers and tmp-writers work without touching the real
// home.
//
// API (mirrors docker-sandbox.js for drop-in selector compatibility):
//   isAvailable(opts?)      → { available, version, error? }   (cached 60s)
//   runInSandbox(cmd, opts) → { stdout, stderr, exit_code, interrupted,
//                               sandboxed:true, sandbox_kind:'seatbelt',
//                               elapsed_ms, signal? } | { error, detail, … }
//   opts: { cwd, network: 'none'|'full', timeout_ms, env }
//
// sandbox-exec is marked deprecated in its man page but is what Chromium,
// Bazel and Apple's own daemons ride on; it is exercised (not gone) on every
// current macOS. Availability is probed, never assumed.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS  = 120 * 1000;
const MAX_TIMEOUT_MS      = 600 * 1000;
const MAX_STREAM_BYTES    = 256 * 1024;
const KILL_GRACE_MS       = 2000;
const AVAILABILITY_TTL_MS = 60 * 1000;
const SANDBOX_EXEC        = '/usr/bin/sandbox-exec';
// The policy file lives OUTSIDE every jail, under ~/.troth (which no profile
// ever allows). It used to sit inside WORK, where the jailed process could
// rewrite it: harmless for the run in progress, but a long-lived jailed
// process (dev server, watcher, an MCP bridge) could swap it in the window
// between our write and sandbox-exec's read and hand the NEXT command a
// wide-open policy. Unreachable ground removes the race entirely.
const PROFILE_DIR = path.join((process.env.HOME || os.homedir()), '.troth', 'sandbox-profiles');
// The jail's scratch home and tmp. These used to live in the project as
// .troth-sandbox/, which put npm's cache in the operator's repo: one install
// staged 632 files and 3 MB into their next commit, and even a read-only
// command created the directory. Scratch belongs to the jail, not the work.
const JAIL_SCRATCH_ROOT = path.join((process.env.HOME || os.homedir()), '.troth', 'jails');
function _scratchDirFor(work) {
  // Name for a human reading ~/.troth/jails, hash for uniqueness: two
  // projects called "api" in different trees must not share a home.
  const tag = path.basename(work).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'jail';
  const sum = crypto.createHash('sha256').update(work).digest('hex').slice(0, 12);
  return path.join(JAIL_SCRATCH_ROOT, tag + '-' + sum);
}

let _availabilityCache = { ts: 0, value: null };

function _clip(s) {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_STREAM_BYTES) return s;
  return s.slice(0, MAX_STREAM_BYTES) + '\n…(stream truncated at ' + MAX_STREAM_BYTES + ' bytes)';
}

// A repository hook directory cannot be named as a parameter: it exists once
// per repository, anywhere under whatever ground is writable, so the rule has
// to be a pattern. Every profile ends with it.
//
// The template files a repository creation copies in are the exception, and
// they have to be: creating a repository writes fourteen of them and fails
// hard when refused. Every one ends in .sample, and that suffix is precisely
// what stops the hook running — the tooling executes a hook by exact name and
// never a sample. So the suffix is allowed back and nothing executable is:
// a file staged as a sample still cannot be renamed into place, because the
// rename is a write to the executable name.
const HOOK_DIR_RULE = [
  '(deny file-write* (regex #"/\\.git/hooks/"))',
  '(allow file-write* (regex #"/\\.git/hooks/[^/]*\\.sample$"))'
].join('\n');

// The profile is a constant with -D parameters, never string-concatenated
// paths: a path with a quote in it must not be able to rewrite the policy.
//   WORK     — the jail (read+write+exec)
//   TOOLROOT — node's install tree (read+exec): /opt/homebrew, an nvm
//              version dir, or /usr/local — wherever the running node lives.
function _profile(network) {
  const lines = [
    '(version 1)',
    '(deny default)',
    // Apple's base profile: device nodes, bootstrap lookups, sysctl basics
    // every process needs before main() even runs.
    '(import "system.sb")',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow signal (target same-sandbox))',
    // OS runtime + toolchain: readable and executable, never writable.
    '(allow file-read* process-exec*',
    '  (subpath "/bin") (subpath "/sbin") (subpath "/usr") (subpath "/System")',
    '  (subpath "/Library/Frameworks") (subpath "/Library/Apple")',
    // Apple CLT: /usr/bin/git and friends are shims that exec the real
    // binaries out of /Library/Developer/CommandLineTools.
    '  (subpath "/Library/Developer")',
    '  (subpath (param "TOOLROOT"))',
    // The public software prefixes, always — a jail launched under one node
    // (the app ships its own) still has to reach tools installed under
    // another, and /Applications carries the CLI shims that GUI apps symlink
    // into /usr/local/bin. Read and execute only; they hold no user data.
    '  (subpath "/opt/homebrew") (subpath "/opt/local") (subpath "/usr/local")',
    '  (subpath "/Applications")',
    '  (subpath (param "WORK")) (subpath (param "SCRATCH")))',
    // Config the runtime legitimately reads: TLS roots, resolv, timezone,
    // locale. Read-only; nothing under a user home.
    '(allow file-read*',
    '  (subpath "/private/etc") (subpath "/private/var/db")',
    '  (subpath "/private/var/select") (subpath "/Library/Preferences")',
    '  (subpath "/dev"))',
    // Stat-only metadata everywhere: realpath() walks every ancestor of
    // the toolchain and the jail (npm dies on lstat("/opt") without it).
    // Contents and directory listings outside the allowances stay denied;
    // what this leaks is existence/size/mtime of paths a process names.
    // Chromium's and Safari's hardened profiles accept the same tradeoff.
    // The suite pins that listing a home directory still refuses.
    '(allow file-read-metadata)',
    // The jail is the only writable ground, plus the terminal devices.
    '(allow file-write* (subpath (param "WORK")) (subpath (param "SCRATCH")))',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))',
    // A repository hook is a script the operator's own next git command
    // runs, so a package that drops one inside the writable project has
    // bought execution outside these walls. Denied last, and by pattern
    // rather than by path, because the writable ground IS the project and
    // every repository under it carries the same directory.
    HOOK_DIR_RULE
  ];
  if (network === 'full') {
    // SBPL cannot express "these hosts only", so outbound is all-or-nothing
    // for the public internet. Loopback is the exception that matters and it
    // IS expressible: the operator's own machine runs privileged local
    // services — troth's proxy holds the vault and the engine keys, and a
    // model server, a database or an SSH agent may be listening too. A
    // package the partner installed reaching those would undo the jail
    // without ever touching a file, so loopback is denied after the allow
    // (later rules win in SBPL). Per-destination policy for the public
    // internet remains the egress layer's job, one level up.
    lines.push('(allow network*)');
    lines.push('(allow system-socket)');
    lines.push('(deny network* (remote ip "localhost:*"))');
  } else if (network === 'proxy') {
    // One loopback port and nothing else — the egress proxy's. Measured
    // both ways with a live listener one port over: the grant connects,
    // the neighbour refuses, and the parameter form carries the port so
    // one profile file serves every proxy instance. The child needs no
    // resolver: its proxy environment names the address as an IP literal,
    // and name resolution happens in the host process on the far side.
    lines.push('(allow network-outbound (remote tcp (param "PROXYADDR")))');
  }
  return lines.join('\n') + '\n';
}

// Cheap real probe: run /usr/bin/true under a minimal profile. Catches the
// platform, the binary, AND an OS build where sandbox-exec stopped working —
// availability is proven, not inferred from existsSync.
function isAvailable(opts) {
  opts = opts || {};
  const now = Date.now();
  if (!opts.fresh && _availabilityCache.value && (now - _availabilityCache.ts) < AVAILABILITY_TTL_MS) {
    return _availabilityCache.value;
  }
  let result;
  if (process.platform !== 'darwin') {
    result = { available: false, error: 'seatbelt is macOS-only (platform: ' + process.platform + ')' };
  } else if (!fs.existsSync(SANDBOX_EXEC)) {
    result = { available: false, error: SANDBOX_EXEC + ' not present' };
  } else {
    try {
      // The probe must carry a RESTRICTION, not just launch a profile. A
      // profile that restricts nothing applies even inside an existing
      // sandbox, where every real profile — jail, thin or confine — is
      // refused by the kernel with sandbox_apply: Operation not permitted.
      // Probing with an unrestricted profile therefore reports a usable
      // sandbox in the one environment that has none. The denied path is
      // deliberately one that cannot exist, so the probe measures whether a
      // restriction can be APPLIED and nothing else.
      const r = spawnSync(SANDBOX_EXEC, ['-p',
        '(version 1)(allow default)(deny file-read* (literal "/.troth-sandbox-probe"))',
        '/usr/bin/true'], {
        timeout: 3000, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8'
      });
      result = (r.status === 0)
        ? { available: true, version: 'macos-' + os.release() }
        : { available: false, error: 'probe exit ' + r.status + ': ' + String(r.stderr || '').trim().slice(0, 240) };
    } catch (e) {
      result = { available: false, error: e && e.message || String(e) };
    }
  }
  _availabilityCache = { ts: now, value: result };
  return result;
}

function _resetAvailabilityCache() {
  _availabilityCache = { ts: 0, value: null };
}

// The toolchain tree the jail may read and execute. A package-manager node
// (Homebrew, MacPorts) links dylibs across its whole prefix (node in
// Cellar/node/…/bin, libuv in opt/libuv/…), so the prefix is the unit, not
// the Cellar slice two levels above the binary. Self-contained trees (nvm,
// volta, fnm, the app bundle) really are their own two-levels-up root.
// Read+exec only, never writable; deny-default still hides everything else,
// and a public software prefix holds no secrets.
const TOOL_PREFIXES = ['/opt/homebrew', '/opt/local', '/usr/local'];
function _toolRoot() {
  const real = fs.realpathSync(process.execPath);
  for (const p of TOOL_PREFIXES) {
    if (real === p || real.startsWith(p + '/')) return p;
  }
  return fs.realpathSync(path.dirname(path.dirname(real)));
}

// Environment built from scratch. The parent proxy's env can carry keys and
// tokens; none of that crosses the boundary. HOME/TMPDIR live inside the
// jail so npm caches, dotfile writers and tmp files all land in the project.
// The operator's committing identity, read ONCE from their real git config
// by the parent (the jail cannot see it — HOME is redirected). Without this
// git silently invents one from the hostname and stamps the machine's LAN
// address into every commit made in a workspace project.
let _gitIdent = null;
function _gitIdentity() {
  if (_gitIdent) return _gitIdent;
  _gitIdent = {};
  for (const [key, envName] of [['user.name', 'NAME'], ['user.email', 'EMAIL']]) {
    try {
      const r = spawnSync('git', ['config', '--global', '--get', key],
                          { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      const v = (r.status === 0 && typeof r.stdout === 'string') ? r.stdout.trim() : '';
      if (v) { _gitIdent['GIT_AUTHOR_' + envName] = v; _gitIdent['GIT_COMMITTER_' + envName] = v; }
    } catch (_) { /* no git, or no global config: leave it to git */ }
  }
  return _gitIdent;
}

// Variables that carry REACHABILITY, not identity: without them a corporate
// operator behind a TLS-inspecting proxy cannot resolve a single package.
// They are copied from the parent because there is nowhere else to learn
// them; nothing here is a credential. File-valued CA settings are handled
// separately (the named file is copied INTO the jail, since the original
// path is outside the walls).
const PASSTHROUGH_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'npm_config_registry', 'npm_config_strict_ssl', 'TZ'
];
const CA_FILE_ENV = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];

function _buildEnv(jailHome, jailTmp, toolBin, extra) {
  // The interpreter actually running us goes on PATH by its own directory:
  // deriving it from TOOLROOT + '/bin' is wrong for self-contained trees
  // (troth's packaged app keeps node in Contents/Resources/core, and has no
  // bin/ at all, so the jail found neither node nor npm).
  let ownBin = '';
  try { ownBin = path.dirname(fs.realpathSync(process.execPath)); } catch (_) {}
  const pathParts = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  // ownBin and toolBin first (the interpreter that launched us), then the
  // public prefixes the profile already allows — otherwise a jail running
  // under troth's bundled node finds no npm at all.
  const candidates = [ownBin, toolBin, '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  for (const p of candidates) {
    if (!p || pathParts.indexOf(p) !== -1) continue;
    try { if (fs.existsSync(p)) pathParts.push(p); } catch (_) {}
  }
  const env = {
    PATH:    pathParts.join(':'),
    HOME:    jailHome,
    TMPDIR:  jailTmp,
    LANG:    process.env.LANG || 'en_US.UTF-8',
    TERM:    'dumb',
    npm_config_cache: path.join(jailHome, '.npm'),
    npm_config_update_notifier: 'false'
  };
  for (const k of PASSTHROUGH_ENV) {
    if (typeof process.env[k] === 'string' && process.env[k]) env[k] = process.env[k];
  }
  // A CA bundle named by the parent sits outside the walls, so the file is
  // copied into the jail home and the variable repointed at the copy.
  for (const k of CA_FILE_ENV) {
    const src = process.env[k];
    if (!src || !path.isAbsolute(src)) continue;
    try {
      const dst = path.join(jailHome, 'ca-' + k.toLowerCase() + '.pem');
      fs.copyFileSync(src, dst);
      env[k] = dst;
    } catch (_) { /* unreadable or gone: better no CA var than a dangling one */ }
  }
  // git needs more than the variables: with HOME redirected it falls back to
  // inventing an author from the hostname, which stamps the machine's LAN
  // address into every commit. A jail-local global config carries the real
  // identity when there is one and sets useConfigOnly, so the no-identity
  // case REFUSES with a clear message instead of fabricating one.
  const ident = _gitIdentity();
  Object.assign(env, ident);
  try {
    const oneLine = (v) => String(v || '').replace(/[\r\n]/g, ' ').trim();
    const gitconfig = path.join(jailHome, 'gitconfig');
    fs.writeFileSync(gitconfig,
      '[user]\n'
      + (ident.GIT_AUTHOR_NAME  ? '\tname = '  + oneLine(ident.GIT_AUTHOR_NAME)  + '\n' : '')
      + (ident.GIT_AUTHOR_EMAIL ? '\temail = ' + oneLine(ident.GIT_AUTHOR_EMAIL) + '\n' : '')
      + '\tuseConfigOnly = true\n',
      { mode: 0o600 });
    env.GIT_CONFIG_GLOBAL = gitconfig;
  } catch (_) { /* no scratch home yet: the env vars alone still apply */ }
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (typeof extra[k] === 'string' || typeof extra[k] === 'number') env[k] = String(extra[k]);
    }
  }
  return env;
}

// The jail as a reusable spawn recipe, for callers that keep the child
// ALIVE — an MCP bridge holds a stdio conversation for the whole session,
// so it cannot go through runInSandbox's run-to-exit capture. The caller
// spawns exec + args.concat([its command, ...its args]) with its own pipe
// and lifetime discipline; the walls and the built env are identical.
// jailSpawnSpec({ cwd, network, env }) →
//   { ok:true, exec, args, env, work } | { ok:false, error }
function jailSpawnSpec(opts) {
  opts = opts || {};
  const avail = module.exports.isAvailable();
  if (!avail.available) return { ok: false, error: avail.error || 'sandbox-exec not usable' };
  const network = opts.network === 'full' ? 'full'
    : opts.network === 'proxy' ? 'proxy' : 'none';
  if (network === 'proxy' && !(Number.isInteger(opts.proxyPort) && opts.proxyPort > 0)) {
    return { ok: false, error: 'proxy network mode requires proxyPort' };
  }
  let work;
  try {
    work = fs.realpathSync(opts.cwd);   // symlink-resolved: subpath match is on real paths
  } catch (e) {
    return { ok: false, error: 'cwd unusable: ' + (e && e.message || e) };
  }
  // Jail-internal scratch: fake home + fake tmp, OUTSIDE the project so a
  // 3 MB npm cache never lands in the operator's repo. The policy lives
  // somewhere neither the jail nor the project can reach.
  let scratch    = _scratchDirFor(work);
  let jailHome   = path.join(scratch, 'home');
  let jailTmp    = path.join(scratch, 'tmp');
  const profilePath = path.join(PROFILE_DIR, 'profile-' + network + '.sb');
  let toolRoot;
  try {
    fs.mkdirSync(jailHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(jailTmp,  { recursive: true, mode: 0o700 });
    fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
    // realpath AFTER creation: on macOS /Users and the temp root are
    // symlinked, and an unresolved SCRATCH would not match its own subpath.
    scratch = fs.realpathSync(scratch);
    jailHome = path.join(scratch, 'home');
    jailTmp  = path.join(scratch, 'tmp');
    // Written fresh each time (idempotent, same bytes) so an edited troth
    // ships its new policy immediately instead of reusing a stale file.
    fs.writeFileSync(profilePath, _profile(network), { mode: 0o600 });
    // Homebrew/MacPorts prefix, an nvm version dir, or wherever the running
    // node actually lives — see _toolRoot.
    toolRoot = _toolRoot();
  } catch (e) {
    return { ok: false, error: 'jail_setup_failed: ' + (e && e.message || e) };
  }
  const args = ['-f', profilePath, '-D', 'WORK=' + work,
                '-D', 'TOOLROOT=' + toolRoot, '-D', 'SCRATCH=' + scratch];
  if (network === 'proxy') args.push('-D', 'PROXYADDR=localhost:' + opts.proxyPort);
  return {
    ok:   true,
    exec: SANDBOX_EXEC,
    args,
    env:  _buildEnv(jailHome, jailTmp, path.join(toolRoot, 'bin'), opts.env),
    work
  };
}

function runInSandbox(command, opts) {
  opts = opts || {};
  if (typeof command !== 'string' || !command.trim()) {
    return Promise.resolve({ error: 'bad_args', detail: 'command (string, non-empty) required', sandboxed: false });
  }
  // Through module.exports so a test stub on isAvailable takes effect.
  const avail = module.exports.isAvailable();
  if (!avail.available) {
    return Promise.resolve({
      error: 'seatbelt_unavailable',
      detail: avail.error || 'sandbox-exec not usable',
      sandboxed: false
    });
  }

  const network = opts.network === 'full' ? 'full' : 'none';
  const timeout = Math.max(1, Math.min(MAX_TIMEOUT_MS, parseInt(opts.timeout_ms || DEFAULT_TIMEOUT_MS, 10)));

  // The jail: the caller's project dir, or a throwaway scratch jail when no
  // cwd was given (bash.js passes null on non-project calls) — a command
  // with nowhere declared to work still gets somewhere safe to write.
  let work;
  try {
    work = opts.cwd
      ? fs.realpathSync(opts.cwd)                     // symlink-resolved: subpath match is on real paths
      : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'troth-jail-'));
  } catch (e) {
    return Promise.resolve({ error: 'bad_args', detail: 'cwd unusable: ' + (e && e.message || e), sandboxed: false });
  }

  const jspec = jailSpawnSpec({ cwd: work, network, env: opts.env });
  if (!jspec.ok) {
    return Promise.resolve({ error: 'jail_setup_failed', detail: jspec.error, sandboxed: false });
  }
  const argv = jspec.args.concat(['/bin/bash', '-c', command]);

  return new Promise((resolve) => {
    const started_at = Date.now();
    const child = spawn(jspec.exec, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd:   work,
      env:   jspec.env
    });
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    let done = false;
    let killTimer = null;
    let graceTimer = null;

    function finish(payload) {
      if (done) return;
      done = true;
      if (killTimer)  clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(Object.assign({
        sandboxed:    true,
        sandbox_kind: 'seatbelt',
        work_dir:     work,
        network,
        elapsed_ms:   Date.now() - started_at
      }, payload));
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({
      error: 'spawn_failed',
      detail: e && e.message || String(e),
      stdout: _clip(stdout), stderr: _clip(stderr),
      exit_code: null, interrupted
    }));
    child.on('exit', (code, signal) => finish({
      stdout: _clip(stdout), stderr: _clip(stderr),
      exit_code: code, signal: signal || null, interrupted
    }));

    killTimer = setTimeout(() => {
      interrupted = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      graceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, KILL_GRACE_MS);
    }, timeout);
  });
}

// ── Ground profiles: the walls for ground that is NOT a deny-default jail ──
//
// The jail above is for partner project ground, where nothing is allowed
// until it is named. These two are for ground the operator owns, where the
// opposite is true: everything works as it did, and a short list of denies
// is carved out. They exist because a check made before a command runs can
// be raced or side-stepped by the command itself, while a kernel rule cannot.
//
//   thin     the operator's own opened folder. Their environment, their
//            tools, their credentials for their own git and cloud work.
//            Denied: reading partner project ground, reading the credential
//            stores, writing the files that decide what the partner may do.
//   confine  ground nobody declared. Same denies, plus writes limited to
//            that folder and a scratch directory. Reads stay open, so
//            exploring an unfamiliar tree is untouched.
//   home     the tree holding the substrate. Confine with no writable work
//            directory at all — scratch only.
//
// Reading partner project ground is denied rather than merely executing it,
// because an interpreter defeats an exec-only rule: the interpreter is the
// binary that runs, and the staged file is only read. The same rule closes
// the unreviewed copy-out, since a shell can no longer move a file from
// partner ground onto operator ground.
//
// Paths never enter the profile TEXT. They are passed as -D parameters, so a
// directory whose name contains a quote cannot rewrite the policy.

// Lowering switches never cross into a partner shell on any ground. The
// substrate honours this variable on every write it records, so a partner
// shell that sets it is the judged turning off the judge.
const PARTNER_ENV_STRIP = ['TROTH_STVC_BYPASS'];

function operatorEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of PARTNER_ENV_STRIP) delete env[k];
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (typeof extra[k] === 'string' || typeof extra[k] === 'number') env[k] = String(extra[k]);
    }
  }
  return env;
}

function _trothDir() {
  return process.env.TROTH_CONFIG_DIR
      || path.join(process.env.HOME || os.homedir(), '.troth');
}

// Read-denied: files whose CONTENTS are the credential.
//
// The substrate database is deliberately absent. Its contents are already
// refused on the tool road and the shell road, each naming the sanctioned
// way in, and partner project ground cannot reach this directory at all —
// a jail never allows it. A third rule here would instead break the
// operator running the substrate's own tooling from their own checkout.
function _jewelPaths() {
  const t = _trothDir();
  return [path.join(t, 'credentials.json'),
          path.join(t, 'codex-token.json'),
          path.join(t, '.env'),
          path.join(t, 'audit-keys')];
}

// Write-denied: files that decide what the partner is allowed to do. A
// partner that can edit these widens its own walls, so they are refused by
// the kernel and not only by the tool that would normally write them.
function _policyPaths() {
  const t = _trothDir();
  return [path.join(t, 'config.json'),
          path.join(t, 'web-allowlist.json'),
          path.join(t, 'opened-folders.json'),
          path.join(t, 'mcp-clients.json'),
          path.join(t, 'router.json')];
}

// Write-denied on operator ground: files the shell or the agent host EXECUTES
// on its next start. A single write to any of them buys execution outside
// every wall here, which is why they are refused by the kernel and not only
// by the two roads that judge command text.
//
// Spelled relative to HOME and resolved per call rather than borrowed from
// the path policy's list, which freezes HOME at load: a wall whose target
// depends on when a module happened to be required is a wall that moves.
// The suite pins that every name here is also refused by that policy, so the
// two cannot drift apart unnoticed.
//
// Two families sit here. Shell and host startup files are executed on the
// next shell or agent start. The second family is obeyed by the next TOOL
// operation instead: the global git configs and the ssh client config can
// name a command that operation runs, the global npm config redirects every
// later install, the docker client config names credential-helper
// executables, authorized_keys grants a login, and the logout files are
// sourced at shell exit exactly as the rc files are at start.
//
// The DIRECTORIES holding the second family stay writable on purpose:
// ~/.ssh/known_hosts takes a write on every first connection, and a wall
// that breaks the operator's everyday git push is a wall people route
// around. Only the named files are refused — and each has a sanctioned
// road that stays open: per-repo .git/config, a project-local .npmrc.
const PERSISTENCE_RELATIVE = [
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout',
  '.claude/settings.json', '.claude/settings.local.json',
  '.claude/hooks', '.claude/agents', '.claude/plugins',
  '.config/fish', 'Library/LaunchAgents',
  '.gitconfig', '.config/git/config', '.npmrc', '.docker/config.json',
  '.ssh/config', '.ssh/rc', '.ssh/authorized_keys'
];

function _persistencePaths() {
  const home = process.env.HOME || os.homedir();
  return PERSISTENCE_RELATIVE.map((rel) => path.join(home, rel));
}

// Writable on confined ground: the per-user caches a toolchain writes without
// being asked. Redirecting them one environment variable at a time means
// enumerating every build system that will ever exist and re-downloading the
// world per folder; allowing the roots costs nothing worth protecting,
// because a cache is derived data by definition.
//
// Deliberately absent: the local binary and configuration trees. One holds
// executables that are on PATH, the other holds several tools' credentials,
// and neither is a cache.
const CACHE_RELATIVE = [
  'Library/Caches', '.cache', '.npm', '.cargo', '.rustup', 'go',
  '.gradle', '.m2', '.bun', '.deno', '.nvm', '.pnpm-store', '.yarn'
];

function _cachePaths() {
  const home = process.env.HOME || os.homedir();
  // The system temp root is deliberately NOT here. Temporary files already
  // have a home: the environment points them at scratch, which is writable.
  // Opening the whole user temp tree would hand confined ground a large area
  // outside the project for nothing measured — no command class needed it —
  // and would leave the confinement untestable, since a test's own throwaway
  // directories live there.
  return CACHE_RELATIVE.map((rel) => path.join(home, rel));
}

// Later rules win in SBPL, so order carries meaning: the blanket write deny
// comes first, the work and scratch allowances reopen exactly two subtrees,
// and the denies that must survive a writable tree come LAST.
function _groundProfile(kind, jewelCount, policyCount, persistCount, cacheCount, extraCount) {
  const confined = (kind === 'confine' || kind === 'home');
  const lines = ['(version 1)', '(allow default)',
                 '(deny file-read* (subpath (param "WORKSPACE")))'];
  for (let i = 0; i < jewelCount; i++) {
    lines.push('(deny file-read* (subpath (param "JEWEL' + i + '")))');
  }
  if (confined) {
    lines.push('(deny file-write*)');
    lines.push('(allow file-write* (subpath (param "SCRATCH")))');
    if (kind === 'confine') lines.push('(allow file-write* (subpath (param "WORK")))');
    // A working tree whose repository lives elsewhere needs that repository
    // writable too, or every commit is refused for a path the operator never
    // named. Declared by the caller, never guessed here.
    for (let i = 0; i < (extraCount || 0); i++) {
      lines.push('(allow file-write* (subpath (param "EXTRA' + i + '")))');
    }
    for (let i = 0; i < (cacheCount || 0); i++) {
      lines.push('(allow file-write* (subpath (param "CACHE' + i + '")))');
    }
    lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))');
  }
  for (let i = 0; i < policyCount; i++) {
    lines.push('(deny file-write* (subpath (param "POLICY' + i + '")))');
  }
  // Files the operator's shell or agent host executes on their next start.
  // The tool road and the shell road already refuse these, but both judge
  // text: a filesystem call carried inside an interpreter argument is not
  // shell syntax and no pre-execution scan parses it. A kernel rule does not
  // care how the write was spelled.
  for (let i = 0; i < (persistCount || 0); i++) {
    lines.push('(deny file-write* (subpath (param "PERSIST' + i + '")))');
  }
  // The credential stores are read-denied above, near the top. They are
  // denied for WRITING here, at the end, because a deny that sits before the
  // write allowances is only inert while no allowance overlaps it — and an
  // allowance is a path computed at runtime. Unreadable but overwritable is
  // not a state worth leaving reachable.
  for (let i = 0; i < jewelCount; i++) {
    lines.push('(deny file-write* (subpath (param "JEWEL' + i + '")))');
  }
  lines.push(HOOK_DIR_RULE);
  return lines.join('\n') + '\n';
}

// Resolve through links even when the path does not exist yet: most of the
// walled files are absent on a given machine, but the directory that will
// hold them exists and is what dotfile setups commonly link elsewhere. A
// parameter built from the unresolved spelling would then name a path no
// syscall ever reports, and the wall would miss exactly the write it is
// for. Resolve the deepest ancestor that exists and rejoin the rest.
function _realOr(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(head);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (_) {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

// groundSpawnSpec({ kind, cwd, env }) →
//   { ok:true, exec, args, env, kind, work?, scratch? } | { ok:false, error }
//
// The caller spawns exec + args.concat([command...]) exactly as it does for
// a jail, so one spawn site serves every ground.
function groundSpawnSpec(opts) {
  opts = opts || {};
  const kind = opts.kind;
  if (kind !== 'thin' && kind !== 'confine' && kind !== 'home') {
    return { ok: false, error: 'unknown ground kind: ' + String(kind) };
  }
  const avail = module.exports.isAvailable();
  if (!avail.available) return { ok: false, error: avail.error || 'sandbox-exec not usable' };

  let work = null;
  if (kind === 'confine') {
    // Subpath matching is on resolved paths: on macOS the temp and user roots
    // are themselves links, so an unresolved work directory matches nothing
    // and every write inside it is refused.
    try { work = fs.realpathSync(opts.cwd); }
    catch (e) { return { ok: false, error: 'cwd unusable: ' + (e && e.message || e) }; }
  }

  const jewels   = _jewelPaths();
  const policies = _policyPaths();
  const persist  = _persistencePaths();
  const caches   = (kind === 'confine' || kind === 'home') ? _cachePaths() : [];
  const extraWritable = (kind === 'confine' && Array.isArray(opts.alsoWritable))
    ? opts.alsoWritable.filter((p) => typeof p === 'string' && p).map(_realOr)
    : [];
  const profilePath = path.join(PROFILE_DIR,
    'ground-' + kind + '-' + jewels.length + '-' + policies.length
    + '-' + persist.length + '-' + caches.length + '-' + extraWritable.length + '.sb');

  let scratch = _scratchDirFor(work || (opts.cwd || _trothDir()));
  const args = [];
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(profilePath,
      _groundProfile(kind, jewels.length, policies.length, persist.length,
                     caches.length, extraWritable.length),
      { mode: 0o600 });
    fs.mkdirSync(path.join(scratch, 'tmp'), { recursive: true, mode: 0o700 });
    scratch = fs.realpathSync(scratch);
    args.push('-f', profilePath);
    args.push('-D', 'WORKSPACE=' + _realOr(path.join(_trothDir(), 'workspace')));
    jewels.forEach((p, i)   => args.push('-D', 'JEWEL' + i + '=' + _realOr(p)));
    policies.forEach((p, i) => args.push('-D', 'POLICY' + i + '=' + _realOr(p)));
    persist.forEach((p, i)  => args.push('-D', 'PERSIST' + i + '=' + _realOr(p)));
    caches.forEach((p, i)   => args.push('-D', 'CACHE' + i + '=' + _realOr(p)));
    if (kind === 'confine' || kind === 'home') args.push('-D', 'SCRATCH=' + scratch);
    if (kind === 'confine') args.push('-D', 'WORK=' + work);
    extraWritable.forEach((p, i) => args.push('-D', 'EXTRA' + i + '=' + p));
  } catch (e) {
    return { ok: false, error: 'ground_setup_failed: ' + (e && e.message || e) };
  }

  // Confined ground keeps the operator's environment — that is what makes it
  // ordinary to work in — but the caches every toolchain writes without
  // asking are pointed at scratch, so a build does not die on the write deny.
  const extra = (kind === 'thin') ? null : Object.assign({
    TMPDIR: path.join(scratch, 'tmp'),
    npm_config_cache: path.join(scratch, 'npm')
  }, opts.env || {});

  return {
    ok: true,
    exec: SANDBOX_EXEC,
    args,
    env: operatorEnv(kind === 'thin' ? (opts.env || null) : extra),
    kind,
    work,
    scratch
  };
}

module.exports = {
  isAvailable,
  runInSandbox,
  jailSpawnSpec,
  groundSpawnSpec,
  operatorEnv,
  DEFAULT_TIMEOUT_MS,
  AVAILABILITY_TTL_MS,
  // exposed for tests
  _resetAvailabilityCache,
  _profile,
  _groundProfile,
  _jewelPaths,
  _policyPaths,
  _cachePaths,
  CACHE_RELATIVE,
  _persistencePaths,
  PERSISTENCE_RELATIVE,
  HOOK_DIR_RULE,
  PARTNER_ENV_STRIP,
  _scratchDirFor,
  PROFILE_DIR,
  JAIL_SCRATCH_ROOT,
  _buildEnv
};
