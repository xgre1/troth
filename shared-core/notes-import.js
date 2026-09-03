// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A folder of notes on this machine (an Obsidian vault, Markdown, text)
// becomes knowledge: the folder is checked, then the product's own reader
// road takes it (`troth knowledge import`), which spools one row per file
// for the background reader to gate, chunk and index.

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawnPurpose = require('./tools/spawn-purpose.js');

const NOTE_EXT = new Set(['.md', '.markdown', '.txt', '.org']);
// The same floor as `troth knowledge import`: the reader keeps nothing shorter.
const MIN_NOTE_BYTES = 80;

function home() { return process.env.HOME || os.homedir(); }

function registryCandidates() {
  if (process.env.TROTH_OBSIDIAN_REGISTRY) return [process.env.TROTH_OBSIDIAN_REGISTRY];
  const h = home();
  const out = [path.join(h, 'Library', 'Application Support', 'obsidian', 'obsidian.json'), path.join(h, '.config', 'obsidian', 'obsidian.json')];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'obsidian', 'obsidian.json'));
  return out;
}

// The vaults Obsidian knows on this machine, those that still exist.
function detectVaults() {
  const seen = new Set();
  const out = [];
  for (const reg of registryCandidates()) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(reg, 'utf8')); } catch (_) { continue; }
    const vaults = (j && j.vaults && typeof j.vaults === 'object') ? j.vaults : {};
    for (const id of Object.keys(vaults)) {
      const p = vaults[id] && vaults[id].path;
      if (!p || seen.has(p)) continue;
      let ok = false;
      try { ok = fs.statSync(p).isDirectory(); } catch (_) { ok = false; }
      if (!ok) continue;
      seen.add(p);
      out.push({ path: p, name: path.basename(p), app: 'obsidian', open: !!(vaults[id] && vaults[id].open) });
    }
  }
  return out;
}

function countNotes(dir, cap) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!NOTE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let size = 0; try { size = fs.statSync(full).size; } catch (_) { continue; }
      if (size < MIN_NOTE_BYTES) continue;
      n++; if (n >= cap) break;
    }
  }
  return n;
}

// A folder the import may read: absolute, under the home directory, a
// directory, and not the substrate's own folder.
function checkFolder(p) {
  const raw = String(p || '').trim();
  if (!raw) return { ok: false, error: 'a folder path is required' };
  const expanded = raw.startsWith('~/') ? path.join(home(), raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) return { ok: false, error: 'the folder must be an absolute path' };
  const resolved = path.resolve(expanded);
  const h = path.resolve(home());
  if (resolved !== h && !resolved.startsWith(h + path.sep)) return { ok: false, error: 'the folder must be under your home directory' };
  const substrate = path.join(h, '.troth');
  if (resolved === substrate || resolved.startsWith(substrate + path.sep)) return { ok: false, error: 'the substrate folder is not a notes folder' };
  let st = null;
  try { st = fs.statSync(resolved); } catch (_) { return { ok: false, error: 'no such folder: ' + resolved }; }
  if (!st.isDirectory()) return { ok: false, error: 'not a folder: ' + resolved };
  const notes = countNotes(resolved, 5000);
  if (!notes) return { ok: false, error: 'no notes found (Markdown, text or org files): ' + resolved };
  const obsidian = fs.existsSync(path.join(resolved, '.obsidian'));
  return { ok: true, path: resolved, notes, obsidian };
}

// The reader road, detached: the CLI spools the files and exits; the
// background reader takes it from there.
function startImport(folder) {
  const logPath = path.join(home(), '.troth', 'import-notes.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) {}
  const fd = fs.openSync(logPath, 'a');
  const child = spawnPurpose.spawn('knowledge-import', process.execPath,
    [path.join(__dirname, '..', 'bin', 'troth.js'), 'knowledge', 'import', folder],
    { detached: true, stdio: ['ignore', fd, fd], env: Object.assign({}, process.env) });
  child.unref();
  try { fs.closeSync(fd); } catch (_) {}
  return { started: true, path: folder, log: logPath, pid: child.pid || null };
}

module.exports = { detectVaults, checkFolder, countNotes, startImport, NOTE_EXT, MIN_NOTE_BYTES };
