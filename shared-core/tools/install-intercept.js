// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// install-intercept.js — decides whether a shell command is a package
// installation that should run inside the OS jail wherever it stands.
//
// The workspace convention walls foreign code the partner STAGES; this layer
// walls foreign code the partner INVITES — an install script runs with the
// full reach of whatever ground the command stood on, and the everyday
// "add package X to my repo" stands on the operator's own ground. Jailing
// the install scopes its writes to the project and keeps the home invisible
// while the artifact (node_modules, vendor/, Cargo.lock) lands exactly where
// it always did.
//
// This is a classifier, and a classifier fails open — a spelling it misses
// runs with the ordinary ground walls, never worse than today. That fail
// direction is acceptable ONLY because this sits on top of an accepted
// baseline; it is defense in depth, not the wall.
//
// The table lists PROJECT-SCOPED verbs only. Managers whose artifact lands
// in the home by design — npm -g, cargo install, pipx install, go install,
// gem/bundle, pip outside a project venv, brew — are deliberately absent:
// inside a jail their target becomes the throwaway jail home, so the command
// "succeeds" and the artifact evaporates, a silent corruption worse than a
// refusal. Those keep their ground's ordinary treatment.

const MANAGER_VERBS = {
  npm:  ['install', 'i', 'ci', 'add', 'update', 'upgrade', 'dedupe', 'rebuild', 'link'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'dedupe', 'rebuild', 'link', 'dlx'],
  yarn: ['install', 'add', 'up', 'upgrade', 'dedupe', 'rebuild', 'link', 'dlx'],
  bun:  ['install', 'i', 'add', 'update', 'link'],
  uv:   ['add', 'sync'],
  cargo: ['add', 'update', 'fetch'],
  composer: ['install', 'require', 'update', 'create-project']
};
// Fetch-and-execute runners: the whole point is running code that was not
// on the machine a second ago, so the verb question does not arise.
const ALWAYS = new Set(['npx', 'bunx', 'uvx']);
// Bare invocation that means "install" for this manager.
const BARE_INSTALLS = new Set(['yarn', 'pnpm']);
// A segment of glue that may accompany install segments without disarming
// the interception: repositioning only, nothing executed.
const GLUE = new Set(['cd', 'true', ':']);

// Split on unquoted && || ; | — enough shell to see a command list. Quoted
// operators stay inside their argument; anything the split misreads fails
// open into the baseline walls.
function _segments(command) {
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (q) {
      cur += ch;
      if (ch === q && command[i - 1] !== '\\') q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '&' && command[i + 1] === '&') { segs.push(cur); cur = ''; i++; continue; }
    if (ch === '|' && command[i + 1] === '|') { segs.push(cur); cur = ''; i++; continue; }
    if (ch === ';' || ch === '|') { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter((s) => s.length);
}

function _words(segment) {
  return segment.split(/\s+/).filter((w) => w.length);
}

// The command word of a segment, past env-var assignments and wrappers that
// do not change what runs (a leading path spelling is reduced to its name).
function _argv(segment) {
  const words = _words(segment);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return words.slice(i);
}

function _base(word) {
  const cut = word.lastIndexOf('/');
  return cut === -1 ? word : word.slice(cut + 1);
}

// One segment: 'install' | 'glue' | 'other'
function _classifySegment(segment) {
  const argv = _argv(segment);
  if (!argv.length) return 'other';
  const cmd = _base(argv[0]);
  if (GLUE.has(cmd)) return segment.indexOf('>') === -1 ? 'glue' : 'other';
  if (ALWAYS.has(cmd)) return 'install';
  const verbs = MANAGER_VERBS[cmd];
  if (!verbs) return 'other';
  // Global/user targets land in the real home by design; the jail would
  // strand them in the throwaway one. Not intercepted, said plainly.
  for (const w of argv) {
    if (w === '-g' || w === '--global' || w === '--user') return 'other';
  }
  const sub = argv.slice(1).find((w) => w[0] !== '-');
  if (!sub) return BARE_INSTALLS.has(cmd) ? 'install' : 'other';
  return verbs.indexOf(sub) !== -1 ? 'install' : 'other';
}

// classifyInstall(command) → { install: boolean, manager?: string }
// True only when every segment is an install (or repositioning glue) — a
// mixed command would drag ordinary work into the jail's different failure
// modes, so it keeps its ground and the miss is the documented fail-open.
function classifyInstall(command) {
  if (typeof command !== 'string' || !command.trim()) return { install: false };
  const segs = _segments(command);
  let manager = null;
  let sawInstall = false;
  for (const seg of segs) {
    const kind = _classifySegment(seg);
    if (kind === 'other') return { install: false };
    if (kind === 'install') {
      sawInstall = true;
      if (!manager) manager = _base(_argv(seg)[0]);
    }
  }
  return sawInstall ? { install: true, manager } : { install: false };
}

module.exports = { classifyInstall, _segments, _classifySegment };
