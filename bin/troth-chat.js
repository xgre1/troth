#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// troth chat — interactive REPL backed by the troth-entity daemon.
//
// One long-lived child process per chat session. Each line of user input
// becomes a `user_input` event on the entity's stdin; each response event
// from stdout renders here. Slash commands work natively because the entity
// intercepts them at its own input boundary (see Phase 3 wiring).
//
// Exit:
//   /quit, /exit         clean shutdown
//   Ctrl-D / Ctrl-C      forwards SIGTERM, then exits
//
// This is the human-facing twin of the voice path: same entity, same tools,
// same substrate. Plain stdin/stdout — no Tauri, no UI dep.

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
// Session-total REAL tokens (provider-reported usage per turn). Shown on
// the status line — stats never sit under a reply.
let sessTokIn = 0, sessTokOut = 0;
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
function out(s) {
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
    ? color(DIM, '\u2191' + fmtTok(sessTokIn) + ' \u2193' + fmtTok(sessTokOut) + ' tokens')
    : '';
  const line = (eng || tot)
    ? '  ' + [eng ? silverDim(eng) : null, tot || null].filter(Boolean).join(color(DIM, '  \u00b7  '))
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

function banner() {
  const model = activeModel();
  console.log('');
  if (isTTY) {
    WORDMARK.forEach((row, i) => console.log('  ' + steelRow(row, i / (WORDMARK.length - 1))));
  }
  console.log('');
  // The mini banner the operator said reads cleanly — keep it directly
  // below the ASCII art so the eye lands on logo, then identity, then
  // model.
  const glyph = isTTY ? (steelCode(0.1) + '◈' + RESET) : '◈';
  const mark  = gradient('troth');
  console.log('  ' + glyph + '  ' + mark);
  if (model) console.log('      ' + color(DIM, model));
  console.log('');
}

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

// Light markdown for assistant output. Bold, inline code, fenced code blocks
// with a tinted background. Keep it simple — no full parser, no deps.
function renderMarkdown(text) {
  if (!isTTY) return text;
  let out = text.replace(/```([\s\S]*?)```/g, (_, body) => {
    const lines = body.replace(/^\n|\n$/g, '').split('\n');
    const w = Math.min(80, lines.reduce((m, l) => Math.max(m, l.length), 0));
    const rule = color(DIM, '┄'.repeat(Math.min(w + 2, 80)));
    return '\n' + rule + '\n' +
           lines.map((l) => silver('  ' + l)).join('\n') +
           '\n' + rule + '\n';
  });
  out = out.replace(/`([^`\n]+?)`/g, (_, m) => silver(m));
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (_, m) => color(BOLD, m));
  return out;
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
    case 'claude_cli':   return 'Claude subscription';
    case 'codex_oauth':  return 'ChatGPT subscription';
    case 'llamacpp':
    case 'ollama':
    case 'local':        return activeModel() || 'on this mac';
    default:             return null; // router/anthropic/echo/noop → defer to serving/served
  }
}
function toolVerb(name, args) {
  const a = args || {};
  switch (name) {
    case 'cached_read':
    case 'hashline_read':
      return a.file_path ? 'reading ' + basename(a.file_path) : 'reading';
    case 'cached_grep':    return a.pattern ? 'searching "' + String(a.pattern).slice(0, 24) + '"' : 'searching';
    case 'glob':           return 'matching files';
    case 'engram_record':  return 'remembering';
    case 'engram_search':  return 'recalling';
    case 'hashline_edit':  return a.file_path ? 'editing ' + basename(a.file_path) : 'editing';
    case 'bash':           return 'running shell';
    case 'mcp_call':       return a.server ? 'calling MCP ' + a.server : 'calling MCP';
    case 'mcp_list':
    case 'mcp_describe':   return 'inspecting MCP';
  }
  if (name && name.startsWith('mcp__')) return 'calling MCP';
  return 'using ' + (name || 'tool');
}

const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0);

// Rotating thought-words while the brain works (same idea as the app's
// whimsy pill) — the label breathes instead of a frozen 'thinking'.
const THINK_WORDS = ['thinking', 'reasoning', 'weighing', 'connecting', 'shaping', 'sifting', 'composing'];

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function createSpinner() {
  let i = 0, label = null, timer = null, active = false, startedAt = 0;
  let streamedChars = 0, wordSeed = 0;
  const draw = () => {
    if (!isTTY) return;
    const frame = SPINNER_FRAMES[i = (i + 1) % SPINNER_FRAMES.length];
    const elapsedMs = Date.now() - startedAt;
    const elapsedStr = (elapsedMs / 1000).toFixed(elapsedMs < 10000 ? 1 : 0) + 's';
    // Idle label breathes: a thought-word that rotates every ~2.4s AND
    // pulses along the steel ramp (like the reference spinner's color
    // pulse — ours stays silver, never a hue). Tool verbs stay steady.
    const word = THINK_WORDS[(wordSeed + Math.floor(elapsedMs / 2400)) % THINK_WORDS.length];
    const pulseT = 0.12 + 0.45 * (0.5 + 0.5 * Math.sin(elapsedMs / 550));
    const wordLit = isTTY ? (BOLD + steelCode(pulseT) + word + '\u2026' + RESET) : word + '\u2026';
    // Live volume from streamed deltas — approximate by construction
    // (chars/4), marked '~'; the trailer prints the provider's REAL
    // counts when they exist.
    const tok = streamedChars > 0 ? '\u2193 ~' + fmtTok(Math.round(streamedChars / 4)) + ' tokens' : null;
    const meta = color(DIM, ' (' + [elapsedStr, tok].filter(Boolean).join(' \u00b7 ') + ')');
    const text = (label ? label : wordLit) + meta;
    if (fixedUI) {
      process.stdout.write('\x1b7\x1b[' + (termRows() - 4) + ';1H\x1b[2K  ' +
        silverDim(frame) + ' ' + text + '\x1b8');
      return;
    }
    process.stdout.write('\r  ' + silverDim(frame) + ' ' + text + '\x1b[K');
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
      timer = setInterval(draw, 90);
    },
    stream(nChars) {
      if (!active) return;
      streamedChars += Math.max(0, nChars | 0);
    },
    update(next) {
      if (!active) return;
      label = next;
      draw();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      active = false;
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
  // bundle) used to either crash with a raw unhandled 'error' stack or sit
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
  banner();
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
  // The picker offers what the entity actually serves — read from the same
  // registry /help prints. A hand-kept copy here drifted to 15 while the
  // registry had grown to 18, so /engine existed everywhere except in the
  // picker that people learn the commands from.
  const SLASH_CMDS = (function () {
    try {
      const rows = require('../shared-core/slash/loader.js').skillSummaries(process.cwd()) || [];
      const names = rows.map(function (r) { return r && r.name; }).filter(Boolean);
      if (names.length) { names.push('quit'); return names.sort(); }
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
    const handlers   = { line: null, close: null };
    let buffer       = '';
    let cursor       = 0;
    let menuActive   = false;
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
    function termWidth() { return process.stdout.columns || 80; }

    function eraseInputAndMenu() {
      // Cursor is somewhere on the input area (set by the previous render
      // to either the end of the buffer or the cursor position within a
      // wrapped buffer). Move up to the first input row, then clear from
      // there to end of screen — wipes wrapped input rows AND any menu
      // rows in a single sweep.
      if (lastInputRows > 1) {
        // The previous render left cursor on some row of the input area.
        // We want to be at the FIRST input row. Walk up by (lastInputRows-1).
        // Worst case the cursor was at the end of the last row; this still
        // lands on or above the first row.
        process.stdout.write('\x1b[' + (lastInputRows - 1) + 'A');
      }
      process.stdout.write('\r\x1b[J');
      lastInputRows = 0;
      lastMenuRows = 0;
      if (fixedUI) drawStatus(); // \x1b[J above just wiped the status row
    }

    function renderInput() {
      // Manual word-wrap: emit PROMPT at the start of every visual row so
      // the green bar stays in the gutter even when the buffer wraps.
      // Terminal-driven wrap would put row 2+ flush-left with no prompt
      // mark, which reads as orphaned text rather than continued input.
      const w        = termWidth();
      const visibleW = Math.max(1, w - PROMPT_W);
      if (buffer.length === 0) {
        process.stdout.write(PROMPT);
        lastInputRows = 1;
      } else {
        let rowIdx = 0;
        for (let i = 0; i < buffer.length; i += visibleW) {
          if (rowIdx > 0) process.stdout.write('\n');
          process.stdout.write(PROMPT + buffer.substr(i, visibleW));
          rowIdx++;
        }
        lastInputRows = rowIdx;
      }
      // Position the cursor. After the loop above the cursor sits at the
      // end of the last rendered row; if the logical cursor is earlier,
      // walk back. Edge case: when cursor lands exactly on a row boundary
      // (cursor === N * visibleW, N > 0) we keep it at the END of the
      // previous row rather than the START of the next — matches what
      // users expect when the cursor is "after the last char".
      let cRow, cCol;
      if (cursor === 0) { cRow = 0; cCol = 0; }
      else {
        cRow = Math.floor((cursor - 1) / visibleW);
        cCol = ((cursor - 1) % visibleW) + 1;
      }
      const endRow = lastInputRows - 1;
      const rowsUp = endRow - cRow;
      if (rowsUp > 0) process.stdout.write('\x1b[' + rowsUp + 'A');
      process.stdout.write('\r');
      const absCol = PROMPT_W + cCol;
      if (absCol > 0) process.stdout.write('\x1b[' + absCol + 'C');
    }

    function renderMenu() {
      // Draw N menu rows below the input then move cursor back up onto
      // the input line at its previous position. Caller is expected to
      // have already erased any previous menu via eraseInputAndMenu().
      if (!menuActive || !menuItems.length) return;
      // Snapshot current cursor column on input line.
      const inputCol = PROMPT_W + cursor;
      for (const item of menuItems.map((c, i) => {
        return i === menuSel
          ? '  ' + silver('▶ ') + color(BOLD, '/' + c)
          : '    ' + color(DIM,  '/' + c);
      })) {
        process.stdout.write('\n' + item);
      }
      lastMenuRows = menuItems.length;
      // Cursor is now at the end of the last menu row. Move back up to
      // the input line, then place it at the right column.
      process.stdout.write('\x1b[' + lastMenuRows + 'A');
      process.stdout.write('\r');
      if (inputCol > 0) process.stdout.write('\x1b[' + inputCol + 'C');
    }

    function recomputeMenu() {
      // Open the menu only when the buffer starts with '/' and the
      // user hasn't yet typed a space (which means they've moved past
      // the command name into args).
      const wantsMenu = buffer.startsWith('/') && !buffer.includes(' ');
      if (!wantsMenu) {
        if (menuActive) { menuActive = false; }
        return;
      }
      const head = buffer.slice(1);
      const matches = SLASH_CMDS.filter((c) => c.startsWith(head));
      if (matches.length === 0) {
        if (menuActive) { menuActive = false; }
        return;
      }
      menuItems = matches;
      if (menuSel >= menuItems.length) menuSel = 0;
      menuActive = true;
    }

    function redraw() {
      // Piped stdout is a transcript, not a screen: per-keystroke redraws put
      // one "❯ h ❯ he ❯ hel…" per character into logs. The submitted line is
      // printed by submit(); live echo is only for a terminal that can erase.
      if (!process.stdout.isTTY) return;
      eraseInputAndMenu();
      renderInput();
      renderMenu();
    }

    function commitSelection() {
      if (!menuActive || !menuItems.length) return;
      buffer = '/' + menuItems[menuSel];
      // Append a space only when the skill takes args. Skills with no
      // args (help, quit, clear) work fine either way — the space is
      // harmless. Keep it simple: always append.
      buffer += ' ';
      cursor = buffer.length;
      menuActive = false;
      menuSel = 0;
      redraw();
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
        process.stdout.write(PROMPT + '\n');
      } else {
        for (let i = 0; i < line.length; i += visibleW) {
          process.stdout.write(PROMPT + line.substr(i, visibleW) + '\n');
        }
      }
      if (line && line !== history[history.length - 1]) history.push(line);
      historyIdx = null;
      buffer = '';
      cursor = 0;
      menuActive = false;
      menuSel = 0;
      lastMenuRows = 0;
      if (fixedUI) redraw(); // pinned row: show the bare ❯ again immediately
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

    return {
      on(ev, fn) { handlers[ev] = fn; },
      prompt() {
        paused = false;
        if (fixedUI) process.stdout.write('\x1b[' + (termRows() - 2) + ';1H\x1b[2K');
        renderInput();
      },
      pause()  { paused = true; },
      resume() { paused = false; },
      close()  {
        process.stdin.removeListener('keypress', onKey);
        if (process.stdin.isTTY) {
          try { process.stdout.write('\x1b[?2004l'); } catch (_) {}
          try { process.stdin.setRawMode(false); } catch (_) {}
        }
      },
      _write(text) { buffer = text; cursor = text.length; redraw(); },
      getBuffer() { return buffer; },
      clearBuffer() { buffer = ''; cursor = 0; menuActive = false; redraw(); }
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
  // Track per-turn faculty + cumulative tool count for the response trailer.
  let turnFaculty = null;
  let turnTools = 0;
  let turnStart = 0;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (errLog) { try { errLog.write(chunk); } catch (_) {} }
    // Only surface lines that look genuinely fatal — silent for the
    // chatter '[router] ...', '[troth cache] ...' etc.
    String(chunk).split('\n').forEach((line) => {
      if (/\b(fatal|EADDR|ENOENT|cannot find module)\b/i.test(line)) {
        spinner.stop();
        process.stdout.write(color(RED, '  ✗ ' + line.trim()) + '\n');
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
      switch (msg.kind) {
        case 'ready':
          ready = true;
          rl.prompt();
          break;
        case 'dialogue_reset':
          spinner.stop();
          process.stdout.write(color(DIM,
            '  session reset · identity preserved (' +
            msg.goals_kept + ' goals, ' + msg.engrams_kept + ' engrams)\n'));
          break;
        case 'slash_resolved':
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
          const raw = msg.model || msg.provider || '';
          const eng = /^(router|routing|any)$/i.test(raw) ? '' :
            [raw, msg.host ? 'local' : null].filter(Boolean).join(' · ');
          if (eng) { statusEngine = eng; drawStatus(); }
          break;
        }
        case 'text_delta':
          // Streamed reply volume — drives the live ~token readout. The
          // full text still prints once on 'response' (no partial paint).
          spinner.stream(String(msg.content || '').length);
          break;
        case 'tool_request':
          turnTools++;
          spinner.update(toolVerb(msg.name, msg.args || msg.input));
          break;
        case 'response': {
          if (dropNextResponse) { dropNextResponse = false; break; }
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
          if (servedLbl) { statusEngine = servedLbl; }
          if (msg.usage && (msg.usage.input_tokens || msg.usage.output_tokens)) {
            sessTokIn  += msg.usage.input_tokens  || 0;
            sessTokOut += msg.usage.output_tokens || 0;
          }
          drawStatus();
          spinner.stop();
          // Honest empty-reply handling: a turn that aborted (providers
          // exhausted, transport offline) used to render as a BLANK reply —
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
            lastSlash = null; turnFaculty = null; turnTools = 0; turnStart = 0;
            rl.prompt();
            break;
          }
          if (!fixedUI) out('\n');
          // Chat-style assistant prefix on first line. Subsequent lines
          // align under it for a clean conversational shape. Each
          // newline-delimited line is also word-wrapped to the terminal
          // width with the same indent continuation — otherwise long
          // sentences wrap flush-left and visually detach from the ◇.
          const body = renderMarkdown(msg.text || '');
          const lines = body.split('\n');
          const cols  = process.stdout.columns || 80;
          const wrapW = Math.max(20, cols - 4);
          const wrapVisible = (text) => {
            // Naive wrap on whitespace; preserves ANSI escapes since they
            // don't add to visible length (we still split on simple length
            // which over-counts but is acceptable for this UX pass).
            if (!text) return [''];
            const out = [];
            let rest = text;
            while (rest.length > wrapW) {
              let cut = rest.lastIndexOf(' ', wrapW);
              if (cut < wrapW * 0.5) cut = wrapW; // long token — hard break
              out.push(rest.slice(0, cut));
              rest = rest.slice(cut).replace(/^ +/, '');
            }
            out.push(rest);
            return out;
          };
          const wrapped0 = wrapVisible(lines[0] || '');
          // The cockpit-pane thread grammar (styles.css 'terminal output,
          // not chat bubbles'), which the CLI must mirror exactly: the
          // USER line carries the faint ❯ prompt glyph, the partner's
          // output is BARE text — no bullet, no rail, no bubble shape.
          out('  ' + wrapped0[0] + '\n');
          for (let j = 1; j < wrapped0.length; j++) {
            out('  ' + wrapped0[j] + '\n');
          }
          for (let i = 1; i < lines.length; i++) {
            const w = wrapVisible(lines[i]);
            for (const segment of w) {
              out('  ' + segment + '\n');
            }
          }
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
          lastSlash = null; turnFaculty = null; turnTools = 0; turnStart = 0;
          rl.prompt();
          break;
        }
        case 'error':
        case 'fatal':
          if (dropNextResponse) { dropNextResponse = false; break; }
          spinner.stop();
          process.stdout.write(color(RED, '  ✗ ' + (msg.error || msg.kind)) +
            (msg.detail ? color(DIM, ' — ' + msg.detail) : '') + '\n');
          awaitingResponse = false;
          rl.prompt();
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
            process.stdout.write(line);
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
            process.stdout.write(interstitial);
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
  rl.on('interrupt', () => {
    if (awaitingResponse) {
      spinner.stop();
      awaitingResponse = false;
      // Soft cancel: discard whatever response eventually comes back.
      dropNextResponse = true;
      lastSlash = null; turnFaculty = null; turnTools = 0; turnStart = 0;
      process.stdout.write('\n' + color(DIM, '  cancelled') + '\n\n');
      rl.prompt();
      return;
    }
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
    process.stdout.write('\n' + color(DIM, '  (Ctrl-C again to exit)') + '\n');
    rl.prompt();
    if (ctrlcTimer) clearTimeout(ctrlcTimer);
    ctrlcTimer = setTimeout(() => { ctrlcArmed = false; ctrlcTimer = null; }, 1500);
  });

  // Cancelled-turn guard: when user Ctrl-Cs an in-flight request, drop
  // the response/error events that arrive after the cancel so the chat
  // surface doesn't dump a stale answer below a fresh prompt. Cleared
  // on the next submit.
  let dropNextResponse = false;

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
    awaitingResponse = true;
    turnStart = Date.now();
    dropNextResponse = false;
    ctrlcArmed = false;
    if (ctrlcTimer) { clearTimeout(ctrlcTimer); ctrlcTimer = null; }
    spinner.start();
    const event = {
      type: 'user_input',
      input: { text: line },
      parent_id: null,
      options: { agentic: AGENTIC, auto_write: AUTO_WRITE }
    };
    try { child.stdin.write(JSON.stringify(event) + '\n'); }
    catch (e) {
      console.log(color(RED, '  ! write failed: ' + e.message));
      awaitingResponse = false;
      rl.prompt();
    }
  });

  rl.on('close', () => {
    try { child.stdin.end(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
  });

  process.on('SIGINT',  () => rl.close());
  process.on('SIGTERM', () => rl.close());
}

if (require.main === module) start();
module.exports = { start };
