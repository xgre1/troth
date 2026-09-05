#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only troth chat — interactive REPL backed
// by the troth-entity daemon. One long-lived child process per chat session.
// Each line of user input becomes a `user_input` event on the entity's stdin;
// each response event from stdout renders here. Slash commands work natively
// because the entity intercepts them at its own input boundary. Exit: /quit,
// /exit clean shutdown Ctrl-D / Ctrl-C forwards SIGTERM, then exits This is
// the human-facing twin of the voice path: same entity, same tools, same
// substrate. Plain stdin/stdout — no Tauri, no UI dep.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const ENTITY_BIN = path.resolve(__dirname, 'troth-entity.js');

const argv = process.argv.slice(2);
function flag(name, def) {
  const k = '--' + name;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === k) return argv[i + 1] || def;
    if (argv[i].startsWith(k + '=')) return argv[i].slice(k.length + 1) || def;
  }
  return def;
}

// Substrate-as-mind: cli is one surface among many on the SAME brain.
// agent-id.resolveAgentId() honors TROTH_ENTITY_AGENT_ID env (set by
// operator's shell) and falls back to the canonical neutral default —
// same default the proxy dialogue mirror, voice app, and plugin hooks
// resolve to. Pre- default was 'chat' which fragmented the
// cli into its own pool, separate from the rest of the user's memory.
const AGENT_ID = flag('agent-id', require('../shared-core/agent-id.js').resolveAgentId());
const CWD      = flag('cwd', process.env.TROTH_ENTITY_CWD || process.cwd());
// This chat is a thread, and it has to say so. Turns land in the substrate's
// session_id column, and a turn written without one joins the unattributed
// pool every other unscoped surface writes into — which a later read cannot
// tell apart from this conversation. Minted per process: one run of the CLI is
// one thread. TROTH_CONVERSATION_ID lets a caller rejoin an existing one.
const CONV_ID  = process.env.TROTH_CONVERSATION_ID || require('crypto').randomUUID();
const LLM_MODE = flag('llm', process.env.TROTH_ENTITY_LLM || 'router');
const AGENTIC  = flag('agentic', '1') === '1';
// `troth -c` / `--claude`: run this CLI session on the Claude Code backbone
// (entity dispatches through claude_cli with live substrate over MCP), using
// whatever router/faculties the operator has configured. Overrides config.
const CLAUDE_BACKBONE = argv.includes('-c') || argv.includes('--claude');
// `--engine <claude|gpt|router|model-id>`: which engine answers INSIDE the
// Claude Code backbone. 'claude' (default) = Anthropic subscription direct;
// 'gpt' / 'router' / a model id ride the troth proxy so the ROUTER serves the
// harness (subprocess-cli sets ANTHROPIC_BASE_URL). Falls back to the shared
// config's backbone_engine so app and CLI stay one setting.
const CLAUDE_ENGINE = flag('engine', process.env.TROTH_CLAUDE_ENGINE || '');
// Interactive CLI: the operator is sitting right at the REPL, so the operator
// IS the human-in-the-loop — auto_write defaults ON here (a chat that refuses
// to run Bash/Write/Edit and just says "I need permission" is the #1 reason
// `troth cli` felt dead). Headless/voice/CI keep their default-off via their
// own wrappers; this default applies only to the interactive chat surface.
// Opt out at the CLI with TROTH_ENTITY_AUTO_WRITE=0 or --no-auto.
const AUTO_WRITE = process.env.TROTH_ENTITY_AUTO_WRITE === '0'
  ? false
  : (flag('no-auto', null) !== null ? false : true);

const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const MAGENTA = '\x1b[35m';
const isTTY  = process.stdout.isTTY;
const color  = (c, s) => isTTY ? (c + s + RESET) : s;

function homeShort(p) {
  const home = require('os').homedir();
  return p && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// True-color gradient ramp from cyan to teal. Falls back to plain cyan when
// the terminal doesn't claim truecolor support (TERM doesn't advertise it
// reliably, COLORTERM does — modern terms like Ghostty/iTerm/WezTerm set it).
const TRUECOLOR = !!(process.env.COLORTERM && /truecolor|24bit/i.test(process.env.COLORTERM));
function rgb(r, g, b) { return TRUECOLOR ? '\x1b[38;2;' + r + ';' + g + ';' + b + 'm' : CYAN; }
// Polished-steel ramp: cool grays with a hard white highlight near the
// top edge — reads as metal, not as a color theme. Truecolor when the
// terminal offers it; ANSI-256 grayscale otherwise (never falls back to
// a hue).
const STEEL = [
  [245, 247, 250],  // edge light
  [255, 255, 255],  // specular highlight
  [214, 218, 226],
  [176, 181, 192],
  [138, 144, 158],
  [104, 110, 124],  // base shadow
];
function steelAt(t) {
  const x = Math.max(0, Math.min(1, t)) * (STEEL.length - 1);
  const i = Math.min(STEEL.length - 2, Math.floor(x));
  const f = x - i;
  const a = STEEL[i], b = STEEL[i + 1];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
}
function steelCode(t) {
  const [r, g, b] = steelAt(t);
  if (TRUECOLOR) return '\x1b[38;2;' + r + ';' + g + ';' + b + 'm';
  const y = Math.round((r + g + b) / 3);
  if (y >= 246) return '\x1b[38;5;231m'; // white
  return '\x1b[38;5;' + (232 + Math.max(0, Math.min(23, Math.round((y - 8) / 10)))) + 'm';
}
/** One flat steel tone for a whole wordmark row (t = row position 0..1). */
function steelRow(text, t) {
  if (!isTTY) return text;
  return BOLD + steelCode(t) + text + RESET;
}
/** Brand accents — polished silver, never a hue. Bright for interactive
 * marks (prompt, glyphs, code), dim steel for secondary chrome. */
const silver    = (s) => isTTY ? BOLD + steelCode(0.12) + s + RESET : s;
const silverDim = (s) => isTTY ? steelCode(0.7) + s + RESET : s;
// ── Fixed-bottom layout (cockpit parity): the transcript scrolls in a
// DECSTBM region, the prompt is PINNED one row above a status line that
// always shows the engine actually serving + the live turn readout.
// Plain sequential output remains the fallback for non-TTY / dumb terms.
let fixedUI = false;
let statusEngine = '';
// The model reported for the turn in flight, if the provider named one. Kept
// so the end of the turn does not replace a real model with its lane's label.
let turnModel = null;
// Session-total REAL tokens (provider-reported usage per turn). Shown on
// the status line — stats never sit under a reply.
let sessTokIn = 0, sessTokOut = 0;
// The 5-hour window — how subscription lanes actually meter. Pulled from the
// proxy's usage surface (usage_ledger aggregation), cached and refreshed
// quietly after replies: the status row answers "how much of the current
// window have I burned" the way the operator's editor statusline does for
// Claude — counts, honestly, since plans expose no remaining-quota number.
let win5 = null;      // { tin, tout } or null while unknown
let win5At = 0;
function refresh5h() {
  if (Date.now() - win5At < 60 * 1000) return;
  win5At = Date.now();
  try {
    const base = require('../shared-core/dashboard-url.js').proxyBaseUrl();
    const u = new URL('/api/stats', base);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(u, { timeout: 4000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 2 * 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const rows = ((JSON.parse(b).persistent_provider_usage || {}).recent_5h || {}).by_model || [];
          // The window that meters THIS engine: the rows for the model in use
          // (a plan's 5-hour window is per lane), every row only while no
          // engine has answered yet.
          const key = String(statusEngine || '').split(/\s+/)[0].toLowerCase();
          const mine = key ? rows.filter((r) => String(r.actual_model || r.model || '').toLowerCase().startsWith(key)) : [];
          let tin = 0, tout = 0;
          for (const r of (mine.length ? mine : rows)) { tin += r.input_tokens || 0; tout += r.output_tokens || 0; }
          win5 = { tin, tout, engine: mine.length ? key : null };
          drawStatus();
        } catch (_) { /* stale value keeps showing; never break the REPL */ }
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  } catch (_) { /* no proxy, no window — the row simply omits it */ }
}
function termRows() { return process.stdout.rows || 24; }
function termCols() { return process.stdout.columns || 80; }
function applyRegion() {
  if (!fixedUI) return;
  const H = termRows();
  process.stdout.write('\x1b[1;' + (H - 4) + 'r');
  // The app's composer separator: a full-width hairline above the input,
  // then prompt, then a breathing row before the status line.
  process.stdout.write('\x1b[' + (H - 3) + ';1H\x1b[K' + color(DIM, '\u2500'.repeat(termCols())));
  process.stdout.write('\x1b[' + (H - 1) + ';1H\x1b[K');
  process.stdout.write('\x1b[' + (H - 2) + ';1H\x1b[K');
  drawStatus();
  refresh5h();
}
function enableFixedUI() {
  // The pinned composer (DECSTBM scroll region) is opt-in until it holds up.
  // Screen-grid capture of a real pty shows the pinned and the flowing writes
  // interleaving — input mid-screen, replies detached at the region bottom,
  // stray prompts — on xterm and on gnome-terminal alike. Sequential flow is
  // the behaviour every terminal renders correctly.
  if (process.env.TROTH_FIXED_UI !== '1') return;
  if (!isTTY || fixedUI) return;
  fixedUI = true;
  process.stdout.on('resize', applyRegion);
  process.on('exit', releaseFixedUI);
  applyRegion();
}
function releaseFixedUI() {
  if (!fixedUI) return;
  fixedUI = false;
  process.stdout.write('\x1b[r\x1b[' + termRows() + ';1H\n');
}
/** Transcript write — inside the scroll region when the fixed layout is
 * on. Callers pass COMPLETE lines (trailing \n) so the region scrolls
 * cleanly under the pinned prompt. */
// Set by the input controller once it exists. The composer stays on screen for
// the whole turn now, so anything written into the transcript has to lift it
// out of the way first — otherwise a reply prints straight through the panel.
// Both hooks are idempotent: erasing twice is a no-op, and the prompt redraws
// the composer when the turn ends.
let hideComposer = null;
let meterWriter  = null;
// What the partner is doing right now, shown on the status row under the
// fixed layout so the composer keeps one height for the whole turn.
let statusWork = null;
function out(s) {
  if (hideComposer) hideComposer();
  if (!fixedUI) { process.stdout.write(s); return; }
  process.stdout.write('\x1b7\x1b[' + (termRows() - 4) + ';1H\x1b[2K' + s + '\x1b8');
}
/** The operator's message as a soft block — slightly lifted background
 * instead of a prompt glyph (the app's user-bubble read, terminal-sized). */
function userBlock(text) {
  if (!isTTY) return '  ' + text;
  const bg = TRUECOLOR ? '\x1b[48;2;36;39;48m' : '\x1b[48;5;236m';
  const fg = TRUECOLOR ? '\x1b[38;2;200;205;216m' : '\x1b[38;5;251m';
  return bg + fg + '  ' + text + '  ' + RESET;
}
/** Bottom status line: ◈ engine · <spinner word (time · ~tok)>. The
 * engine label follows serving/served events live — the model actually
 * answering RIGHT NOW, not a config guess. */
function drawStatus() {
  if (!fixedUI) return;
  // Internal transport names must never print (same law as the app:
  // 'router is never shown'). No engine known yet -> the row stays empty;
  // the wordmark already brands the surface, nothing repeats it here.
  const eng = /^(router|routing|any)$/i.test(statusEngine || '') ? '' : statusEngine;
  const tot = (sessTokIn || sessTokOut)
    ? color(DIM, '↑' + fmtTok(sessTokIn) + ' ↓' + fmtTok(sessTokOut) + ' tokens')
    : '';
  // The rolling window subscriptions meter on — session totals say what THIS
  // conversation cost, the 5h figure says how warm the plan's window is.
  const w5 = (win5 && (win5.tin || win5.tout))
    ? color(DIM, '5h ↑' + fmtTok(win5.tin) + ' ↓' + fmtTok(win5.tout))
    : '';
  const line = (eng || tot || w5 || statusWork)
    ? '  ' + [eng ? silverDim(eng) : null, tot || null, w5 || null, statusWork || null].filter(Boolean).join(color(DIM, '  ·  '))
    : '';
  process.stdout.write('\x1b7\x1b[' + termRows() + ';1H\x1b[K' + line + '\x1b8');
}

/** Horizontal glint across a short word — bright center, darker ends. */
function gradient(text) {
  if (!isTTY) return text;
  const n = Math.max(1, text.length - 1);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const d = Math.abs(i / n - 0.45) * 2; // 0 at the glint, 1 at the ends
    out += steelCode(0.15 + d * 0.6) + text[i];
  }
  return BOLD + out + RESET;
}

// Read a soft "substrate breath" for the banner — how many engrams the
// agent has accumulated and when it was last active. Best-effort, fast,
// failure-tolerant: if the substrate path is unavailable we just skip
// the line and the banner renders without the breath signal.
function substrateBreath() {
  try {
    // Same env override as _lib.mjs so we hit the unified ~/.troth/state.db
    // even when CC has set CLAUDE_PLUGIN_DATA to its own sandbox.
    const ccSandbox = process.env.CLAUDE_PLUGIN_DATA || '';
    if (!ccSandbox || ccSandbox.includes('/.claude/plugins/data/')) {
      process.env.CLAUDE_PLUGIN_DATA = path.join(require('os').homedir(), '.troth');
    }
    const state = require('../shared-core/state.js');
    const engramCount = state.countActions({
      type: 'commitment', agent_id: AGENT_ID, commitment_type: 'engram'
    });
    const recent = state.queryActions({ agent_id: AGENT_ID, limit: 1, order: 'desc' });
    const lastTs = recent && recent[0] && recent[0].timestamp ? recent[0].timestamp : null;
    return { engramCount, lastTs };
  } catch (_) { return { engramCount: 0, lastTs: null }; }
}

function relTime(ts) {
  if (!ts) return null;
  const ms = Date.now() - ts;
  if (ms < 60_000)        return 'just now';
  if (ms < 3_600_000)     return Math.round(ms / 60_000) + 'm ago';
  if (ms < 86_400_000)    return Math.round(ms / 3_600_000) + 'h ago';
  return Math.round(ms / 86_400_000) + 'd ago';
}

function fmtCount(n) {
  if (!n) return '0 engrams';
  if (n === 1) return '1 engram';
  return n.toLocaleString('en-US') + ' engrams';
}

// Read the configured model. Resolution: TROTH_ENTITY_MODEL env →
// ~/.troth/config.json `model` field → null. Cleans up gguf suffix and
// quant tags so the banner shows a readable name instead of a filename.
function activeModel() {
  let m = process.env.TROTH_ENTITY_MODEL || null;
  if (!m) {
    try {
      const cfg = JSON.parse(require('fs').readFileSync(
        path.join(require('os').homedir(), '.troth', 'config.json'), 'utf8'));
      m = cfg.model || null;
    } catch (_) {}
  }
  if (!m) return null;
  // 'Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf' → 'Qwen3.6-35B-A3B'.
  // Strip everything from the first quant/format token onward: -UD-, -MLX-,
  // -Q5_K_XL, -GGUF, etc. all signal the variant suffix and aren't part of
  // the model's recognizable name.
  return String(m)
    .replace(/\.gguf$/i, '')
    .replace(/-(UD|MLX|GGUF|Q\d[A-Z0-9_]*).*$/i, '');
}

// TROTH wordmark — compact half-block mark (3 rows, 19 cols), lit
// top-down by the steel ramp: quiet, geometric, metal. Big ASCII walls
// are off-brand (operator: minimal premium, and the 6-row cut was
// "tooooo big" on a laptop terminal).
const WORDMARK = [
  '▀█▀ █▀▄ █▀█ ▀█▀ █ █',
  ' █  █▀▄ █ █  █  █▀█',
  ' ▀  ▀ ▀ ▀▀▀  ▀  ▀ ▀'
];

// The mark at banner size: three rows, a hand reduction of the 18-wide
// sampling that keeps the ears, the eyes and the spread of the wings.
// Half-blocks, two pixel rows per cell, one flat tone.
const MASCOT = [
  '  ▄█▄▄▄▄▄▄█▄',
  '  █▀▀▀██▀▀▀█',
  '▄▄█▄▄▄▄▄▄▄▄█▄▄'
];
const MASCOT_W = 14;

// The lane pinned in the shared config, if any. Read the way spawnEntity()
// reads it: the app's desktop-config.json first, then the proxy's config.json.
function configuredPin() {
  try {
    const home = process.env.HOME || require('os').homedir();
    const read = (p) => { try { return JSON.parse(require('fs').readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } };
    const cfg = read(path.join(home, '.troth', 'desktop-config.json')) || read(path.join(home, '.troth', 'config.json')) || {};
    return typeof cfg.engine_pin === 'string' ? cfg.engine_pin.trim() : '';
  } catch (_) { return ''; }
}

// engine: the lane the chat answers from, named by the caller.
function banner(engine) {
  let version = '';
  try { version = require(path.join(__dirname, '..', 'package.json')).version || ''; } catch (_) {}
  // Memory readiness is core-authored (memory-readiness.js, the same truth the
  // app and the dashboard read). Direct require, no proxy hop. Silent on any
  // failure: a banner must never crash the chat.
  let memory = '';
  try { memory = require('../shared-core/memory-readiness.js').readiness().summary || ''; } catch (_) {}

  console.log('');
  if (!isTTY) { console.log('  troth' + (version ? ' v' + version : '')); console.log(''); return; }

  // The mark on the left, three rows. Beside it the name and version, then the
  // engine and the folder, then the memory line. Nothing wraps: what does not
  // fit beside the mark is cut, so the lockup arrives whole.
  const tone  = steelCode(0.35);
  const lines = [
    gradient('troth') + (version ? color(DIM, '  v' + version) : ''),
    silverDim(engine || 'engine: auto') + color(DIM, ' · ' + homeShort(CWD)),
    color(DIM, [memory, '/help for commands'].filter(Boolean).join(' · '))
  ];
  const cols = process.stdout.columns || 80;
  const room = Math.max(0, cols - MASCOT_W - 7);
  const cut = (s) => {
    if (!s) return '';
    const plain = stripAnsi(s);
    if (plain.length <= room) return s;
    return room > 1 ? color(DIM, plain.slice(0, room - 1) + '…') : '';
  };
  for (let i = 0; i < MASCOT.length; i++) {
    const left = tone + MASCOT[i].padEnd(MASCOT_W) + RESET;
    console.log(('  ' + left + '   ' + cut(lines[i] || '')).replace(/\s+$/, ''));
  }
  console.log('');
}

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
// A string cut to w visible characters with an ellipsis, colour codes kept
// and closed (close: the code appended after the ellipsis): what a one-row
// status line and every composer row need to stay one row.
function clampVisible(s, w, close) {
  s = String(s == null ? '' : s);
  if (w <= 0) return '';
  if (stripAnsi(s).length <= w) return s;
  let out = '', vis = 0, i = 0;
  while (i < s.length && vis < w - 1) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i]; i++; vis++;
  }
  return out + '…' + (close === undefined ? RESET : close);
}

// The reply's type: the partner's steel tone for text, brighter for what is
// stressed, silver for code, a faint tint behind a code block. Colour only,
// no mark and no rail: the two-colour grammar of who is speaking stays.
const CODE_BG = TRUECOLOR ? '\x1b[48;2;31;34;42m' : '\x1b[48;5;235m';
const REPLY_PALETTE = {
  text:     (s) => isTTY ? steelCode(0.42) + s + RESET : s,
  strong:   (s) => isTTY ? BOLD + steelCode(0.2) + s + RESET : s,
  em:       (s) => isTTY ? '\x1b[3m' + steelCode(0.5) + s + RESET : s,
  code:     (s) => silver(s),
  head:     (s, level) => isTTY ? BOLD + steelCode(level <= 2 ? 0.1 : 0.3) + s + RESET : s,
  dim:      (s) => color(DIM, s),
  link:     (s) => isTTY ? '\x1b[4m' + steelCode(0.3) + s + RESET : s,
  bullet:   (s) => isTTY ? steelCode(0.7) + s + RESET : s,
  strike:   (s) => isTTY ? '\x1b[9m' + steelCode(0.6) + s + RESET : s,
  codeLine: (s, w) => isTTY ? CODE_BG + steelCode(0.15) + s + ' '.repeat(Math.max(0, w - s.length)) + RESET : s
};
function replyWidth() {
  const cols = process.stdout.columns || 80;
  return Math.min(100, Math.max(20, cols - 4));
}
function renderReply(text) {
  return require('../shared-core/tty-markdown.js').render(text || '', { tty: isTTY, width: replyWidth(), palette: REPLY_PALETTE });
}

// Map raw entity events → human action verbs. Keeps the spinner copy
// in the user's vocabulary, not the substrate's.
function basename(p) { return p ? String(p).split('/').filter(Boolean).pop() || p : ''; }
function dispatchVerb(faculty, lastSlash) {
  // User-facing verbs. 'router'/'agentic_loop' just mean "the model is
  // generating" — return null so the spinner keeps its ROTATING
  // thought-word instead of pinning a frozen 'thinking' label.
  if (faculty === 'skill_executor') return lastSlash ? 'running /' + lastSlash : 'running skill';
  return null;
}
// Map the faculty that dispatched/served a turn → the footer engine label,
// so the status line names WHO answered instead of a static config guess
// (a pinned claude_cli, or the transport-abort fallback walk, would leave
// the footer lying about the engine — journey find.
// 'router' hides its real provider behind the chain: return null so the
// serving/served events (which carry the actual provider/model) own the
// label, and echo/noop/internal names never print (same law as the app).
function facultyLabel(faculty) {
  switch (faculty) {
    // 'sub' rather than 'subscription': the meter is a glance, not a sentence,
    // and the room it frees is where the model name lands the moment the
    // provider reports which one actually answered.
    case 'claude_cli':   return 'Claude sub';
    case 'codex_oauth':  return 'ChatGPT sub';
    case 'llamacpp':
    case 'ollama':
    case 'local':        return activeModel() || 'on this mac';
    default:             return null; // router/anthropic/echo/noop → defer to serving/served
  }
}
function toolVerb(name, args) {
  const a = args || {};
  const n = String(name || '');
  const base = (p) => String(p || '').replace(/[\/\\]+$/, '').split(/[\/\\]/).pop();
  const head = (t, w) => { const one = String(t || '').replace(/\s+/g, ' ').trim(); return one.length > w ? one.slice(0, w - 1) + '…' : one; };
  const host = (u) => { try { return new URL(String(u)).host; } catch (_) { return head(u, 40); } };
  // A command reads as itself when it is one short line; a script or a
  // pipeline reads as "a command".
  const cmd = (c) => {
    const one = String(c || '').trim();
    if (!one || /\n/.test(one) || one.length > 48 || /[|;&<>`$]/.test(one)) return 'running a command';
    return 'running ' + one;
  };
  // A plugin's MCP tool carries the plugin in its name; the verb comes from
  // the tool, never from the plumbing.
  const mcp = n.match(/^mcp__(?:plugin_troth_)?([a-z0-9-]+)__([a-z0-9_]+)$/i);
  const key = (mcp ? mcp[2] : n).toLowerCase();
  switch (key) {
    case 'bash': case 'run': case 'shell':
      return a.run_in_background ? 'starting a job: ' + head(a.command, 40) : cmd(a.command);
    case 'read': case 'cached_read': case 'hashline_read':
      return a.file_path ? 'reading ' + base(a.file_path) : 'reading';
    case 'write':
      return a.file_path ? 'writing ' + base(a.file_path) : 'writing';
    case 'edit': case 'multiedit': case 'hashline_edit': case 'notebookedit':
      return a.file_path ? 'editing ' + base(a.file_path) : 'editing';
    case 'grep': case 'cached_grep':
      return a.pattern ? 'searching "' + head(a.pattern, 24) + '"' : 'searching';
    case 'glob':
      return a.pattern ? 'matching ' + head(a.pattern, 32) : 'matching files';
    case 'webfetch': case 'web_fetch':
      return a.url ? 'fetching ' + host(a.url) : 'fetching a page';
    case 'websearch': case 'web_search':
      return a.query ? 'searching the web: ' + head(a.query, 40) : 'searching the web';
    case 'browse': case 'browser_session':
      return a.url ? 'browsing ' + host(a.url) : (a.action ? 'browsing: ' + head(a.action, 32) : 'browsing');
    case 'task': case 'agent':
      return a.description ? 'delegating: ' + head(a.description, 44) : 'delegating';
    case 'engram_record': case 'troth_engram_record': return 'remembering';
    case 'engram_search': case 'troth_recall': case 'recall': return 'recalling';
    case 'dialogue_recent': case 'dialogue_search': return 'reading the dialogue';
    case 'rule_list': return 'reading your rules';
    case 'rule_record': return 'noting a rule';
    case 'job_wait':   return a.job_id ? 'waiting on ' + head(a.job_id, 12) : 'waiting on a job';
    case 'job_status': return a.job_id ? 'checking ' + head(a.job_id, 12) : 'checking the jobs';
    case 'job_stop':   return a.job_id ? 'stopping ' + head(a.job_id, 12) : 'stopping a job';
    case 'code_file_map': case 'code_who_calls': return 'mapping the code';
    case 'jobs_status': return 'checking the jobs';
    case 'web_allowlist_list': return 'checking the allowlist';
    case 'api_services_list': return 'listing the services';
    case 'tool_load': return 'opening ' + (a.name ? 'the ' + String(a.name).replace(/_/g, ' ') + ' tool' : 'a tool');
    case 'mcp_call': {
      const srv = String(a.server || '');
      if (/^troth-(substrate|memory)$/.test(srv)) return /record|remember/.test(String(a.tool || '')) ? 'remembering' : 'consulting memory';
      return srv ? 'calling ' + srv : 'calling a connector';
    }
    case 'mcp_list': case 'mcp_describe': return 'checking connectors';
    case 'cd': return a.path ? 'entering ' + base(a.path) : 'changing folder';
    case 'pwd': return 'checking the folder';
    case 'open_ground': return 'opening a folder';
    case 'net_allow': return 'allowing a host';
    case 'run_gate': return 'running the gate';
    case 'env_keys': case 'env_set': return 'reading the env file';
    case 'troth_image_generate': case 'image_generate': return 'drawing an image';
    case 'troth_video_generate': case 'video_generate': return 'rendering a video';
    case 'skill': return a.skill ? 'running /' + a.skill : 'running a skill';
    case 'todowrite': return 'noting the plan';
    case 'askuserquestion': return 'asking you';
  }
  if (mcp) return 'using ' + key.replace(/_/g, ' ');
  const first = [a.command, a.file_path, a.url, a.query, a.pattern].find((v) => typeof v === 'string' && v.trim());
  return 'using ' + (n ? n.replace(/_/g, ' ') : 'a tool') + (first ? ': ' + head(first, 40) : '');
}
// The kind of act a tool is, for the turn's one-line summary.
function toolKind(name, args) {
  const v = toolVerb(name, args);
  if (v === 'reading the dialogue' || v === 'consulting memory' || v === 'reading your rules') return 'recall';
  if (v.startsWith('running /') || v === 'running a skill') return 'skill';
  const map = { reading: 'read', editing: 'edit', writing: 'write', searching: 'search', matching: 'search', running: 'run',
    fetching: 'web', browsing: 'web', delegating: 'delegate', recalling: 'recall', remembering: 'remember', drawing: 'draw', rendering: 'render',
    starting: 'job', waiting: 'job', checking: 'job', stopping: 'job' };
  return map[v.split(/[\s:]/)[0]] || 'other';
}
// The trail says what happened: the working verb in the past.
function pastVerb(v) {
  const s = String(v || '');
  const table = [['running', 'ran'], ['reading', 'read'], ['editing', 'edited'], ['writing', 'wrote'], ['searching', 'searched'],
    ['matching', 'matched'], ['fetching', 'fetched'], ['browsing', 'browsed'], ['delegating', 'delegated'], ['recalling', 'recalled'],
    ['remembering', 'remembered'], ['consulting', 'consulted'], ['drawing', 'drew'], ['rendering', 'rendered'], ['mapping', 'mapped'],
    ['waiting', 'waited'], ['checking', 'checked'], ['stopping', 'stopped'], ['starting', 'started'], ['noting', 'noted'],
    ['opening', 'opened'], ['loading', 'loaded'], ['using', 'used']];
  for (const [a, b] of table) if (s === a || s.startsWith(a + ' ')) return b + s.slice(a.length);
  return s;
}
function fmtDur(ms) {
  const s = Math.max(0, ms || 0) / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  return Math.floor(s / 60) + 'm' + String(Math.round(s % 60)).padStart(2, '0') + 's';
}

// The line under the working verb: what the tool is actually on, whole and
// discreet. The command as written, the file, the pattern, the query, the
// address. Empty when the verb already says all of it.
function toolDetail(name, args, verb) {
  const a = args || {};
  const n = String(name || '').toLowerCase();
  const one = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  let d = '';
  switch (n) {
    case 'bash': case 'run': case 'shell': d = one(a.command || a.cmd); break;
    case 'read': case 'cached_read': case 'hashline_read': case 'write': case 'edit': case 'multiedit': case 'hashline_edit': case 'notebookedit':
      d = one(a.file_path || a.path || a.notebook_path); break;
    case 'grep': case 'cached_grep': d = one(a.pattern) + (a.path ? '  in ' + one(a.path) : ''); break;
    case 'glob': d = one(a.pattern); break;
    case 'websearch': case 'web_search': d = one(a.query || a.q); break;
    case 'webfetch': case 'web_fetch': case 'browse': case 'browser_session': d = one(a.url || a.prompt); break;
    case 'engram_search': case 'troth_recall': case 'recall': case 'dialogue_search': case 'dialogue_recent': d = one(a.query || a.q || a.text); break;
    case 'engram_record': case 'troth_engram_record': d = one(a.statement); break;
    case 'mcp_call': d = one(a.server) + (a.tool ? ' · ' + one(a.tool) : ''); break;
    case 'tool_load': d = one(a.name); break;
    case 'task': case 'agent': d = one(a.description || a.prompt); break;
    default: {
      const first = Object.keys(a).find((k) => typeof a[k] === 'string' && a[k].trim());
      d = first ? one(a[first]) : '';
    }
  }
  if (!d) return '';
  if (d.length > 240) d = d.slice(0, 239) + '…';
  return String(verb || '').includes(d) ? '' : d;
}

const fmtTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
};

// Rotating thought-words while the brain works (same idea as the app's
// whimsy pill) — the label breathes instead of a frozen 'thinking'.
const THINK_WORDS = ['thinking', 'reasoning', 'weighing', 'connecting', 'shaping', 'sifting', 'composing'];

// Working mark: a diamond that opens from a point and closes again in place.
// It blooms rather than travels so there is nothing for the eye to follow, and
// the step between frames is one ring of the same figure so no edge snaps.
const SPINNER_FRAMES = ['·', '∙', '◦', '◇', '◈', '◆', '◈', '◇', '◦', '∙'];
function createSpinner() {
  let i = 0, label = null, detail = null, timer = null, active = false, startedAt = 0;
  let streamedChars = 0, wordSeed = 0;
  const draw = () => {
    if (!isTTY) return;
    const elapsedMs = Date.now() - startedAt;
    // Indexed by time, not by tick: the paint runs faster than the figure so the
    // gleam slides while the diamond keeps its own pace.
    const frame = SPINNER_FRAMES[Math.floor(elapsedMs / 150) % SPINNER_FRAMES.length];
    const elapsedStr = (elapsedMs / 1000).toFixed(elapsedMs < 10000 ? 1 : 0) + 's';
    // A highlight sliding across the word: each character sits one step further
    // along the steel ramp and the whole pattern moves. Base is held below
    // white so the gleam reads without outshining the text.
    const word = THINK_WORDS[(wordSeed + Math.floor(elapsedMs / 2400)) % THINK_WORDS.length];
    const sheen = (s) => {
      if (!isTTY) return s;
      const phase = elapsedMs / 300;          // sweep speed
      let out = '';
      for (let c = 0; c < s.length; c++) {
        // c*k - phase moves the crest toward higher indexes: left to right.
        // Wide band (0.45 rad/char) so one broad gleam travels rather than
        // alternating letters. The swing reaches mid steel so the highlight has
        // something darker behind it and reads as passing.
        const w = 0.5 + 0.5 * Math.sin(c * 0.45 - phase);
        out += steelCode(0.62 - 0.54 * w) + s[c];
      }
      return out + RESET;
    };
    const wordLit = sheen(word + '…');
    // Live volume from streamed deltas — approximate by construction
    // (chars/4), marked '~'; the trailer prints the provider's REAL
    // counts when they exist.
    const tok = streamedChars > 0 ? '\u2193 ~' + fmtTok(Math.round(streamedChars / 4)) + ' tokens' : null;
    const meta = color(DIM, ' (' + [elapsedStr, tok].filter(Boolean).join(' \u00b7 ') + ')');
    // Mark and word share one sheen. A tool verb is a fact, not a wait, so it
    // stays steady.
    // The line must fit the terminal: a status wider than the window wraps
    // onto a second row, the next frame's carriage return lands on that
    // second row, and the first row stays behind as a phantom line. A tool
    // verb longer than the room is cut with an ellipsis; the width is
    // counted on visible characters, colour codes carry none.
    const room = termCols() - 3 - stripAnsi(frame).length - 1 - stripAnsi(meta).length;
    const shown = label ? clampVisible(label, room) : null;
    const text = shown
      ? silverDim(frame) + ' ' + shown + meta
      : sheen(frame + ' ' + clampVisible(word + '…', Math.max(room, 1))) + meta;
    // The working state lives in the composer's meter; a free-standing line
    // would mean tearing the panel down for the length of every turn.
    if (meterWriter) { meterWriter(text, detail ? color(DIM, clampVisible(detail, termCols() - 6)) : null); return; }
    if (fixedUI) {
      process.stdout.write('\x1b7\x1b[' + (termRows() - 4) + ';1H\x1b[2K  ' +
        text + '\x1b8');
      return;
    }
    process.stdout.write('\r  ' + text + '\x1b[K');
  };
  return {
    start(initial) {
      if (!isTTY) return;
      label = initial || null;
      startedAt = Date.now();
      streamedChars = 0;
      wordSeed = Math.floor(Math.random() * THINK_WORDS.length);
      active = true;
      // Fixed layout: scroll one blank in first so the live row never
      // sits flush against the operator's block; the reply then lands
      // in this same gap (its leading blank is skipped under fixedUI).
      if (fixedUI) out('\n');
      draw();
      // Paint rate, not animation rate: the gleam needs frequent repaints or it
      // steps. The diamond takes its 150ms from the clock (see draw).
      timer = setInterval(draw, 60);
    },
    stream(nChars) {
      if (!active) return;
      streamedChars += Math.max(0, nChars | 0);
    },
    update(next, nextDetail) {
      if (!active) return;
      label = next;
      detail = next ? (nextDetail || null) : null;
      draw();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      active = false;
      // Hand the meter back to its resting content rather than blanking a row
      // the composer owns.
      if (meterWriter) { meterWriter(null); return; }
      if (fixedUI) {
        process.stdout.write('\x1b7\x1b[' + (termRows() - 4) + ';1H\x1b[2K\x1b8');
        return;
      }
      if (isTTY) process.stdout.write('\r\x1b[K');
    }
  };
}

function spawnEntity() {
  // Parity with the app spawn: the app passes the linked faculties and the
  // dispatch preference from the shared config via env; the standalone CLI
  // never did, so a sub-only user's CLI chat could not reach their linked
  // claude_cli. Explicit env still wins; this
  // only fills the gaps from ~/.troth/config.json.
  let cfgFaculties = '', cfgPrefer = '', cfgPin = '', cfgBackbone = '', cfgEngine = '';
  try {
    const home = process.env.HOME || require('os').homedir();
    const readCfg = (p) => {
      try { return JSON.parse(require('fs').readFileSync(p, 'utf8').replace(/^﻿/, '')); }
      catch (_) { return null; }
    };
    // The APP persists faculties/pin/prefer in desktop-config.json; the
    // sibling config.json is the PROXY's file and never carries them
    //.
    const cfg = readCfg(require('path').join(home, '.troth', 'desktop-config.json'))
      || readCfg(require('path').join(home, '.troth', 'config.json')) || {};
    if (typeof cfg.entity_faculties === 'string') cfgFaculties = cfg.entity_faculties;
    if (typeof cfg.dispatch_prefer === 'string') cfgPrefer = cfg.dispatch_prefer;
    if (typeof cfg.backbone === 'string') cfgBackbone = cfg.backbone.trim();
    if (typeof cfg.engine_pin === 'string') cfgPin = cfg.engine_pin.trim();
    if (typeof cfg.backbone_engine === 'string') cfgEngine = cfg.backbone_engine.trim();
  } catch (_) { /* no shared config — env/flags only */ }
  const env = Object.assign({}, process.env, {
    TROTH_ENTITY_AGENT_ID: AGENT_ID,
    TROTH_ENTITY_CWD:      CWD,
    TROTH_ENTITY_LLM:      LLM_MODE
  });
  if (!env.TROTH_ENTITY_LLM_FACULTIES && cfgFaculties) env.TROTH_ENTITY_LLM_FACULTIES = cfgFaculties;
  if (!env.TROTH_ENTITY_DISPATCH_PREFER && cfgPrefer) env.TROTH_ENTITY_DISPATCH_PREFER = cfgPrefer;
  // Backbone parity (same file the app writes): claude_cli backbone makes the
  // CLI serve through Claude Code too — one setting drives every surface.
  if (CLAUDE_BACKBONE) env.TROTH_ENTITY_BACKBONE = 'claude_cli';
  if (!env.TROTH_ENTITY_BACKBONE && cfgBackbone === 'claude_cli') env.TROTH_ENTITY_BACKBONE = 'claude_cli';
  // Backbone ENGINE parity: session flag wins, then explicit env, then the
  // shared config — same precedence as the backbone itself.
  if (CLAUDE_ENGINE) env.TROTH_CLAUDE_ENGINE = CLAUDE_ENGINE;
  else if (!env.TROTH_CLAUDE_ENGINE && cfgEngine) env.TROTH_CLAUDE_ENGINE = cfgEngine;
  // Engine pin parity ("Which engine answers" picker): honor the pinned
  // engine unless the operator explicitly chose one for this session
  // (--llm flag or TROTH_ENTITY_LLM env win).
  const llmExplicit = !!process.env.TROTH_ENTITY_LLM
    || process.argv.some((a) => a === '--llm' || a.startsWith('--llm='));
  if (!llmExplicit && cfgPin) {
    env.TROTH_ENTITY_LLM = cfgPin;
    env.TROTH_ENTITY_LLM_PIN = '1';
    delete env.TROTH_ENTITY_LLM_FACULTIES;
  }
  if (AGENTIC) env.TROTH_ENTITY_AGENTIC = '1';
  // Pipe stderr so router/proxy console.error noise ('[router] Anthropic API
  // 400 …', cache warnings, etc.) doesn't smash the chat layout. We tee
  // those into ~/.troth/cli.log and only surface fatal lines to the user.
  // A missing entity runtime (broken install, partial publish, mangled app
  // bundle) would either crash with a raw unhandled 'error' stack or sit
  // silent — say what is wrong and how to fix it instead.
  if (!require('fs').existsSync(ENTITY_BIN)) {
    console.error('troth: entity runtime missing at ' + ENTITY_BIN +
      ' — the install looks incomplete. Run `npm install` in the repo, or reinstall the app.');
    process.exit(1);
  }
  const child = spawn(process.execPath, [ENTITY_BIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });
  child.on('error', (e) => {
    console.error('troth: could not start the entity runtime (' + e.message + ')');
    process.exit(1);
  });
  return child;
}

const fs = require('fs');
const os = require('os');
function openErrLog() {
  try {
    const dir = path.join(os.homedir(), '.troth');
    fs.mkdirSync(dir, { recursive: true });
    return fs.createWriteStream(path.join(dir, 'cli.log'), { flags: 'a' });
  } catch (_) { return null; }
}

function start() {
  // The composer belongs at the foot of the window, the way the app's input
  // sits at the foot of the pane. The screen is filled once at startup so the
  // first composer already lands on the last rows; from then on every reply
  // scrolls the window and the composer stays where it is, which is simply how
  // a terminal behaves once its screen is full. TROTH_FIXED_UI opts into a
  // scroll region instead; it interleaves with output on some terminals.
  if (isTTY) process.stdout.write('\x1b[2J\x1b[H');
  // The lane the chat answers from: an explicit --llm or env wins, else the
  // pin from the shared config, else the router picks.
  const llmExplicit = !!process.env.TROTH_ENTITY_LLM || argv.some((a) => a === '--llm' || a.startsWith('--llm='));
  const lane = (!llmExplicit && configuredPin()) || LLM_MODE;
  const local = lane === 'llamacpp' || lane === 'ollama' || lane === 'local';
  banner(local ? (activeModel() || 'local engine') : (facultyLabel(lane) || (lane === 'router' ? 'engine: auto' : lane)));
  // The composer sits toward the foot of the window. Safe only because the panel
  // is repainted as a whole frame and every transcript write lifts it first:
  // anchoring it while writing pieces of it lets one scroll put the erase a row
  // out. TROTH_CLI_BOTTOM=0 keeps it directly under the transcript.
  if (isTTY && process.env.TROTH_CLI_BOTTOM !== '0') {
    // Open about a third of a page down, not flush to the last row: a
    // full-height fill leaves the mark alone over an empty screen.
    const used = 8;                       // banner block plus its air
    const composer = 4;                   // top border, one text row, bottom border, meter
    const rowsNow = process.stdout.rows || 24;
    const room = Math.max(0, rowsNow - used - composer);
    const fill = Math.min(room, Math.max(0, Math.round(rowsNow * 0.33)));
    if (fill > 0) process.stdout.write('\n'.repeat(fill));
  }
  const child = spawnEntity();
  let buf = '';
  let ready = false;
  let awaitingResponse = false;
  // queue for autonomous_pursuit briefings that arrive while the
  // user has an active turn in flight. Flushed inline after the response
  // renders so the briefing doesn't interleave with streaming output.
  const _pendingBriefings = [];

  // Slash skills surfaced for the inline selector. Single source of truth
  // for /help, the picker, and the live menu.
  // Read from the same registry /help prints, so the two cannot drift. Each
  // row carries the command's own one-line description, taken from the skill
  // that defines it, so the list is readable without knowing the vocabulary.
  const SLASH_DESC = {};
  // The slash commands the entity answers on its own, without the model. One
  // typed while a turn runs is a side question, answered beside the work
  // instead of waiting behind it. Mirrors the executor's deterministic set.
  const SLASH_DET = new Set(['goal', 'remember', 'refuse', 'invariants', 'forget', 'context',
                             'dialogue-reset', 'agent', 'mcps', 'usage', 'engine', 'help']);
  const SLASH_CMDS = (function () {
    try {
      const rows = require('../shared-core/slash/loader.js').skillSummaries(process.cwd()) || [];
      const names = [];
      for (const r of rows) {
        if (!r || !r.name) continue;
        names.push(r.name);
        SLASH_DESC[r.name] = String(r.description || '').replace(/\s+/g, ' ').trim();
      }
      if (names.length) {
        names.push('quit');
        SLASH_DESC.quit = SLASH_DESC.quit || 'leave the conversation';
        return names.sort();
      }
    } catch (_) { /* fall through to the static floor */ }
    return ['goal', 'remember', 'recall', 'forget', 'think', 'agent',
            'save', 'context', 'usage', 'dialogue-reset', 'init', 'help', 'quit',
            'refuse', 'invariants', 'engine', 'mcps'];
  })();

  // Custom raw-mode input controller so we can pop an inline slash
  // selector below the input line with ↑/↓ navigation — readline's
  // built-in completer doesn't support that interaction style.
  //
  // The controller mirrors the readline surface that the rest of this
  // file expects (prompt(), close(), 'line' callback) so the entity-
  // event handlers below don't need to know it's not readline.
  function createInput(opts) {
    const PROMPT     = opts.prompt;
    const PROMPT_W   = stripAnsi(PROMPT).length;
    const handlers   = { line: null, close: null, escape: null };
    let buffer       = '';
    let cursor       = 0;
    let menuActive   = false;
    // 'cmd' lists slash commands, 'arg' lists the values a command accepts.
    // An argument menu lets a value be picked rather than typed from memory.
    let menuKind     = 'cmd';
    let menuItems    = [];
    let menuSel      = 0;
    let lastMenuRows = 0;
    let paused       = false;
    let history      = [];
    let historyIdx   = null;
    // Bracketed-paste state. Terminals that support it wrap pasted text
    // with \x1b[200~ … \x1b[201~ so the receiver can treat the whole chunk
    // as one insert instead of N keystrokes. Without this, multi-line or
    // CR-terminated pastes fire submit() for every embedded newline and
    // echo the same line repeatedly into the chat.
    let pasteMode    = false;
    let pasteBuf     = '';

    // Track how many visual rows the input occupies so we can erase ALL
    // of them on the next redraw — '\r\x1b[K' only clears one row and
    // leaves wrapped tails stacking up as the user keeps typing.
    let lastInputRows = 0;
    // Which row of the composer the cursor was left on, counted from the box's
    // top border. Row 0 is that border, so the cursor sits on a middle row —
    // erasing (rows - 1) from it would clear transcript lines above the panel.
    let lastCursorRow = 0;
    let lastCursorCol = 0;
    // What the last frame was drawn with, so a resize can count the rows
    // that frame occupies after the terminal reflows it: the width, and the
    // working line above the box (its rows and its visible length).
    let lastDrawW = 0;
    let lastLeadRows = 0;
    let lastLeadLen = 0;
    let lastDetailLen = 0;
    // The width and height the terminal holds right now, asked of the
    // terminal itself: the process's own copy lags a resize by an event.
    function termWidth() {
      try { const s = process.stdout.getWindowSize(); if (s && s[0] > 0) return s[0]; } catch (_) {}
      return process.stdout.columns || 80;
    }
    function termHeight() {
      try { const s = process.stdout.getWindowSize(); if (s && s[1] > 0) return s[1]; } catch (_) {}
      return process.stdout.rows || 24;
    }
    // TROTH_COMPOSER_LOG=<file> records every erase and frame with its
    // arithmetic, for reading a screen fault after the fact.
    const _clogPath = process.env.TROTH_COMPOSER_LOG || '';
    function _clog(o) {
      if (!_clogPath) return;
      try { require('fs').appendFileSync(_clogPath, JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\n'); } catch (_) {}
    }

    // The last frame is erased from its first row. The terminal is asked for
    // its true width every time: a resize reflows the rows the frame occupied
    // before this process hears of it, so a row drawn wider than the width
    // now in force wraps onto more rows and is counted that way. A tick that
    // lands between the resize and the event still erases the whole frame.
    function eraseInputAndMenu() {
      const w = termWidth();
      let up = lastCursorRow;
      if (lastCursorRow > 0 && lastDrawW && w !== lastDrawW) {
        const rowsNow = (len) => Math.max(1, Math.ceil(len / w));
        up = 0;
        let logical = 0;
        if (lastLeadRows) { up += 1 + rowsNow(lastLeadLen) + (lastLeadRows > 2 ? rowsNow(lastDetailLen) : 0); logical += lastLeadRows; }
        // The top border, then the text rows above the cursor's own.
        up += rowsNow(Math.max(0, lastDrawW - 2));
        logical += 1;
        for (let i = logical; i < lastCursorRow; i++) up += rowsNow(Math.max(0, lastDrawW - 2));
        up += Math.floor(lastCursorCol / w);
      }
      _clog({ kind: 'erase', w, lastDrawW, up, lastCursorRow, lastLeadRows, lastLeadLen, lastDetailLen, lastCursorCol });
      if (up > 0) process.stdout.write('\x1b[' + up + 'A');
      process.stdout.write('\r\x1b[J');
      lastCursorRow = 0;
      lastInputRows = 0;
      lastMenuRows = 0;
      if (fixedUI) drawStatus(); // \x1b[J above just wiped the status row
    }

    // The composer is a panel, not a bare line — the same rounded input the
    // app draws, translated to box-drawing characters. Sequential flow is kept:
    // the panel is erased and redrawn in place on every keystroke, so nothing
    // depends on a scroll region. TROTH_FIXED_UI opts into one.
    const BOX_MARGIN = 2;
    function boxMetrics(w) {
      const outer = Math.max(24, (w || termWidth()) - BOX_MARGIN * 2);
      return { outer, textW: outer - 4 };   // │ + space … space + │
    }

    // Nothing the composer draws may wrap: a wrapped line costs a physical row
    // the block's arithmetic does not know about, and the erase comes up short.
    // Measured on visible characters — colour codes carry no width.
    function fit(s, w) { return clampVisible(s, w, isTTY ? RESET : ''); }

    // The meter under the composer: which engine is answering, what this
    // conversation has cost, and how warm the plan's rolling window is.
    // Internal transport names never print (same law as the app: 'router is
    // never shown'), so a routing placeholder leaves the slot empty. While a
    // turn runs the spinner's frame is held here and repainted with the rest of
    // the block.
    let spinnerLead = null;
    let spinnerDetail = null;
    function meterText() {
      const eng = /^(router|routing|any)$/i.test(statusEngine || '') ? '' : statusEngine;
      const bits = [
        eng ? silverDim(eng) : (activeModel() ? silverDim(activeModel()) : null),
        (sessTokIn || sessTokOut) ? color(DIM, '↑' + fmtTok(sessTokIn) + ' ↓' + fmtTok(sessTokOut)) : null,
        (win5 && (win5.tin || win5.tout)) ? color(DIM, '5h ↑' + fmtTok(win5.tin) + ' ↓' + fmtTok(win5.tout)) : null
      ].filter(Boolean);
      return bits.join(color(DIM, '  ·  '));
    }

    // The composer is repainted as ONE frame, always. Writing the meter row on
    // its own means saving the cursor, stepping down and restoring — and a
    // save/restore pair holds an ABSOLUTE position, so one scroll points it at
    // the wrong row: the next erase begins a row too low and leaves a headless
    // panel with a second drawn beneath it. Whole-frame repaints carry no
    // absolute state, so a scroll costs a frame instead of the layout.
    function drawMeterRow(lead, detail) {
      if (fixedUI) { statusWork = lead; drawStatus(); redraw(); return; }
      spinnerLead = lead;
      spinnerDetail = lead ? (detail || null) : null;
      redraw();
    }
    function renderInput() {
      // One width for the whole frame, read once and recorded before the
      // first row goes out: a resize that lands mid-frame leaves the rows
      // already written at this width, and the erase that follows counts
      // them by it.
      const W = termWidth();
      lastDrawW = W;
      const { outer, textW } = boxMetrics(W);
      const pad = ' '.repeat(BOX_MARGIN);
      const bar = color(DIM, '│');
      const rows = [];
      if (buffer.length === 0) rows.push('');
      else for (let i = 0; i < buffer.length; i += textW) rows.push(buffer.substr(i, textW));

      // The working line belongs to the CONVERSATION, above the composer — it
      // is the partner's turn happening, not a property of the input. It is
      // still painted with the block so a tick never fights the caret.
      let leadRows = 0;
      if (spinnerLead) {
        // Air above it, so the working line reads as the partner starting to
        // answer rather than as part of the operator's own card.
        process.stdout.write('\n');
        process.stdout.write(fit(pad + spinnerLead, W - 1) + '\n');
        leadRows = 2;
        if (spinnerDetail) {
          process.stdout.write(fit(pad + '  ' + spinnerDetail, W - 1) + '\n');
          leadRows = 3;
        }
      }
      lastLeadRows = leadRows;
      lastLeadLen = spinnerLead ? stripAnsi(fit(pad + spinnerLead, W - 1)).length : 0;
      lastDetailLen = (spinnerLead && spinnerDetail) ? stripAnsi(fit(pad + '  ' + spinnerDetail, W - 1)).length : 0;
      // The panel never grows past the screen: text taller than the room is
      // shown through a window that ends at the caret, and a marker row counts
      // what lies outside it. A panel whose top scrolled into the terminal's
      // history could not be erased on the next frame.
      const screenRows = termHeight();
      const roomText = Math.max(1, screenRows - leadRows - 4);
      const cRowAbs = cursor === 0 ? 0 : Math.floor((cursor - 1) / textW);
      let winStart = 0, winEnd = rows.length;
      if (rows.length > roomText) {
        const cap = Math.max(1, roomText - 2);
        winStart = Math.max(0, Math.min(cRowAbs - cap + 1, rows.length - cap));
        winEnd = Math.min(rows.length, winStart + cap);
      }
      const above = winStart, below = rows.length - winEnd;
      const marker = (n, where) => color(DIM, '… ' + n + ' more line' + (n === 1 ? '' : 's') + ' ' + where);
      const drawn = [];
      if (above > 0) drawn.push({ text: marker(above, 'above') });
      for (let i = winStart; i < winEnd; i++) drawn.push({ text: rows[i] });
      if (below > 0) drawn.push({ text: marker(below, 'below') });
      process.stdout.write(pad + color(DIM, '╭' + '─'.repeat(outer - 2) + '╮') + '\n');
      for (const d of drawn) {
        const vis = stripAnsi(d.text).length;
        process.stdout.write(pad + bar + ' ' + d.text + ' '.repeat(Math.max(0, textW - vis)) + ' ' + bar + '\n');
      }
      process.stdout.write(pad + color(DIM, '╰' + '─'.repeat(outer - 2) + '╯') + '\n');
      // Choices sit under the panel and above the meter, drawn here rather than
      // in a pass of their own (a separate pass writes from wherever the caret
      // stands and lands below the meter).
      //
      // Windowed: a bare '/' matches every command, and printing all of them
      // makes the composer taller than the terminal. The window follows the
      // selection, so arrowing past the edge scrolls the list, not the screen.
      let menuRows = 0;
      if (menuActive && menuItems.length) {
        const room = Math.max(3, termHeight() - drawn.length - 8);
        const cap  = Math.min(8, room, menuItems.length);
        const half = Math.floor(cap / 2);
        const start = Math.min(Math.max(0, menuSel - half), Math.max(0, menuItems.length - cap));
        // Two columns: the name, then what it does. The width is taken from the
        // longest name in the WINDOW, so the descriptions line up without the
        // list jumping as it scrolls.
        let nameW = 0;
        for (let mi = start; mi < start + cap; mi++) {
          const n = (menuKind === 'cmd' ? '/' + menuItems[mi] : menuItems[mi]).length;
          if (n > nameW) nameW = n;
        }
        const descW = Math.max(0, outer - nameW - 10);
        for (let mi = start; mi < start + cap; mi++) {
          // Only the command list carries the slash and a description; a value
          // list and a pick list show their rows as they are.
          const label = menuKind === 'cmd' ? '/' + menuItems[mi] : menuItems[mi];
          let desc = menuKind === 'cmd' ? (SLASH_DESC[menuItems[mi]] || '') : '';
          if (desc.length > descW) desc = descW > 1 ? desc.slice(0, descW - 1) + '…' : '';
          const head = mi === menuSel
            ? '  ' + silver('▸ ') + color(BOLD, label)
            : '    ' + color(DIM, label);
          const gap = ' '.repeat(Math.max(1, nameW - label.length + 2));
          process.stdout.write(fit(pad + head + (desc ? gap + color(DIM, desc) : ''), W - 1) + '\n');
        }
        menuRows = cap;
        if (menuItems.length > cap) {
          const shown = start + cap;
          process.stdout.write(fit(pad + '    ' + color(DIM, menuItems.length - shown > 0
            ? '+' + (menuItems.length - shown) + ' more'
            : '↑ ' + start + ' above'), W - 1) + '\n');
          menuRows += 1;
        }
        lastMenuRows = menuRows;
      } else {
        lastMenuRows = 0;
      }
      // Flush with the panel's own left edge: an extra space reads as a line
      // that has come loose from the box.
      process.stdout.write(fit(pad + meterText(), W - 1));
      lastInputRows = leadRows + drawn.length + 3 + menuRows;
      lastDrawW = W;

      // Put the cursor back on the text row it belongs to. Row 0 is the top
      // border, rows 1..n the text, row n+1 the bottom border, row n+2 the
      // meter, and the write above left the cursor on that last row.
      let cRow, cCol;
      if (cursor === 0) { cRow = 0; cCol = 0; }
      else {
        cRow = cRowAbs - winStart + (above > 0 ? 1 : 0);
        cCol = ((cursor - 1) % textW) + 1;
      }
      let up = drawn.length + 1 + menuRows - cRow;
      const wNow = termWidth();
      if (wNow !== W) {
        // The width changed under this frame: every row written at W now
        // holds ceil(len / wNow) rows, wherever in the frame the change
        // landed, and the caret's row is reached on its first segment.
        const rowsNow = (len) => Math.max(1, Math.ceil(len / wNow));
        const rowW = rowsNow(Math.max(0, W - 2));
        const meterLen = stripAnsi(fit(pad + meterText(), W - 1)).length;
        up = (rowsNow(meterLen) - 1) + menuRows * rowsNow(Math.max(0, W - 1)) + rowW + (drawn.length - 1 - cRow) * rowW + (rowW - 1);
      }
      if (up > 0) process.stdout.write('\x1b[' + up + 'A');
      lastCursorRow = leadRows + cRow + 1;
      lastCursorCol = BOX_MARGIN + 2 + cCol;
      process.stdout.write('\r');
      if (lastCursorCol > 0) process.stdout.write('\x1b[' + lastCursorCol + 'C');
      _clog({ kind: 'frame', W, leadRows, drawn: drawn.length, menuRows, lastCursorRow, lastCursorCol, lead: spinnerLead ? stripAnsi(spinnerLead).slice(0, 24) : null });
    }

    function renderMenu() {
      // Draw N menu rows below the composer, then put the cursor back where
      // the caret was inside the box. The cursor sits on a TEXT row, so it has
      // to walk down past the bottom border first — writing from where it
      // stands would print the menu through the panel.
      if (!menuActive || !menuItems.length) return;
      const toBottom = (lastInputRows - 1) - lastCursorRow;
      if (toBottom > 0) process.stdout.write('\x1b[' + toBottom + 'B');
      process.stdout.write('\r');
      for (const item of menuItems.map((c, i) => {
        return i === menuSel
          ? '    ' + silver('▸ ') + color(BOLD, (menuKind === 'pick' ? '' : '/') + c)
          : '      ' + color(DIM,  (menuKind === 'pick' ? '' : '/') + c);
      })) {
        process.stdout.write('\n' + item);
      }
      lastMenuRows = menuItems.length;
      process.stdout.write('\x1b[' + (lastMenuRows + toBottom) + 'A');
      process.stdout.write('\r');
      if (lastCursorCol > 0) process.stdout.write('\x1b[' + lastCursorCol + 'C');
    }

    // Commands whose argument is a closed set worth choosing from rather than
    // typing. Values mirror the skill's own vocabulary (plugin/skills/engine).
    const ARG_CHOICES = {
      engine: ['auto', 'claude', 'chatgpt', 'local', 'kimi', 'router']
    };

    function recomputeMenu() {
      // A pick list stands on its own: it is not derived from the buffer.
      if (menuActive && menuKind === 'pick') return;
      if (!buffer.startsWith('/')) { menuActive = false; return; }
      const sp = buffer.indexOf(' ');

      // Past the command name: offer that command's values, if it has a set.
      if (sp >= 0) {
        const cmd  = buffer.slice(1, sp);
        const rest = buffer.slice(sp + 1);
        const set  = ARG_CHOICES[cmd];
        if (!set || rest.includes(' ')) { menuActive = false; return; }
        const hits = set.filter((v) => v.startsWith(rest));
        if (!hits.length) { menuActive = false; return; }
        menuItems = hits;
        menuKind  = 'arg';
        if (menuSel >= menuItems.length) menuSel = 0;
        menuActive = true;
        return;
      }

      const head = buffer.slice(1);
      const matches = SLASH_CMDS.filter((c) => c.startsWith(head));
      if (matches.length === 0) { menuActive = false; return; }
      menuItems = matches;
      menuKind  = 'cmd';
      if (menuSel >= menuItems.length) menuSel = 0;
      menuActive = true;
    }

    let resizeSettle = null;
    function redraw() {
      // Piped stdout is a transcript, not a screen: per-keystroke redraws put
      // one "❯ h ❯ he ❯ hel…" per character into logs. The submitted line is
      // printed by submit(); live echo is only for a terminal that can erase.
      if (!process.stdout.isTTY) return;
      if (resizeSettle) return; // the settled redraw paints this frame
      eraseInputAndMenu();
      renderInput();
      // Choices are drawn by renderInput, inside the composer block.
    }
    // A resize reflows the rows the last frame occupied: a row drawn wider
    // than the new width wraps onto more rows, so the erase counts them the
    // way the terminal now holds them, moves to the frame's first row and
    // clears from there. The transcript above is left to the terminal.
    process.stdout.on('resize', () => {
      if (!process.stdout.isTTY || fixedUI) return;
      // A drag delivers many resizes a few milliseconds apart while the
      // terminal is still reflowing; the frame is erased and drawn once,
      // after the last of them, against a settled screen.
      _clog({ kind: 'resize', w: termWidth(), lastDrawW, lastCursorRow });
      if (resizeSettle) clearTimeout(resizeSettle);
      resizeSettle = setTimeout(() => { resizeSettle = null; _clog({ kind: 'settle', w: termWidth() }); redraw(); }, 300);
    });

    function commitSelection() {
      if (!menuActive || !menuItems.length) return;
      if (menuKind === 'arg') {
        // The value completes a command that is already typed: keep the head,
        // replace whatever fragment follows it.
        buffer = buffer.slice(0, buffer.indexOf(' ') + 1) + menuItems[menuSel];
        cursor = buffer.length;
        menuActive = false;
        menuSel = 0;
        return;
      }
      buffer = '/' + menuItems[menuSel];
      // Append a space only when the skill takes args. Skills with no
      // args (help, quit, clear) work fine either way — the space is
      // harmless. Keep it simple: always append.
      buffer += ' ';
      cursor = buffer.length;
      menuActive = false;
      menuSel = 0;
      // Choosing the command may open the next choice straight away: commands
      // with a closed set of values offer them without waiting for a keystroke.
      recomputeMenu();
      redraw();
    }

    // A pick list: rows offered by the program (an MCP server, an action on
    // it), walked with the arrows, taken with Enter, closed with Escape or
    // Ctrl-C. Nothing typed reaches the buffer while it is open.
    let pickItems = [];
    let pickDone  = null;
    function openPick(items, onPick) {
      pickItems  = items.slice();
      pickDone   = onPick;
      menuItems  = pickItems.map((it) => it.label);
      menuKind   = 'pick';
      menuSel    = 0;
      menuActive = true;
      redraw();
    }
    function closePick(chosen) {
      const done = pickDone;
      const it = (chosen && pickItems[menuSel]) || null;
      pickItems = []; pickDone = null;
      menuActive = false; menuKind = 'cmd'; menuItems = []; menuSel = 0;
      if (!chosen) { redraw(); return; }
      eraseInputAndMenu();
      if (done) done(it ? it.value : null);
    }

    function submit() {
      const line = buffer;
      eraseInputAndMenu();
      // Echo the submitted line. Fixed layout: the echo scrolls into the
      // transcript region (pane grammar: faint ❯ + muted text) and the
      // prompt row stays pinned. Fallback: the old inline wrap-echo.
      const w        = termWidth();
      const visibleW = Math.max(1, w - PROMPT_W);
      if (fixedUI) {
        if (line.length > 0) {
          const rows = [];
          for (let i = 0; i < line.length; i += visibleW) {
            rows.push('  ' + userBlock(line.substr(i, visibleW)));
          }
          out('\n' + rows.join('\n') + '\n');
        }
      } else if (line.length === 0) {
        // Nothing to echo. The composer is still on screen and is redrawn
        // below, so printing a lone glyph would leave a stray mark in the
        // transcript for a message that was never sent.
      } else {
        // The operator's line is echoed as a lifted block; the partner's reply
        // stays bare text (pane grammar: terminal output, not chat bubbles).
        // Authorship is carried by this block alone, so only one side is styled.
        // Pasting a file gives the terminal a long absolute path, and a
        // screenshot's path is longer than most messages. The transcript shows
        // it collapsed to its name; the message itself keeps the full path, so
        // anything that can open the file still can.
        // Matched up to the extension rather than to the next space: the paths
        // a Mac hands over are full of them ("Group Containers", "Application
        // Support"), so a whitespace-delimited match would collapse nothing.
        const shown = line.replace(
          /\/[^\n]*?\.(png|jpe?g|gif|webp|heic|pdf|mov|mp4|webm)\b/gi,
          (p) => '…/' + p.replace(/^.*\//, ''));
        const blockW = Math.max(1, visibleW - 4);
        for (let i = 0; i < shown.length; i += blockW) {
          // No glyph. Authorship is carried by colour alone: the operator's
          // line is the lifted block, the partner's is the lighter type below.
          // Marking both sides states the same thing twice.
          process.stdout.write('  ' + userBlock(shown.substr(i, blockW)) + '\n');
        }
      }
      if (line && line !== history[history.length - 1]) history.push(line);
      historyIdx = null;
      buffer = '';
      cursor = 0;
      menuActive = false;
      menuSel = 0;
      lastMenuRows = 0;
      // The composer stays up for the whole turn: it is redrawn empty right
      // after the echo, and the spinner writes into its meter. The panel is
      // never torn down mid-turn.
      if (isTTY) renderInput();
      if (handlers.line) handlers.line(line);
    }

    function onKey(str, key) {
      if (paused) return;
      key = key || {};
      const seq = (key.sequence || str || '');

      // Bracketed paste markers — handled before any other key logic so
      // returns embedded in paste don't accidentally submit.
      if (seq === '\x1b[200~' || seq.indexOf('[200~') >= 0) {
        pasteMode = true; pasteBuf = '';
        return;
      }
      if (seq === '\x1b[201~' || seq.indexOf('[201~') >= 0) {
        pasteMode = false;
        // Flatten internal newlines to spaces for single-line input.
        const flat = pasteBuf.replace(/[\r\n]+/g, ' ');
        buffer = buffer.slice(0, cursor) + flat + buffer.slice(cursor);
        cursor += flat.length;
        pasteBuf = '';
        recomputeMenu();
        redraw();
        return;
      }
      if (pasteMode) {
        // Accumulate everything between the markers, including returns.
        if (str) pasteBuf += str;
        return;
      }

      if (menuActive && menuKind === 'pick') {
        if (key.name === 'up')   { menuSel = (menuSel - 1 + menuItems.length) % menuItems.length; redraw(); return; }
        if (key.name === 'down') { menuSel = (menuSel + 1) % menuItems.length; redraw(); return; }
        if (key.name === 'return' || key.name === 'enter') { closePick(true); return; }
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { closePick(false); return; }
        return;
      }
      // Ctrl-O: the trail shows what each finished tool was on.
      if (key.ctrl && key.name === 'o') { if (handlers.detail) handlers.detail(); return; }
      if (key.ctrl && key.name === 'c') {
        // Delegate to outer scope so it can apply tiered semantics
        // (cancel in-flight first, then clear buffer, then exit-on-double).
        if (handlers.interrupt) { handlers.interrupt(); return; }
        eraseInputAndMenu();
        process.stdout.write('\n');
        if (handlers.close) handlers.close();
        return;
      }
      if (key.ctrl && key.name === 'd' && buffer.length === 0) {
        eraseInputAndMenu();
        process.stdout.write('\n');
        if (handlers.close) handlers.close();
        return;
      }

      // Menu navigation
      if (menuActive && key.name === 'up') {
        menuSel = (menuSel - 1 + menuItems.length) % menuItems.length;
        redraw(); return;
      }
      if (menuActive && key.name === 'down') {
        menuSel = (menuSel + 1) % menuItems.length;
        redraw(); return;
      }
      if (menuActive && key.name === 'tab') {
        commitSelection();
        return;
      }
      // 'return' is \r (the Enter key in raw mode); 'enter' is \n — what a
      // pipe delivers. Accepting only the first meant echo "hi" | troth typed
      // forever and never submitted: scripts and agents drove a REPL that
      // took their keystrokes and answered nothing.
      if (menuActive && (key.name === 'return' || key.name === 'enter')) {
        // Choosing a VALUE is the whole intent — take it and run, so picking an
        // engine costs one key rather than a second confirming Enter.
        if (menuKind === 'arg') { commitSelection(); submit(); return; }
        // If the buffer is already the exact selected command, submit
        // instead of committing (avoids the double-Enter trap for
        // no-args skills like /quit /help /clear).
        const head = buffer.slice(1);
        if (head === menuItems[menuSel]) { submit(); return; }
        commitSelection();
        return;
      }
      if (menuActive && key.name === 'escape') {
        menuActive = false; redraw(); return;
      }
      // With no list open, escape is the stop key. It only ever cancels a turn
      // in flight — unlike Ctrl-C it never arms an exit, so pressing it out of
      // reflex can never close the conversation.
      if (!menuActive && key.name === 'escape') {
        if (handlers.escape) handlers.escape();
        return;
      }

      // History (only when menu not active)
      if (!menuActive && key.name === 'up' && history.length) {
        if (historyIdx === null) historyIdx = history.length;
        historyIdx = Math.max(0, historyIdx - 1);
        buffer = history[historyIdx] || '';
        cursor = buffer.length;
        redraw(); return;
      }
      if (!menuActive && key.name === 'down' && history.length) {
        if (historyIdx === null) return;
        historyIdx++;
        if (historyIdx >= history.length) { historyIdx = null; buffer = ''; }
        else { buffer = history[historyIdx]; }
        cursor = buffer.length;
        redraw(); return;
      }

      if (key.name === 'return' || key.name === 'enter') { submit(); return; }
      if (key.name === 'backspace') {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          recomputeMenu();
          redraw();
        }
        return;
      }
      if (key.name === 'left')  { if (cursor > 0) cursor--; redraw(); return; }
      if (key.name === 'right') { if (cursor < buffer.length) cursor++; redraw(); return; }
      if (key.name === 'home')  { cursor = 0; redraw(); return; }
      if (key.name === 'end')   { cursor = buffer.length; redraw(); return; }

      // Printable character. Filter out unhandled control sequences.
      if (str && str.length === 1 && str >= ' ' && str !== '\x7f') {
        buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
        cursor++;
        recomputeMenu();
        redraw();
      }
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      // Ask the terminal to wrap pastes with bracketed-paste markers.
      // Ghostty / iTerm / WezTerm / tmux all honor this.
      process.stdout.write('\x1b[?2004h');
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', onKey);
    hideComposer = eraseInputAndMenu;
    meterWriter  = drawMeterRow;

    return {
      on(ev, fn) { handlers[ev] = fn; },
      pick(items, onPick) { openPick(items, onPick); },
      prompt() {
        paused = false;
        if (fixedUI) process.stdout.write('\x1b[' + (termRows() - 2) + ';1H\x1b[2K');
        // Erase first: the composer is on screen for the whole turn now, so a
        // bare render would stack a second panel on top of the live one.
        redraw();
      },
      pause()  { paused = true; },
      resume() { paused = false; },
      hide()   { eraseInputAndMenu(); },
      close()  {
        hideComposer = null;
        meterWriter  = null;
        process.stdin.removeListener('keypress', onKey);
        if (process.stdin.isTTY) {
          try { process.stdout.write('\x1b[?2004l'); } catch (_) {}
          try { process.stdin.setRawMode(false); } catch (_) {}
        }
      },
      _write(text) { buffer = text; cursor = text.length; redraw(); },
      getBuffer() { return buffer; },
      clearBuffer() { buffer = ''; cursor = 0; menuActive = false; redraw(); },
      // Put text back where the operator can edit it. Used when a turn is
      // cancelled, so a change of mind does not cost the typing.
      setBuffer(text) {
        buffer = String(text || '');
        cursor = buffer.length;
        menuActive = false;
        redraw();
      }
    };
  }

  statusEngine = (function () { try { return activeModel() || ''; } catch (_) { return ''; } })();
  enableFixedUI();
  const rl = createInput({ prompt: '  ' + silverDim('\u276f ') });

  const spinner = createSpinner();
  const errLog  = openErrLog();
  // Track the most recently resolved slash command so dispatch labels can
  // say "running /think" instead of "running skill". Reset on response.
  let lastSlash = null;
  // A turn in flight owns the working line. A deterministic slash typed while
  // it runs is a side question: the entity answers it at once and the answer
  // is printed beside the work, never taken for the end of the turn. Anything
  // else typed meanwhile waits and is sent when the reply lands.
  let sideSlashes = 0;
  const queuedLines = [];
  // Track per-turn faculty + cumulative tool count for the response trailer.
  let turnFaculty = null;
  let turnTools = 0;
  let turnActions = [];
    const toolStarts = new Map();
  // Ctrl-O: each finished tool's line also shows what it was on.
  let detailMode = false;
  let turnStart = 0;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (errLog) { try { errLog.write(chunk); } catch (_) {} }
    // Only surface lines that look genuinely fatal — silent for the
    // chatter '[router] ...', '[troth cache] ...' etc.
    String(chunk).split('\n').forEach((line) => {
      if (/\b(fatal|EADDR|ENOENT|cannot find module)\b/i.test(line)) {
        spinner.stop();
        out(color(RED, '  ✗ ' + line.trim()) + '\n');
      }
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      // TROTH_FRAME_LOG=<path> records the event stream the surface receives:
      // kind, faculty, provider, model. Off unless the variable is set.
      if (process.env.TROTH_FRAME_LOG) {
        try { require('fs').appendFileSync(process.env.TROTH_FRAME_LOG, JSON.stringify({ k: msg.kind, f: msg.faculty, p: msg.provider, m: msg.model }) + '\n'); } catch (_) {}
      }
      switch (msg.kind) {
        case 'ready':
          ready = true;
          rl.prompt();
          break;
        case 'dialogue_reset':
          spinner.stop();
          out(color(DIM,
            '  session reset · identity preserved (' +
            msg.goals_kept + ' goals, ' + msg.engrams_kept + ' engrams)\n'));
          break;
        case 'slash_resolved':
          if (sideSlashes > 0) break;
          lastSlash = msg.name || null;
          spinner.update(lastSlash ? 'running /' + lastSlash : 'running skill');
          break;
        case 'slash_unmatched':
          // Command-shaped typos are answered by the entity itself; only text
          // that fell open to the model needs the provenance note here.
          if (msg.treated_as === 'plain_text') {
            out(color(DIM, '  /' + (msg.name || '?') + ' is not a command — sent as a message. Commands: /help') + '\n');
          }
          break;
        case 'dispatch': {
          if (sideSlashes > 0 && msg.faculty === 'deterministic') break;
          turnFaculty = msg.faculty || null;
          spinner.update(dispatchVerb(msg.faculty, lastSlash));
          // Reflect the dispatched engine in the composing footer live —
          // including the transport-abort fallback walk, which re-emits
          // dispatch with the alternate faculty mid-turn. router/anthropic
          // resolve to null here; their serving/served events own the label.
          const lbl = facultyLabel(msg.faculty);
          if (lbl) { statusEngine = lbl; drawStatus(); }
          break;
        }
        case 'serving':
        case 'served': {
          // The provider/model ACTUALLY answering right now — feeds the
          // pinned status line (cockpit pane parity).
          // A local server reports the model as the FILE it loaded, absolute
          // path and quant suffix and all. The meter wants the name a person
          // would say, so it is reduced the same way the config-read path
          // reduces it: basename, no extension, no quant tail.
          const raw = String(msg.model || msg.provider || '')
            .replace(/^.*[\/]/, '')
            .replace(/\.gguf$/i, '')
            .replace(/-(UD|MLX|GGUF|Q\d[A-Z0-9_]*).*$/i, '');
          const eng = /^(router|routing|any)$/i.test(raw) ? '' :
            [raw, msg.host ? 'local' : null].filter(Boolean).join(' · ');
          if (eng) { statusEngine = eng; turnModel = eng; drawStatus(); }
          break;
        }
        case 'text_delta':
          // Streamed reply volume — drives the live ~token readout. The
          // full text still prints once on 'response' (no partial paint).
          spinner.stream(String(msg.content || '').length);
          break;
        case 'tool_request': {
          // The tool of the moment rides the working line; when it finishes it
          // leaves one line in the trail and the working line says thinking.
          turnTools++;
          turnActions.push(toolKind(msg.name, msg.args || msg.input));
          {
            const _args = msg.args || msg.input;
            const _verb = toolVerb(msg.name, _args);
            const _detail = toolDetail(msg.name, _args, _verb);
            toolStarts.set(String(msg.id || turnTools), { verb: _verb, detail: _detail, at: Date.now() });
            spinner.update(_verb, _detail);
          }
          break;
        }
        case 'tool_result': {
          const key = String(msg.id || turnTools);
          const started = toolStarts.get(key) || null;
          if (started) toolStarts.delete(key);
          const verb = started ? started.verb : (msg.name ? toolVerb(msg.name, {}) : 'a tool');
          const took = typeof msg.ms === 'number' ? msg.ms : (started ? Date.now() - started.at : 0);
          const why = msg.ok === false ? String(msg.why || 'failed').replace(/_/g, ' ') : null;
          out(color(why ? RED : DIM, '  ◦ ' + pastVerb(verb) + ' · ' + fmtDur(took) + (why ? ' · ' + why : '')) + '\n');
          if (detailMode && started && started.detail) out(color(DIM, '    ' + started.detail) + '\n');
          spinner.update('thinking' + (turnTools ? ' · step ' + turnTools : ''));
          break;
        }
        case 'turn_progress': {
          const mins = Math.round((msg.elapsed_ms || 0) / 60000);
          out(color(DIM, '  ◦ still working · ' + (msg.steps || 0) + ' steps · ' + mins + ' min' + (msg.last_tool ? ' · last: ' + toolVerb(msg.last_tool, {}) : '')) + '\n');
          break;
        }
        case 'response': {
          // A side question's answer lands beside the running work: printed,
          // with the turn's own state left exactly as it was.
          if (sideSlashes > 0 && msg.faculty === 'deterministic') {
            sideSlashes--;
            if (msg.text) for (const segment of renderReply(msg.text).split('\n')) out('  ' + segment + '\n');
            break;
          }
          // A cancelled turn still finishes upstream and its reply still
          // arrives. Dropping the text is right, but the working indicator
          // belongs to that same turn and has to go with it: left running, it
          // keeps working on a message that was never sent.
          if (dropNextResponse) {
            dropNextResponse = false;
            spinner.stop();
            awaitingResponse = false;
            sideSlashes = 0;
            turnModel = null;
            break;
          }
          // Persist the engine that ACTUALLY served this turn: the response
          // carries faculty=choice.faculty, which the fallback walk already
          // reassigned to whoever rescued it — so the footer names the true
          // engine of the LAST completed turn, not the config default. Only
          // on a real reply: an aborted/empty turn (handled below) means no
          // engine served, so its faculty must not become the footer. router
          // resolves to null (serving/served set the real provider), so we
          // never overwrite a good provider name with an internal one.
          const served    = !(!msg.text && (msg.status === 'aborted' || msg.reason));
          const servedLbl = served ? facultyLabel(msg.faculty) : null;
          // The faculty label is the COARSE name of the lane ('ChatGPT sub').
          // A 'served' frame carries the model that actually answered, which is
          // the finer and more useful fact, so the lane name only fills the slot
          // when no model was reported for this turn — otherwise the end of the
          // turn would erase 'gpt-5.5' and put the lane back.
          if (servedLbl && !turnModel) { statusEngine = servedLbl; }
          turnModel = null;
          if (msg.usage && (msg.usage.input_tokens || msg.usage.output_tokens)) {
            sessTokIn  += msg.usage.input_tokens  || 0;
            sessTokOut += msg.usage.output_tokens || 0;
          }
          drawStatus();
          refresh5h();
          spinner.stop();
          if (turnTools > 0) out(color(DIM, '  ◦ ' + turnSummary()) + '\n');
          // Honest empty-reply handling: a turn that aborted (providers
          // exhausted, transport offline) would render as a BLANK reply —
          // the reason survived to this event and was dropped here (journey
          // find. Name the cause and point at the fix.
          if (!msg.text && (msg.status === 'aborted' || msg.reason)) {
            const why = String(msg.reason || msg.status || 'no reply');
            const human = why === 'transport_providers_exhausted'
              ? 'no engine answered — link a subscription or enable a provider (app Settings, or the dashboard at ' + require('../shared-core/dashboard-url.js').dashboardUrl() + ')'
              : (why === 'no_engine_configured' || why === 'transport_no_engine_configured')
              // Not the same as exhausted: nothing was ever set up, so name the
              // one command that fixes it rather than describing the symptom.
              ? 'nothing is configured yet — run `troth setup` to pick an engine and paste your key'
              : why.replace(/^transport_/, '').replace(/_/g, ' ');
            out(color(RED, '  ✗ ' + human) + '\n');
            awaitingResponse = false;
            lastSlash = null; turnFaculty = null; turnTools = 0; turnActions = []; turnStart = 0;
            rl.prompt();
            sideSlashes = 0; flushQueued();
            break;
          }
          if (!fixedUI) out('\n');
          // Chat-style assistant prefix on first line. Subsequent lines
          // align under it for a clean conversational shape. Each
          // newline-delimited line is also word-wrapped to the terminal
          // width with the same indent continuation — otherwise long
          // sentences wrap flush-left and visually detach from the ◇.
          // The reply, set for the terminal: headings, lists, code, tables and
          // inline marks in the partner's tone, wrapped to a reading width.
          for (const segment of renderReply(msg.text).split('\n')) out('  ' + segment + '\n');
          // NOTHING under the reply (operator: stats belong to the live
          // working line only, like Claude Code). tools/tokens/time all
          // showed while the turn ran; the reply stays clean.
          if (!fixedUI) out('\n');
          // flush any autonomous_pursuit briefings that arrived
          // while the user's turn was in flight. They land below the
          // response so reading order is: user → assistant → "↑ by the
          // way I also did X autonomously". Same channel app/voice will
          // subscribe to via the entity stdout protocol.
          while (_pendingBriefings.length) {
            out(_pendingBriefings.shift());
          }
          awaitingResponse = false;
          lastSlash = null; turnFaculty = null; turnTools = 0; turnActions = []; turnStart = 0;
          rl.prompt();
          sideSlashes = 0; flushQueued();
          break;
        }
        case 'error':
        case 'fatal':
          if (dropNextResponse) { dropNextResponse = false; break; }
          spinner.stop();
          out(color(RED, '  ✗ ' + (msg.error || msg.kind)) +
            (msg.detail ? color(DIM, ' — ' + msg.detail) : '') + '\n');
          awaitingResponse = false;
          rl.prompt();
          sideSlashes = 0; flushQueued();
          break;
        case 'worker_event': {
          // surface per-step worker activity from autonomous
          // pursuits. Renders as a dim trail under the user's prompt so
          // they can see the partner's team working in real time.
          let cliInline = true;
          try {
            const l4cfg = (function(){try{return require('../shared-core/l4-config.js')}catch(e){return {isEnabled:()=>false,DEFAULTS:{}}}}());
            cliInline = l4cfg.isEnabled('surfaces.cli_inline');
          } catch (_) {}
          if (!cliInline) break;
          const sym = msg.type === 'worker_started' ? '▸' : '◂';
          const role = msg.worker_role || 'worker';
          const elapsed = msg.elapsed_ms != null ? ' (' + (msg.elapsed_ms / 1000).toFixed(1) + 's)' : '';
          const statusBit = msg.status && msg.status !== 'ok' ? ' [' + msg.status + ']' : '';
          const line = '  ' + color(DIM, sym + ' [' + role + '] ' + msg.step_name + statusBit + elapsed) + '\n';
          if (awaitingResponse) {
            _pendingBriefings.push(line);
          } else {
            out(line);
          }
          break;
        }
        case 'background_notification': {
          // surface autonomous_pursuit briefings as inline
          // interstitials. Other background tasks (state_summary,
          // identity_extract, etc.) stay silent — only the partners
          // autonomous work is user-relevant.
          if (msg.task !== 'autonomous_pursuit') break;
          let cliInline = true;
          try {
            const l4cfg = (function(){try{return require('../shared-core/l4-config.js')}catch(e){return {isEnabled:()=>false,DEFAULTS:{}}}}());
            cliInline = l4cfg.isEnabled('surfaces.cli_inline');
          } catch (_) { /* if config load fails, default to showing — safer than silent */ }
          if (!cliInline) break;
          // Build queue if user is mid-turn or input-buffer is non-empty.
          // For v1 we always render immediately when not awaiting a turn;
          // when awaiting, we queue and flush after the response lands.
          const briefLine = (msg.briefing || (msg.notes && msg.notes[0]) || '').split('\n')[0] || '';
          if (!briefLine) break;
          const interstitial =
            '\n' + color(DIM, '  ↑ ') + silverDim('[autonomous]') + ' ' + briefLine + '\n';
          if (awaitingResponse) {
            // Queue for after the current response so it doesn't interleave
            // with streaming output.
            _pendingBriefings.push(interstitial);
          } else {
            out(interstitial);
            rl.prompt();
          }
          break;
        }
        default:
          // ignore other background events (state_summary, identity_extract,
          // hypothesis_recorded, etc.) — they're substrate housekeeping
          // not user-facing work.
      }
    }
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(color(RED, '\ntroth-entity exited (code=' + code + ', signal=' + signal + ')'));
    }
    rl.close();
    process.exit(0);
  });

  // Ctrl-C tiered semantics, claude-cli-style:
  //   in-flight request      → cancel + return to prompt
  //   non-empty buffer       → clear buffer
  //   empty buffer (1st hit) → arm exit, print hint
  //   empty buffer (2nd hit) → exit
  let ctrlcArmed = false;
  let ctrlcTimer = null;
  // One cancel path, two keys onto it. Escape reaches only this; Ctrl-C reaches
  // it first and then falls through to its own buffer/exit tiers.
  function cancelInFlight() {
    if (!awaitingResponse) return false;
    spinner.stop();
    awaitingResponse = false;
    // The daemon runs the turn, so the daemon is told to stop it: the same
    // control frame the app's Stop sends. Its stream is cut and the loop
    // ends at its next check; a tool already running finishes its own
    // command and nothing new starts. Without this frame the surface only
    // looked stopped while the work went on underneath.
    try { child.stdin.write(JSON.stringify({ type: 'control', op: 'cancel_turn', conversation_id: CONV_ID }) + '\n'); } catch (_) {}
    // The aborted reply that follows is discarded when it arrives.
    dropNextResponse = true;
    out('\n' + color(DIM, '  ◦ ' + (turnTools > 0 ? turnSummary() + ' · ' : '') + 'stopped') + '\n\n');
    lastSlash = null; turnFaculty = null; turnTools = 0; turnActions = []; turnStart = 0;
    sideSlashes = 0;
    // A stop also drops what was waiting behind the turn, and says so.
    while (queuedLines.length) out(color(DIM, '  ◦ dropped the queued message: ' + queuedLines.shift().slice(0, 80)) + '\n');
    // The words go back into the composer so a cancel does not cost the typing.
    if (inFlightText && rl.setBuffer) rl.setBuffer(inFlightText);
    else rl.prompt();
    inFlightText = '';
    return true;
  }
  /** One line for the whole turn: how many tools ran and for how long. */
  function turnSummary() {
    const secs = turnStart ? Math.round((Date.now() - turnStart) / 1000) : 0;
    const n = {};
    for (const k of (turnActions || [])) n[k] = (n[k] || 0) + 1;
    const count = (c, one, many) => c === 1 ? one : c + ' ' + many;
    const times = (c) => c === 1 ? '' : c === 2 ? ' twice' : ' ' + c + ' times';
    const parts = [];
    if (n.read) parts.push('read ' + count(n.read, '1 file', 'files'));
    if (n.search) parts.push('searched' + times(n.search));
    if (n.web) parts.push('fetched ' + count(n.web, '1 page', 'pages'));
    if (n.edit) parts.push('edited ' + count(n.edit, '1 file', 'files'));
    if (n.write) parts.push('wrote ' + count(n.write, '1 file', 'files'));
    if (n.run) parts.push('ran ' + count(n.run, '1 command', 'commands'));
    if (n.delegate) parts.push('delegated ' + count(n.delegate, '1 task', 'tasks'));
    if (n.skill) parts.push('ran ' + count(n.skill, '1 skill', 'skills'));
    if (n.draw) parts.push('drew ' + count(n.draw, '1 image', 'images'));
    if (n.render) parts.push('rendered ' + count(n.render, '1 clip', 'clips'));
    if (n.recall) parts.push('recalled');
    if (n.remember) parts.push('remembered');
    if (n.other) parts.push(count(n.other, '1 more action', 'more actions'));
    if (n.job) parts.push('followed ' + count(n.job, '1 job', 'jobs'));
    const what = parts.length ? parts.join(', ') : turnTools + (turnTools === 1 ? ' tool' : ' tools');
    return what + (secs ? ' · ' + secs + 's' : '');
  }
  rl.on('escape', () => { cancelInFlight(); });
  rl.on('detail', () => {
    detailMode = !detailMode;
    out(color(DIM, '  ◦ details ' + (detailMode ? 'on: each finished tool also shows what it was on' : 'off')) + '\n');
    rl.prompt();
  });
  rl.on('interrupt', () => {
    if (cancelInFlight()) return;
    if (rl.getBuffer().length > 0) {
      rl.clearBuffer();
      return;
    }
    if (ctrlcArmed) {
      try { child.stdin.end(); } catch (_) {}
      try { child.kill('SIGTERM'); } catch (_) {}
      rl.close();
      process.exit(0);
    }
    ctrlcArmed = true;
    out('\n' + color(DIM, '  (Ctrl-C again to exit)') + '\n');
    rl.prompt();
    if (ctrlcTimer) clearTimeout(ctrlcTimer);
    ctrlcTimer = setTimeout(() => { ctrlcArmed = false; ctrlcTimer = null; }, 1500);
  });

  // Cancelled-turn guard: when user Ctrl-Cs an in-flight request, drop
  // the response/error events that arrive after the cancel so the chat
  // surface doesn't dump a stale answer below a fresh prompt. Cleared
  // on the next submit.
  let dropNextResponse = false;
  // The text of the turn in flight, so a cancel can return it to the composer.
  let inFlightText = '';

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }
    // Bare '/' opens the skill picker inline — equivalent to /help with
    // a tighter visual that says "pick one to continue".
    if (line === '/') {
      console.log('');
      console.log(color(BOLD, '  Slash commands') + color(DIM, '  (Tab autocompletes)'));
      const cells = SLASH_CMDS.map((c) => silver('/' + c));
      console.log('    ' + cells.join(color(DIM, '   ')));
      console.log('');
      rl.prompt();
      return;
    }
    if (line === '/quit' || line === '/exit') {
      try { child.stdin.end(); } catch (_) {}
      try { child.kill('SIGTERM'); } catch (_) {}
      rl.close();
      return;
    }
    if (line === '/help') {
      const row = (slash, desc) => '    ' +
        silver(slash.padEnd(11)) +
        color(DIM, desc);
      console.log('');
      console.log(color(BOLD, '  Bundled skills'));
      console.log(row('/goal',     'set or surface the current task'));
      console.log(row('/remember', 'commit a fact to substrate'));
      console.log(row('/recall',   'semantic recall from substrate'));
      console.log(row('/forget',   'remove an engram'));
      console.log(row('/think',    'structured reasoning, persisted'));
      console.log(row('/agents',   'spawn sub-agent orchestration'));
      console.log(row('/save',     'persist key facts before window cut'));
      console.log(row('/context',  'inspect mounted substrate this turn'));
      console.log(row('/usage',    'provider chain status'));
      console.log(row('/dialogue-reset', 'reset session (substrate intact)'));
      console.log(row('/init',     'seed project anchors'));
      console.log('');
      console.log(color(BOLD, '  Built-ins'));
      console.log(row('/help',     'this list'));
      console.log(row('/quit',     'exit (substrate persisted)'));
      console.log('');
      console.log(color(BOLD, '  Custom'));
      console.log(color(DIM, '    drop a SKILL.md in .claude/skills/<name>/ or ~/.claude/skills/'));
      console.log('');
      console.log(color(BOLD, '  Anything else'));
      console.log(color(DIM, '    → agentic loop (tools, substrate, identity envelope)'));
      console.log('');
      rl.prompt();
      return;
    }
    if (!ready) {
      out(color(DIM, '  entity warming up · queuing\n'));
    }
    // /mcps is answered here, without the entity: it works while a turn runs
    // and never touches that turn.
    if (/^\/mcps(\s|$)/.test(line)) { openMcpPicker(); return; }
    if (awaitingResponse) {
      const name = line.startsWith('/') ? line.slice(1).split(/\s+/)[0] : null;
      if (name && SLASH_DET.has(name)) { sideSlashes++; sendEvent(line); return; }
      queuedLines.push(line);
      out(color(DIM, '  ◦ queued · sends when the running turn ends') + '\n');
      rl.prompt();
      return;
    }
    sendTurn(line);
  });
  function sendEvent(line) {
    const event = {
      type: 'user_input',
      input: { text: line },
      parent_id: null,
      options: { agentic: AGENTIC, auto_write: AUTO_WRITE, conversation_id: CONV_ID }
    };
    try { child.stdin.write(JSON.stringify(event) + '\n'); return true; }
    catch (e) {
      console.log(color(RED, '  ! write failed: ' + e.message));
      return false;
    }
  }
  function sendTurn(line) {
    awaitingResponse = true;
    // Held so a cancel can return the words to the composer.
    inFlightText = String(line || '');
    turnStart = Date.now();
    dropNextResponse = false;
    ctrlcArmed = false;
    if (ctrlcTimer) { clearTimeout(ctrlcTimer); ctrlcTimer = null; }
    spinner.start();
    if (!sendEvent(line)) { awaitingResponse = false; spinner.stop(); rl.prompt(); }
  }
  // The next waiting line goes out once the reply has landed.
  function flushQueued() {
    if (awaitingResponse || !queuedLines.length) return;
    const next = queuedLines.shift();
    out(color(DIM, '  ◦ sending the queued message') + '\n');
    sendTurn(next);
  }

  // /mcps: the partner's external hands as a list to act on. Rows come from
  // the dashboard's registry over HTTP; a pick opens the actions on that
  // server (check, switch off or on, remove) and each action prints one line.
  function mcpApi(method, route, body) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(route, require('../shared-core/dashboard-url.js').proxyBaseUrl()); } catch (e) { reject(e); return; }
      const mod = u.protocol === 'https:' ? require('https') : require('http');
      const payload = body ? JSON.stringify(body) : null;
      const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
      const req = mod.request(u, { method, timeout: 20000, headers }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; if (b.length > 1024 * 1024) req.destroy(new Error('reply too large')); });
        res.on('end', () => {
          let json = null;
          try { json = b ? JSON.parse(b) : null; } catch (_) { json = null; }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  function mcpRowLabel(s) {
    return s.name + '  ' + s.scope + (s.project ? ' · ' + s.project : '') + ' · ' + s.transport +
      (s.disabled ? ' · off' : '') + (s.note ? ' · ' + s.note : '');
  }
  function openMcpPicker() {
    mcpApi('GET', '/api/mcp/servers').then(({ status, json }) => {
      if (status !== 200 || !json) throw new Error('status ' + status);
      const active = json.active || [];
      const pending = json.pending || [];
      if (!active.length && !pending.length) {
        out('\n' + color(DIM, '  ◦ no MCP servers yet · stage one in the dashboard, Settings > Integrations') + '\n\n');
        rl.prompt(); return;
      }
      const items = active.map((s) => ({ label: mcpRowLabel(s), value: s }));
      for (const p of pending) items.push({ label: p.name + '  staged · approve it in the dashboard, Settings > Integrations', value: null });
      rl.pick(items, (s) => { if (!s) { rl.prompt(); return; } openMcpActions(s); });
    }).catch((e) => {
      out('\n' + color(RED, '  ✗ the dashboard did not answer (' + e.message + ') · is the proxy running?') + '\n\n');
      rl.prompt();
    });
  }
  function openMcpActions(s) {
    const items = [
      { label: 'Check ' + s.name, value: 'probe' },
      { label: (s.disabled ? 'Switch on ' : 'Switch off ') + s.name, value: 'toggle' },
      { label: 'Remove ' + s.name, value: 'remove' },
      { label: 'Back', value: 'back' }
    ];
    rl.pick(items, (act) => {
      if (!act || act === 'back') { openMcpPicker(); return; }
      if (act === 'remove') {
        rl.pick([{ label: 'Yes, remove ' + s.name, value: true }, { label: 'No, keep it', value: false }], (yes) => {
          if (!yes) { openMcpActions(s); return; }
          mcpAct('/api/mcp/remove', { name: s.name }, s.name + ' removed');
        });
        return;
      }
      if (act === 'toggle') {
        mcpAct('/api/mcp/enable', { name: s.name, enabled: !!s.disabled }, s.name + (s.disabled ? ' switched on' : ' switched off'));
        return;
      }
      // Set off like a reply: a blank line before the check and after its result.
      out('\n' + color(DIM, '  ◦ checking ' + s.name + '…') + '\n');
      mcpApi('POST', '/api/mcp/probe', { name: s.name }).then(({ json }) => {
        const r = json || {};
        const said = r.state === 'connected' ? s.name + ' · connected · ' + ((r.tools || []).length) + ' tools'
          : r.state === 'sign_in_needed' ? s.name + ' · sign-in needed' + (r.url ? ' · ' + r.url : '')
          : s.name + ' · ' + (r.state || 'unreachable') + (r.error ? ' · ' + r.error : '');
        out(color(r.state === 'connected' ? DIM : RED, '  ◦ ' + said) + '\n\n');
        rl.prompt();
      }).catch((e) => { out(color(RED, '  ✗ ' + s.name + ' · ' + e.message) + '\n\n'); rl.prompt(); });
    });
  }
  function mcpAct(route, body, said) {
    mcpApi('POST', route, body).then(({ status, json }) => {
      if (status === 200) out('\n' + color(DIM, '  ◦ ' + said) + '\n\n');
      else out('\n' + color(RED, '  ✗ ' + ((json && (json.reason || json.error)) || ('status ' + status))) + '\n\n');
      rl.prompt();
    }).catch((e) => { out(color(RED, '  ✗ ' + e.message) + '\n'); rl.prompt(); });
  }

  rl.on('close', () => {
    try { child.stdin.end(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
  });

  process.on('SIGINT',  () => rl.close());
  process.on('SIGTERM', () => rl.close());
}

if (require.main === module) start();
module.exports = { start };
