// SPDX-License-Identifier: AGPL-3.0-only
// The spawn boundary seam.
//
// Every NEW process the product starts declares a PURPOSE here; the purpose
// maps to a wall. An unknown or missing purpose gets the STRICTEST wall
// available rather than none: a forgotten label is safe, only a wrong label
// is unsafe, and a wrong label is reviewable in a diff. The census test
// (tests/spawn-census.test.js) freezes the legacy call sites at their
// current counts; a new spawn either comes through here or turns the
// build red. Lanes migrate here one at a time; the census shrinks as
// they do and never grows.
//
// 'trusted-plumbing' purposes are the product's OWN short-lived tools (git
// for the undo shadows) running as the parent runs: the parent process is
// the boundary there, and the child's argv is authored by our code, never
// by a model or by content. Every other purpose builds a ground profile;
// when no wall runtime exists on the host the spawn still happens and the
// returned meta SAYS so (the shipped ground-road semantic: a promise
// quietly not kept is worse than one never made).

'use strict';

const cp = require('child_process');

const PURPOSES = {
  // parent-boundary: argv authored by product code, short-lived, no model
  // input reaches the command line.
  'undo-plumbing': { kind: 'trusted-plumbing' },
  // The parser self-test: one node child requiring the native bindings, so
  // an ABI that dies at parse time dies in the child, never in the server.
  'parser-probe': { kind: 'trusted-plumbing' },
  // Publish pre-flight: read-only git plumbing (remote URL, HEAD tree) with
  // argv shapes validated before any model-derived name may travel as a key.
  'publish-preflight': { kind: 'trusted-plumbing' },
  // The operator-configured gate command a guarded destination demands;
  // authored in guarded-remotes.json by the operator, never by a model.
  'release-gate': { kind: 'trusted-plumbing' },
  // Reading a credential from the operator's own tool (gh, the keychain) into
  // the vault: argv comes from a closed source table in vault-capture.js, the
  // child is short-lived, and the value stays in the parent.
  'vault-capture': { kind: 'trusted-plumbing' },
  // ground-walled purposes; adopters pick one consciously and the profile
  // tightens per purpose without touching call sites again.
  'inference':   { kind: 'ground', ground: 'confine' },
  'mcp-server':  { kind: 'ground', ground: 'confine' },
  'install':     { kind: 'ground', ground: 'confine' },
  'project-run': { kind: 'ground', ground: 'thin' },
  'worker':      { kind: 'ground', ground: 'thin' }
};

function _resolve(purpose, cmd, args, opts) {
  const p = PURPOSES[purpose];
  if (p && p.kind === 'trusted-plumbing') {
    return { cmd, args: args || [], opts: opts || {}, wall: 'parent-boundary' };
  }
  // Unknown purpose, or a walled purpose: strictest available ground
  // profile. Fails toward the wall, never toward bare.
  try {
    const sb = require('./sandbox-seatbelt.js');
    const kind = (p && p.ground) || 'confine';
    const spec = sb.groundSpawnSpec({ kind, cwd: (opts && opts.cwd) || process.cwd() });
    if (spec && spec.ok) {
      return {
        cmd: spec.exec,
        args: spec.args.concat([cmd]).concat(args || []),
        opts: Object.assign({}, opts, { env: Object.assign({}, spec.env, (opts && opts.env) || {}) }),
        wall: 'seatbelt:' + kind
      };
    }
  } catch (_) {}
  return { cmd, args: args || [], opts: opts || {}, wall: 'none (no wall runtime)' };
}

function execFileSync(purpose, cmd, args, opts) {
  const r = _resolve(purpose, cmd, args, opts);
  return cp.execFileSync(r.cmd, r.args, r.opts);
}

function spawn(purpose, cmd, args, opts) {
  const r = _resolve(purpose, cmd, args, opts);
  const child = cp.spawn(r.cmd, r.args, r.opts);
  child._spawn_wall = r.wall;
  return child;
}

module.exports = { execFileSync, spawn, PURPOSES, _resolve };
