// SPDX-License-Identifier: AGPL-3.0-only
// Hook-native injector — lightweight cousin of proxy/modules/injector.js.
//
// The proxy's injector scans the full message history. A UserPromptSubmit
// hook sees only the new user prompt, so this module reads project type
// from the filesystem and mode from the prompt itself, then returns a
// compact additionalContext block (≤500 tokens) describing the situation
// to the model so it doesn't waste turns re-discovering obvious facts.
//
// Research pattern: "lazy-load instructions into additionalContext based
// on detected keywords" — DataCamp Claude Code Best Practices 2026.
// Benchmarked at ~15K tokens saved per session vs. stuffing everything
// into CLAUDE.md.

const fs = require('fs');
const path = require('path');

// ── Project type detection from filesystem ─────────────────────────────
function detectProject(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { type: 'unknown', hints: [] };

  const hints = [];
  const exists = (p) => { try { return fs.existsSync(path.join(cwd, p)); } catch (e) { return false; } };
  const readMaybe = (p) => { try { return fs.readFileSync(path.join(cwd, p), 'utf8'); } catch (e) { return null; } };

  // Walk up to 3 levels so a hook fired from a subdirectory still finds
  // the project root.
  let dir = cwd;
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const in_ = (p) => fs.existsSync(path.join(dir, p));
  const readIn = (p) => { try { return fs.readFileSync(path.join(dir, p), 'utf8'); } catch (e) { return null; } };

  if (in_('package.json')) {
    const pkg = readIn('package.json') || '';
    hints.push('node');
    if (/"react":/i.test(pkg)) hints.push('react');
    if (/"next":/i.test(pkg)) hints.push('next.js');
    if (/"vue":/i.test(pkg)) hints.push('vue');
    if (/"svelte":/i.test(pkg)) hints.push('svelte');
    if (/"express":/i.test(pkg)) hints.push('express');
    if (/"typescript":/i.test(pkg) || in_('tsconfig.json')) hints.push('typescript');
  }
  if (in_('pyproject.toml') || in_('requirements.txt') || in_('setup.py')) {
    hints.push('python');
    const py = readIn('pyproject.toml') || readIn('requirements.txt') || '';
    if (/django|DJANGO/.test(py)) hints.push('django');
    if (/flask|FLASK/.test(py)) hints.push('flask');
    if (/fastapi|FastAPI/.test(py)) hints.push('fastapi');
  }
  if (in_('Cargo.toml')) hints.push('rust');
  if (in_('go.mod'))     hints.push('go');
  if (in_('Gemfile'))    hints.push('ruby');
  if (in_('pom.xml') || in_('build.gradle')) hints.push('java');

  const type = hints[0] || 'unknown';
  return { type, hints, root: dir };
}

// ── Mode detection from the user prompt ────────────────────────────────
function detectMode(prompt) {
  const p = (prompt || '').toLowerCase();
  if (!p.trim()) return 'feature';
  if (/\bsecur|vulnerab|exploit|injection|xss|csrf|auth bypass\b/.test(p)) return 'security';
  if (/\bperformance|latency|bottleneck|optimi[sz]e|slow\b/.test(p))       return 'performance';
  if (/\bjest|vitest|\btest\b|\bspec\b|\bunit test|integration test/.test(p)) return 'testing';
  if (/\berror|\bbug\b|\bfailing|\bfix\b|\bcrash|stack trace|typeerror/.test(p)) return 'debugging';
  if (/\brefactor|\brename|reorganize|extract into|split into/.test(p))   return 'refactoring';
  if (/\bdocs?\b|\bdocumentation\b|\breadme\b|comment.*explain/.test(p))  return 'documentation';
  return 'feature';
}

// ── Mode-specific guidance (short, ≤3 lines each) ──────────────────────
const MODE_GUIDANCE = {
  security:   'Mode: security audit. Prefer reading the relevant module in full before proposing a fix. Cite concrete exploit path, not "looks fine".',
  performance:'Mode: performance. Confirm the bottleneck with a measurement (profile / timing) before changing code — do not guess.',
  testing:    'Mode: testing. Match existing test framework and style; do not introduce a new runner. Run tests after changes.',
  debugging:  'Mode: debugging. Read the exact error + the failing line first, reproduce locally if possible, then apply the minimal fix.',
  refactoring:'Mode: refactoring. Preserve behaviour exactly. No new features. Keep the diff reviewable.',
  documentation: 'Mode: docs. Stay concrete, reference real symbols in the code, avoid marketing language.',
  feature:    'Mode: feature. Read the adjacent code first to match conventions; write small incremental changes; verify builds.'
};

// ── Archive drill-down heuristic  ────────────────────────────────
//
// Goal: when the user refers to data we already fetched/grepped/read
// earlier in the session, nudge the model to query the archive via
// the troth-memory archive tools instead of re-running the
// original tool. Keeps false-positive rate near zero by requiring the
// prompt to contain an explicit back-reference phrase.

const ARCHIVE_SIGNALS = [
  /\b(?:the\s+)?(?:previous|earlier|prior|past|last)\s+(?:grep|read|output|result|search|command|bash|file|run|query)/i,
  /\b(?:you\s+(?:just\s+)?)?(?:showed|read|grepped|searched|found|ran|printed|displayed)\s+(?:me\s+)?(?:earlier|before|a moment ago|just now|previously)/i,
  /\b(?:that|this)\s+(?:grep|search|output|result|file\s+(?:content|dump))/i,
  /\bre-?(?:check|read|open|run)\s+(?:the\s+)?(?:same|earlier|previous)/i,
  /\bwhat\s+(?:was|did)\s+(?:in\s+)?(?:the\s+)?(?:previous|earlier|last)/i
];

function shouldSuggestArchive(prompt) {
  if (!prompt) return false;
  return ARCHIVE_SIGNALS.some(re => re.test(prompt));
}

const ARCHIVE_HINT =
  '[troth/archive] The prompt references data from earlier in the session. ' +
  'Before re-running a tool, pull the archived output instead: ' +
  'mcp_call({server:"troth-memory", tool:"archive_search", args:{query:"<keywords>"}}) to find it, ' +
  'then mcp_call({server:"troth-memory", tool:"archive_excerpt", args:{archive_id, start_line, end_line}}) ' +
  'to read the part you need. That costs no re-run of the original tool.';

// ── Public entrypoint ──────────────────────────────────────────────────
// Returns { context: "..." } where context is the text to pass to the
// hook's additionalContext field, or null to skip injection.
function buildContext(cwd, userPrompt) {
  const project = detectProject(cwd);
  const mode = detectMode(userPrompt);
  const parts = ['[troth/context]'];

  if (project.type !== 'unknown') {
    const hints = project.hints.slice(0, 5).join(', ');
    parts.push('Project: ' + hints);
  }
  parts.push(MODE_GUIDANCE[mode] || MODE_GUIDANCE.feature);

  if (shouldSuggestArchive(userPrompt)) {
    parts.push(ARCHIVE_HINT);
  }

  return {
    context: parts.join('\n'),
    project, mode,
    archiveSuggested: shouldSuggestArchive(userPrompt)
  };
}

module.exports = {
  detectProject,
  detectMode,
  buildContext,
  shouldSuggestArchive,
  MODE_GUIDANCE,
  ARCHIVE_HINT
};
