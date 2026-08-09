// SPDX-License-Identifier: Apache-2.0
// workspace-jail.mjs — decides whether a troth-bash command runs inside the
// OS jail, and builds the wrapped argv when it does.
//
// The rule is a single directory convention, not a command classifier (a
// classifier fails open): everything under ~/.troth/workspace/ is partner
// project ground and runs JAILED to its project root — writes stay inside
// that project, the child env is built instead of inherited, and ~/.troth
// itself, the rest of the home, and every OTHER project stay invisible.
// Everything else (the operator's own repos, their builds, their signing)
// runs exactly as before, untouched.
//
// THE ANSWER IS THREE-VALUED, and that matters. An adversarial pass found
// that collapsing it to jail-or-bare fails open: a jailed process can plant
// a symlink inside its own project pointing anywhere, and a cwd that LOOKS
// like workspace ground but resolves outside it was being treated as the
// operator's own ground and run with no sandbox at all. A path that claims
// to be in the workspace and is not is now REFUSED, never run bare.
//
// Network stays ON inside the jail: project work needs registries. Loopback
// is denied by the profile, so a package cannot call the operator's own
// services; scoping the public internet is the egress layer's job.
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve as pathResolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const WORKSPACE_ROOT = pathResolve(homedir(), '.troth', 'workspace');

let _seatbelt = null;
function seatbelt() {
  if (_seatbelt === null) {
    try {
      const serverDir = fileURLToPath(new URL('.', import.meta.url));
      _seatbelt = require(serverDir + '../../../shared-core/tools/sandbox-seatbelt.js');
    } catch { _seatbelt = false; }
  }
  return _seatbelt || null;
}

// The operator's own switch, read from ~/.troth/config.json l4.sandbox.runtime
// — the same key the sandbox selector already honors, so one setting governs
// every jailed surface instead of this one drifting its own.
//
// Setting it to 'bare' turns the workspace jail off. config.json is itself a
// protected destination, so the edit tool refuses it and the shell refuses
// every redirect, copy and move that lands there — in any spelling, since the
// wall folds case where the filesystem does.
//
// That is a high bar, not a sealed door, and the difference matters here. A
// command that carries its filesystem call inside an interpreter argument
// (`node -e`, `python3 -c`) is not shell syntax and no pre-execution scan
// parses it, so on operator ground a determined partner can still reach this
// file. What that buys is turning the jail off for WORKSPACE ground, which is
// the ground the partner's own downloaded code runs on. Sealing it properly
// wants the operator's config held somewhere the partner has no write path to
// at all; until then this switch is guarded, not guaranteed.
//
// Read fresh each call rather than cached: an operator who flips it expects
// the next command to obey, not the next restart.
function operatorWantsBare() {
  try {
    const serverDir = fileURLToPath(new URL('.', import.meta.url));
    const runtime = require(serverDir + '../../../shared-core/tools/sandbox-runtime.js');
    if (typeof runtime._readOperatorOverride !== 'function') return false;
    return runtime._readOperatorOverride() === 'bare';
  } catch { return false; }
}

function under(child, parent) {
  return child === parent || child.startsWith(parent + sep);
}

// classify(cwd) → one of:
//   { ground: 'operator' }                     run bare, exactly as before
//   { ground: 'project',   project }           jail to that project
//   { ground: 'workspace', project }           jail to the workspace root
//   { ground: 'escape',    reason }            refuse: claims the workspace,
//                                              resolves outside it
export function classify(cwd, workspaceRoot) {
  const rawRoot = workspaceRoot || WORKSPACE_ROOT;
  let realRoot;
  try { realRoot = realpathSync(rawRoot); } catch { return { ground: 'operator' }; }

  // Two questions, deliberately separate: does the path CLAIM the workspace
  // (by name, before any link is followed), and does it LAND there (after)?
  const claimed = pathResolve(cwd);
  const claimsWorkspace = under(claimed, rawRoot) || under(claimed, realRoot);

  let realCwd;
  try { realCwd = realpathSync(cwd); } catch {
    // A cwd that does not exist is not workspace ground; the caller's own
    // stale-directory handling deals with it.
    return claimsWorkspace
      ? { ground: 'escape', reason: 'workspace path does not resolve: ' + claimed }
      : { ground: 'operator' };
  }
  const landsInWorkspace = under(realCwd, realRoot);

  if (claimsWorkspace && !landsInWorkspace) {
    return { ground: 'escape',
             reason: 'path is inside ' + rawRoot + ' but resolves to ' + realCwd
                     + '; refusing rather than running unsandboxed' };
  }
  if (!landsInWorkspace) return { ground: 'operator' };
  if (realCwd === realRoot) {
    // Scaffolding ground: creating a new project has to happen here, so the
    // jail is the whole workspace. Every sibling project is therefore in
    // reach of a command run FROM the root — which is why the caller says so
    // out loud and real work belongs one directory deeper.
    return { ground: 'workspace', project: realRoot };
  }
  // The first segment under the root is the project: `cd` deeper never
  // re-scopes the jail, so a project's own build script cannot narrow its
  // walls to a subdirectory and then reach back out.
  const firstSeg = realCwd.slice(realRoot.length + 1).split(sep)[0];
  return { ground: 'project', project: realRoot + sep + firstSeg };
}

// Kept for callers that only want the jail root; null for anything that is
// not jailed project ground.
export function projectRootFor(cwd, workspaceRoot) {
  const c = classify(cwd, workspaceRoot);
  return (c.ground === 'project' || c.ground === 'workspace') ? c.project : null;
}

// jailFor(cwd) → null (operator ground, run bare, exactly as before)
//              | { exec, args, env, project, ground }   jailed
//              | { refuse: reason }                      claimed the workspace, landed elsewhere
//              | { off: 'operator', project }            operator turned it off
//              | { off: 'unavailable', project, why }    this host has no jail to offer
//
// The last one exists because 'bare' had been ONE value carrying two very
// different meanings. A host with no adapter (Linux today, or a Mac whose
// seatbelt is unusable) returned the same null as the operator's own ground,
// so the note that says 'workspace jail:' simply did not print and workspace
// ground ran unsandboxed in silence. Somebody on Linux, inside the very
// directory whose whole purpose is containment, would see nothing at all and
// reasonably assume the walls were there. Degrading is fine. Degrading
// quietly is the failure.
export function jailFor(cwd, workspaceRoot) {
  const c = classify(cwd, workspaceRoot);
  if (c.ground === 'operator') return null;
  // The operator's switch is read AFTER classification so an escape is still
  // reported as an escape: 'the jail is off' and 'this path lied about where
  // it lands' are different facts, and the second one stays worth saying.
  if (operatorWantsBare()) {
    if (c.ground === 'escape') return { refuse: c.reason };
    return { off: 'operator', project: c.project };
  }
  if (c.ground === 'escape')   return { refuse: c.reason };
  const sb = seatbelt();
  if (!sb || typeof sb.jailSpawnSpec !== 'function') {
    return { off: 'unavailable', project: c.project,
             why: 'no sandbox runtime on this host (platform: ' + process.platform + ')' };
  }
  const spec = sb.jailSpawnSpec({ cwd: c.project, network: 'full' });
  if (!spec.ok) {
    return { off: 'unavailable', project: c.project,
             why: 'sandbox setup failed: ' + (spec.error || 'unknown') };
  }
  return { exec: spec.exec, args: spec.args, env: spec.env, project: c.project, ground: c.ground };
}
