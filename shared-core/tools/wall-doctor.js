// SPDX-License-Identifier: AGPL-3.0-only
// wall-doctor.js — measures which operator workflows stay available inside
// ground walls, and that the promoted read rules actually hold, by applying
// the live profiles and running exit-code-only workflow probes under them.
//
// Why this exists: the walls must never depend on anyone judging correctly,
// the design included. A read rule enters the kernel profile only on
// measured behaviour, and stays there only while the doctor can re-measure
// it. The two questions that gate any read-rule promotion:
//
//   1. Does the ssh agent socket still answer through a profile that denies
//      reading the ssh directory? (If yes, agent-backed git-over-ssh keeps
//      working while key files become unreadable.)
//   2. Is the stored git credential still SERVED through the wall? Serving
//      an item reads the keychain database from the client process, which
//      is why the keychain is write-refused but never read-refused: a read
//      rule there starves the credential helper and kills agent https
//      pushes while answering harmlessly for absent items.
//
// Runs ONLY from unwalled ground (the proxy under its service manager).
// Inside a wall, profiles do not nest and sandbox-exec is refused; every
// probe would report exit 71 and say nothing. runProbes() detects that and
// reports context: 'nested-walls' instead of fake verdicts.
//
// Census note: this file spawns through ONE raw callsite, not through the
// spawn-purpose seam — the seam would wrap each probe in a ground wall, and
// a probe that must APPLY a profile cannot start inside one.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const seatbelt = require('./sandbox-seatbelt.js');

// One spawn callsite for the whole module (census: 1).
function _exec(cmd, args, env, timeoutMs) {
  try {
    execFileSync(cmd, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: env || process.env,
      timeout: timeoutMs || 10000
    });
    return 0;
  } catch (e) {
    if (e && typeof e.status === 'number') return e.status;
    return -1; // spawn failure / timeout, distinct from any exit code
  }
}

function _home() { return process.env.HOME || os.homedir(); }
function _troth() {
  return process.env.TROTH_CONFIG_DIR || path.join(_home(), '.troth');
}

// Total bytes under a directory, bounded depth, errors count as zero — a
// diagnostic number, never a reason to fail.
function _dirBytes(dir, depth) {
  if (depth <= 0) return 0;
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += _dirBytes(p, depth - 1);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch (_) { /* count what answers */ }
  }
  return total;
}

// Candidate rules, appended AFTER the base profile text. Later rules take
// precedence, which is also why the partner-ground read refusal is restated
// last: no carve-in above it may ever become the last word on that path.
const CANDIDATE_LINES = [
  ';; --- candidate additions under measurement ---',
  '(deny file-read* (subpath (param "CAND_SSH")))',
  '(deny file-read* (subpath (param "CAND_TROTH")))'
];
const CARVE_LINES = [
  '(allow file-read* (subpath (param "CAND_JAILS")))',
  '(allow file-read* (subpath (param "CAND_PROFILES")))',
  '(allow file-read* (literal (param "CAND_KNOWN_HOSTS")))',
  '(allow file-read* (literal (param "CAND_SSH_CONFIG")))',
  '(deny file-read* (subpath (param "CAND_WORKSPACE")))'
];

function _candidateParams() {
  const t = _troth();
  const h = _home();
  return [
    ['CAND_SSH', path.join(h, '.ssh')],
    ['CAND_TROTH', t],
    ['CAND_JAILS', path.join(t, 'jails')],
    ['CAND_PROFILES', path.join(t, 'sandbox-profiles')],
    ['CAND_KNOWN_HOSTS', path.join(h, '.ssh', 'known_hosts')],
    ['CAND_SSH_CONFIG', path.join(h, '.ssh', 'config')],
    ['CAND_WORKSPACE', path.join(t, 'workspace')]
  ];
}

// Build a spawn prefix [exec, ...args] for: the live base profile exactly as
// the product emits it, or that profile plus candidate lines (with or
// without the carve-ins). Returns null with a reason when the ground cannot
// be prepared.
function _prefix(variant) {
  const spec = seatbelt.groundSpawnSpec({ kind: 'thin' });
  if (!spec.ok) return { err: spec.error || 'ground spec unavailable' };
  if (variant === 'base') return { exec: spec.exec, args: spec.args.slice() };

  const profIdx = spec.args.indexOf('-f') + 1;
  if (profIdx <= 0 || !spec.args[profIdx]) return { err: 'no profile path in ground spec' };
  let text;
  try { text = fs.readFileSync(spec.args[profIdx], 'utf8'); }
  catch (e) { return { err: 'base profile unreadable: ' + (e.message || e) }; }

  const lines = (variant === 'candidate-carved')
    ? CANDIDATE_LINES.concat(CARVE_LINES)
    : CANDIDATE_LINES;
  const candPath = spec.args[profIdx].replace(/\.sb$/, '') + '-' + variant + '.sb';
  try { fs.writeFileSync(candPath, text + lines.join('\n') + '\n', { mode: 0o600 }); }
  catch (e) { return { err: 'candidate profile unwritable: ' + (e.message || e) }; }

  const args = spec.args.slice();
  args[profIdx] = candPath;
  for (const [k, v] of _candidateParams()) args.push('-D', k + '=' + v);
  return { exec: spec.exec, args };
}

function _sh(prefix, cmd) {
  return _exec(prefix.exec, prefix.args.concat(['/bin/sh', '-c', cmd]), prefix.env || process.env);
}

function runProbes() {
  const out = { ranAt: new Date().toISOString(), context: 'unwalled', probes: [], verdicts: {} };
  const add = (name, exit, expect, note) => {
    out.probes.push({ name, exit, expect, ok: expect.includes(exit), note: note || '' });
  };

  const avail = seatbelt.isAvailable();
  if (!avail.available) { out.context = 'no-wall-runtime'; out.error = avail.error || ''; return out; }

  // Nesting sentinel: a trivial command under a plain profile. Exit 71 (or
  // any spawn-level failure) here means we are already inside a wall and
  // every verdict below would be noise.
  const base = _prefix('base');
  if (base.err) { out.context = 'no-ground'; out.error = base.err; return out; }
  const sentinel = _sh(base, 'true');
  if (sentinel !== 0) { out.context = 'nested-walls'; out.sentinelExit = sentinel; return out; }

  const bare = _prefix('candidate-bare');
  const carved = _prefix('candidate-carved');
  if (bare.err || carved.err) { out.context = 'no-ground'; out.error = bare.err || carved.err; return out; }

  const h = _home();
  const knownHosts = path.join(h, '.ssh', 'known_hosts');
  const cfgFile = path.join(_troth(), 'config.json');
  const jailsDir = path.join(_troth(), 'jails');
  const gateIdents = path.join(_troth(), 'gate-identifiers');
  out.hostSees = {
    sshAuthSock: !!process.env.SSH_AUTH_SOCK,
    knownHosts: fs.existsSync(knownHosts),
    trothConfig: fs.existsSync(cfgFile),
    jailsDir: fs.existsSync(jailsDir),
    gateIdents: fs.existsSync(gateIdents),
    // The undo store's real footprint — the operator's 'is my disk filling'
    // question answered with a number on every doctor run. Retention keeps
    // it bounded (RETAIN_DAYS window, keep floor, gc on every maintenance).
    undoStoreBytes: _dirBytes(path.join(_troth(), 'undo'), 6)
  };

  // Whether the stored git credential is actually served, host-side vs
  // through the wall — the availability question behind every agent https
  // push. Presence is reduced to an exit code in the pipeline; the secret
  // itself never leaves the pipe.
  const CRED_CMD = 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential-osxkeychain get | grep -q "^password="';
  out.hostSees.gitCredentialHost = _exec('/bin/sh', ['-c', CRED_CMD]) === 0;
  out.hostSees.gitCredentialWalled = _sh(base, CRED_CMD) === 0;

  const KEYCHAIN_CMD = 'security find-generic-password -s troth-wall-probe-absent';

  // Workflow availability under the live base profile (controls).
  add('base agent socket', _sh(base, 'ssh-add -l'), [0, 1],
    'exit 1 = socket answered, no identities loaded; exit 2 = unreachable');
  add('base keychain lookup', _sh(base, KEYCHAIN_CMD), [44],
    'exit 44 = keychain answered: searched and found nothing');
  if (out.hostSees.gitCredentialHost) {
    add('base serves the git credential', out.hostSees.gitCredentialWalled ? 0 : 1, [0],
      'the credential helper answers through the wall, so agent https pushes keep working');
  }

  // The promoted rules, exercised through the LIVE base profile — these are
  // green only once the promotion is in the wall builder, and they are the
  // doctor's permanent evidence that it stays there.
  if (out.hostSees.trothConfig) {
    add('base denies substrate config read', _sh(base, 'head -c1 ' + JSON.stringify(cfgFile) + ' >/dev/null'), [1, 2],
      'the provider-key configuration is dark inside every session');
  }
  if (out.hostSees.knownHosts) {
    add('base keeps known_hosts readable', _sh(base, 'head -c1 ' + JSON.stringify(knownHosts) + ' >/dev/null'), [0],
      'ssh keeps connecting to already-known hosts');
  }
  if (out.hostSees.gateIdents) {
    add('base keeps the gate inputs readable', _sh(base, 'head -c1 ' + JSON.stringify(gateIdents) + ' >/dev/null'), [0],
      'the release gate greps its lists from the partner hand');
  }
  if (out.hostSees.jailsDir) {
    add('base keeps jails readable', _sh(base, 'ls ' + JSON.stringify(jailsDir) + ' >/dev/null'), [0],
      'a session keeps its own scratch');
  }
  // The workflow that found the metadata pinhole: mkdir -p stats every
  // component above the jail scratch, and npm's cache does the same walk on
  // every install. The substrate node must answer stat while its contents
  // stay dark.
  const trothDir = _troth();
  if (out.hostSees.jailsDir) {
    const deepProbe = path.join(jailsDir, 'wall-doctor-mkdirp', 'sub');
    add('base mkdir -p through the substrate chain', _sh(base, '/bin/mkdir -p ' + JSON.stringify(deepProbe)), [0],
      'npm and every scratch-writing tool walk these components');
    try {
      fs.rmdirSync(deepProbe);
      fs.rmdirSync(path.dirname(deepProbe));
    } catch (_) { /* refused = never created */ }
  }
  add('base substrate node answers stat while contents stay dark',
    _sh(base, 'stat ' + JSON.stringify(trothDir) + ' >/dev/null && ! ls ' + JSON.stringify(trothDir) + ' >/dev/null 2>&1'), [0],
    'path walking works; listing and reading inside are still refused');
  const profProbe = path.join(seatbelt.PROFILE_DIR, 'wall-doctor-write-refused');
  add('base denies wall self-editing', _sh(base, '/usr/bin/touch ' + JSON.stringify(profProbe)), [1, 2],
    'profile files cannot be authored from inside the walls they build');
  try { fs.unlinkSync(profProbe); } catch (_) { /* refused = never created */ }

  // Partner project ground — the jail, where a partner's npm installs and
  // build scripts actually run. Deny-default by construction, and probed so
  // the verdict comes from behaviour, not from reading the profile text.
  // The work dir is a throwaway; every probe is exit-code-only.
  let jailWork = null;
  try {
    jailWork = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-doctor-jail-'));
    const jspec = seatbelt.jailSpawnSpec({ cwd: jailWork, network: 'none' });
    if (jspec.ok) {
      const jail = { exec: jspec.exec, args: jspec.args.slice(), env: jspec.env };
      const realWork = fs.realpathSync(jailWork);
      const escapeFile = path.join(_home(), 'wall-doctor-escape-refused.txt');
      add('jail writes land in the project', _sh(jail, 'echo x > ' + JSON.stringify(path.join(realWork, 'in.txt'))), [0],
        'the job itself — installs, builds, edits — works where it should');
      add('jail refuses writing beside the project', _sh(jail, 'echo x > ' + JSON.stringify(escapeFile)), [1, 2],
        'nothing a project script runs can land outside the project and its scratch');
      add('jail cannot read the operator home', _sh(jail, 'ls ' + JSON.stringify(_home()) + ' >/dev/null'), [1, 2],
        'deny-default: the home tree, and every credential store in it, was never granted');
      try { fs.unlinkSync(escapeFile); } catch (_) { /* refused = never created */ }
    } else {
      add('jail ground available', -1, [0], jspec.error || 'jail spec unavailable');
    }
  } catch (e) {
    add('jail ground available', -1, [0], String(e && e.message || e));
  } finally {
    try { if (jailWork) fs.rmSync(jailWork, { recursive: true, force: true }); } catch (_) {}
  }

  // Engagement controls: the same reads under the bare candidate must be
  // refused, or the candidate lines were inert and no verdict below counts.
  if (out.hostSees.knownHosts) {
    add('candidate denies ssh dir read', _sh(bare, 'head -c1 ' + JSON.stringify(knownHosts) + ' >/dev/null'), [1, 2],
      'nonzero = kernel refused the read');
  }
  if (out.hostSees.trothConfig) {
    add('candidate denies substrate config read', _sh(bare, 'head -c1 ' + JSON.stringify(cfgFile) + ' >/dev/null'), [1, 2],
      'nonzero = kernel refused the read');
    add('carved candidate still denies substrate config read', _sh(carved, 'head -c1 ' + JSON.stringify(cfgFile) + ' >/dev/null'), [1, 2],
      'the carve-ins must not reopen policy files');
  }
  if (out.hostSees.jailsDir) {
    add('carve reopens jails', _sh(carved, 'ls ' + JSON.stringify(jailsDir) + ' >/dev/null'), [0],
      'sessions read their own scratch through the carve');
  }
  if (out.hostSees.knownHosts) {
    add('carve reopens known_hosts', _sh(carved, 'head -c1 ' + JSON.stringify(knownHosts) + ' >/dev/null'), [0],
      'host inventory stays readable so ssh keeps connecting');
  }

  // The gating measurement, under the bare candidate.
  add('candidate agent socket', _sh(bare, 'ssh-add -l'), [0, 1],
    'socket lives outside every denied path; must still answer');

  const get = (n) => out.probes.find((p) => p.name === n);
  const engaged = ['candidate denies ssh dir read', 'candidate denies substrate config read']
    .map(get).filter(Boolean).every((p) => p.ok);
  out.verdicts = {
    controlsEngaged: engaged,
    agentSocketSurvives: engaged && !!get('candidate agent socket') && get('candidate agent socket').ok,
    credentialRoadOpen: !out.hostSees.gitCredentialHost || !!get('base serves the git credential') && get('base serves the git credential').ok,
    carvesWork: ['carve reopens jails', 'carve reopens known_hosts', 'carved candidate still denies substrate config read']
      .map(get).filter(Boolean).every((p) => p.ok),
    promotionLive: ['base denies substrate config read', 'base keeps known_hosts readable',
      'base keeps jails readable', 'base denies wall self-editing',
      'base mkdir -p through the substrate chain', 'base substrate node answers stat while contents stay dark',
      'base keeps the gate inputs readable']
      .map(get).filter(Boolean).every((p) => p.ok),
    jailHolds: ['jail writes land in the project', 'jail refuses writing beside the project',
      'jail cannot read the operator home', 'jail ground available']
      .map(get).filter(Boolean).every((p) => p.ok)
  };
  return out;
}

// Boot road: the proxy calls this once per start. A request marker in the
// tree the proxy runs from asks for one measurement run; results land next
// to it, readable from session ground. The marker is consumed FIRST so a
// crashing probe cannot loop the boot.
const REQ_MARKER = path.join(__dirname, '..', '..', '.wall-doctor-request');
const RESULTS_FILE = path.join(__dirname, '..', '..', '.wall-doctor-results.json');

function maybeRunFromBoot() {
  try {
    if (!fs.existsSync(REQ_MARKER)) return false;
    fs.unlinkSync(REQ_MARKER);
  } catch (_) { return false; }
  setTimeout(() => {
    let out;
    try { out = runProbes(); }
    catch (e) { out = { context: 'error', error: String(e && e.message || e) }; }
    try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 }); }
    catch (_) {}
  }, 2500).unref();
  return true;
}

module.exports = { runProbes, maybeRunFromBoot, RESULTS_FILE };
