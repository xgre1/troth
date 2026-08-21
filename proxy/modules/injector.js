// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const HOME = process.env.HOME || require('os').homedir();
const CONFIG_FILE = path.join(HOME, '.troth', 'config.json');

// Load all prompt files at startup
const prompts = {};
for (const file of fs.readdirSync(PROMPTS_DIR)) {
  if (file.endsWith('.md')) {
    const key = file.replace('.md', '');
    prompts[key] = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8').trim();
  }
}

// Mindset toggle — read fresh on every request so the user can flip it
// from the dashboard Settings without restarting the proxy. Defaults to
// ON; only an explicit `mindset: false` in ~/.troth/config.json turns
// it off.
function isMindsetEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.mindset !== false;
  } catch (e) {
    return true;
  }
}

// Extract ALL text content from a request body for project detection
function extractAllContent(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    const parts = [];

    // System prompt
    if (data.system) {
      parts.push(typeof data.system === 'string' ? data.system : JSON.stringify(data.system));
    }

    // All messages (user, assistant, tool results)
    for (const msg of (data.messages || [])) {
      if (typeof msg.content === 'string') {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.text) parts.push(block.text);
          if (block.content) parts.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        }
      }
    }

    return parts.join('\n');
  } catch (e) {
    return '';
  }
}

// Detect project type from content
function detectProject(content) {
  const checks = [
    { type: 'react', patterns: [/\.(tsx|jsx)\b/, /from ['"]react['"]/, /import React/, /useState|useEffect|useCallback/, /next\.js|nextjs|Next\.js|tailwind|shadcn|app\/page|app\/layout/i] },
    { type: 'typescript', patterns: [/tsconfig/, /\.(ts)\b/, /from ['"]/, /interface\s+\w+/, /: string|: number|: boolean/] },
    { type: 'nodejs', patterns: [/package\.json/, /require\(/, /node_modules/, /npm install/, /const express|const http/] },
    { type: 'python', patterns: [/requirements\.txt/, /\.py\b/, /import\s+\w+/, /def\s+\w+/, /pip install/, /python|django|flask|fastapi/i] },
  ];

  const detected = [];
  for (const { type, patterns } of checks) {
    const matches = patterns.filter(p => p.test(content)).length;
    if (matches >= 1) detected.push(type);
  }

  // React includes TypeScript often
  if (detected.includes('react')) return 'react';
  if (detected.includes('typescript')) return 'typescript';
  if (detected.includes('nodejs')) return 'nodejs';
  if (detected.includes('python')) return 'python';
  return 'generic';
}

// Detect task type from content — what the agent is DOING right now.
// This determines which workflow routine gets injected.
function detectMode(content) {
  const lastChunk = content.slice(-5000); // Recent context

  // Security: explicit security/audit patterns
  if (/\bsecurity\b|\bvulnerab|\bexploit\b|\binjection\b|\bXSS\b|\bCSRF\b|\bauth bypass\b|\bsanitiz/i.test(lastChunk)) return 'security';

  // Performance: profiling, latency, optimization
  if (/\bperformance\b|\blatency\b|\bbottleneck\b|\boptimi[sz]e\b|\bmemory leak\b|\bN\+1\b|\bslow query\b/i.test(lastChunk)) return 'performance';

  // Testing: explicit test-related patterns
  if (/jest|vitest|test\(|describe\(|it\(|expect\(|\.test\.|\.spec\.|__tests__/.test(lastChunk)) return 'testing';

  // Debugging: error messages, stack traces, fixing broken things
  if (/Error:|error:|stack trace|TypeError|SyntaxError|Cannot find|not defined|ENOENT|EACCES|exit code [1-9]|Build failed|Failed to compile/i.test(lastChunk)) return 'debugging';

  // Refactoring: restructuring, renaming, moving files
  if (/refactor|restructure|rename|reorganize|move.*to|extract.*into|split.*into|consolidate/i.test(lastChunk)) return 'refactoring';

  // Default: building features
  return 'feature';
}

// Adapt prompt format for target model family (Not Diamond Prompt Adaptation).
// Research [MW]: +5-60% accuracy gain from format matching per model.
function adaptForModel(text, targetModel) {
  if (!text || !targetModel) return text;
  var lower = (targetModel || '').toLowerCase();

  // Gemini: clear numbered lists, explicit constraints, no XML, square brackets for tags
  if (lower.includes('gemini')) {
    return text
      .replace(/<([a-z_]+)>/g, '[$1]')
      .replace(/<\/([a-z_]+)>/g, '[/$1]');
  }

  // Qwen/Alibaba: prefers very structured markdown with explicit role headers
  // and numbered steps. Tends to lose track of nested instructions.
  if (lower.includes('qwen') || lower.includes('alibaba')) {
    // Add explicit role marker at top if not present
    if (!/^##\s/.test(text)) {
      text = "## Instructions\n\n" + text;
    }
    return text;
  }

  // DeepSeek: handles markdown well. Prefers compact, dense instructions
  // over verbose explanations. Strip multiple consecutive blank lines.
  if (lower.includes('deepseek')) {
    return text.replace(/\n{3,}/g, '\n\n');
  }

  // MiniMax: similar to Qwen but more sensitive to long contexts.
  // Truncate aggressively if very long.
  if (lower.includes('minimax')) {
    if (text.length > 8000) {
      return text.slice(0, 8000) + '\n\n[...truncated for length...]';
    }
    return text;
  }

  // GPT/OpenAI: handles XML and markdown. Likes explicit "ROLE:" prefixes.
  if (lower.includes('gpt') || lower.includes('openai')) {
    return text;
  }

  // Anthropic Claude: receives well-structured prompts from Claude Code.
  // Don't add extra wrapping that could interfere.
  if (lower.includes('claude') || lower.includes('anthropic')) {
    return text;
  }

  // GLM: prefers clear, declarative instructions. Strip emojis (it occasionally
  // mirrors them inappropriately into code).
  if (lower.includes('glm')) {
    return text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  }

  return text;
}

// Detect which file-type rules are relevant to the current request.
// Scans recent tool_uses + tool_results for file paths and matches patterns.
function detectFileTypeRules(bodyStr, prompts) {
  const rules = [];
  const seen = new Set();
  try {
    const data = JSON.parse(bodyStr);
    const msgs = data.messages || [];
    // Look at the last 6 messages for file references
    const recent = msgs.slice(-6);
    let hasSql = false, hasApi = false, hasTest = false;
    let hasReact = false, hasTs = false, hasPython = false;
    let hasGo = false, hasRust = false, hasCss = false;
    let hasHtml = false, hasJava = false, hasRuby = false, hasPhp = false;
    let hasSwift = false, hasKotlin = false;
    let hasScala = false, hasElixir = false;
    for (const msg of recent) {
      const c = Array.isArray(msg.content) ? msg.content : [];
      for (const block of c) {
        let text = '';
        if (block && block.type === 'tool_use' && block.input) {
          text = (block.input.file_path || block.input.path || '') + ' ' + (block.input.command || '') + ' ' + (block.input.pattern || '');
        } else if (block && block.type === 'tool_result' && block.content) {
          text = typeof block.content === 'string' ? block.content.slice(0, 1000) :
            (Array.isArray(block.content) ? block.content.filter(b => b && b.type === 'text').map(b => b.text || '').join(' ').slice(0, 1000) : '');
        } else if (block && block.type === 'text' && block.text) {
          text = block.text.slice(0, 500);
        }
        if (!text) continue;
        if (!hasSql && /\.(sql|db|sqlite)\b|better-sqlite3|sqlite3|pg-pool|knex|prisma|sequelize|drizzle/i.test(text)) hasSql = true;
        if (!hasApi && /\b(express|fastify|koa|hapi|router|app\.(get|post|put|delete|patch))\b|\/api\//.test(text)) hasApi = true;
        if (!hasTest && /\b(test\.js|test\.ts|spec\.js|spec\.ts|\.test\.|\.spec\.|jest|mocha|vitest|describe\s*\(|it\s*\()/.test(text)) hasTest = true;
        if (!hasReact && /\.(jsx|tsx)\b|useState|useEffect|useMemo|useCallback|<[A-Z]\w+\s|React\.|next\/(router|navigation)/i.test(text)) hasReact = true;
        if (!hasTs && /\.(ts|tsx)\b|: (string|number|boolean|void|Promise|Array|Record)|interface\s+\w+|type\s+\w+\s*=/i.test(text)) hasTs = true;
        if (!hasPython && /\.py\b|def \w+\(|import \w+|from \w+ import|pip install|requirements\.txt|pyproject\.toml/i.test(text)) hasPython = true;
        if (!hasGo && /\.go\b|package main|func \w+\(|go\.mod|go\.sum|defer\s+\w+/i.test(text)) hasGo = true;
        if (!hasRust && /\.rs\b|fn \w+\(|use \w+::|cargo\.toml|impl\s+\w+/i.test(text)) hasRust = true;
        if (!hasCss && /\.(css|scss|sass|tailwind|module\.css)\b|@media|tailwind\.config|className=/i.test(text)) hasCss = true;
        if (!hasHtml && /\.(html|htm)\b|<html|<head>|<body>|<!doctype|<div\s|<form\s/i.test(text)) hasHtml = true;
        if (!hasJava && /\.java\b|public\s+class\s+|@Override|import java\.|maven|gradle/i.test(text)) hasJava = true;
        if (!hasRuby && /\.rb\b|require\s+['"]|def\s+\w+\s*$|gemfile|bundle\s+exec/i.test(text)) hasRuby = true;
        if (!hasPhp && /\.php\b|<\?php|namespace\s+\w+;|composer\.json|->|use\s+\w+\\/i.test(text)) hasPhp = true;
        if (!hasSwift && /\.swift\b|import SwiftUI|import Foundation|func\s+\w+\([^)]*\)\s*->|guard\s+let\s+|@State\b/i.test(text)) hasSwift = true;
        if (!hasKotlin && /\.(kt|kts)\b|fun\s+\w+\(|val\s+\w+\s*[:=]|sealed\s+class|data\s+class|coroutine|@Composable/i.test(text)) hasKotlin = true;
        if (!hasScala && /\.(scala|sbt)\b|object\s+\w+\s*(?:extends|\{)|trait\s+\w+|case\s+class|sealed\s+trait|libraryDependencies/i.test(text)) hasScala = true;
        if (!hasElixir && /\.(ex|exs)\b|defmodule\s+|def\s+\w+\(.*\)\s*do|GenServer|mix\.exs|\|>/i.test(text)) hasElixir = true;
      }
    }
    if (hasSql && prompts['rules-sql'] && !seen.has('sql')) { rules.push(prompts['rules-sql']); seen.add('sql'); }
    if (hasApi && prompts['rules-api'] && !seen.has('api')) { rules.push(prompts['rules-api']); seen.add('api'); }
    if (hasTest && prompts['rules-test'] && !seen.has('test')) { rules.push(prompts['rules-test']); seen.add('test'); }
    if (hasReact && prompts['rules-react'] && !seen.has('react')) { rules.push(prompts['rules-react']); seen.add('react'); }
    if (hasTs && prompts['rules-typescript'] && !seen.has('typescript')) { rules.push(prompts['rules-typescript']); seen.add('typescript'); }
    if (hasPython && prompts['rules-python'] && !seen.has('python')) { rules.push(prompts['rules-python']); seen.add('python'); }
    if (hasGo && prompts['rules-go'] && !seen.has('go')) { rules.push(prompts['rules-go']); seen.add('go'); }
    if (hasRust && prompts['rules-rust'] && !seen.has('rust')) { rules.push(prompts['rules-rust']); seen.add('rust'); }
    if (hasCss && prompts['rules-css'] && !seen.has('css')) { rules.push(prompts['rules-css']); seen.add('css'); }
    if (hasHtml && prompts['rules-html'] && !seen.has('html')) { rules.push(prompts['rules-html']); seen.add('html'); }
    if (hasJava && prompts['rules-java'] && !seen.has('java')) { rules.push(prompts['rules-java']); seen.add('java'); }
    if (hasRuby && prompts['rules-ruby'] && !seen.has('ruby')) { rules.push(prompts['rules-ruby']); seen.add('ruby'); }
    if (hasPhp && prompts['rules-php'] && !seen.has('php')) { rules.push(prompts['rules-php']); seen.add('php'); }
    if (hasSwift && prompts['rules-swift'] && !seen.has('swift')) { rules.push(prompts['rules-swift']); seen.add('swift'); }
    if (hasKotlin && prompts['rules-kotlin'] && !seen.has('kotlin')) { rules.push(prompts['rules-kotlin']); seen.add('kotlin'); }
    if (hasScala && prompts['rules-scala'] && !seen.has('scala')) { rules.push(prompts['rules-scala']); seen.add('scala'); }
    if (hasElixir && prompts['rules-elixir'] && !seen.has('elixir')) { rules.push(prompts['rules-elixir']); seen.add('elixir'); }
  } catch (e) {}
  return rules;
}

function buildInjection(bodyStr, repoMap) {
  const content = extractAllContent(bodyStr);
  const projectType = detectProject(content);
  const mode = detectMode(content);

  // trivial-query gate. For prompts like "reply OK" / "what time
  // is it" / single-word voice probes, ALL heavy static injection (mindset,
  // structured envelope, identity engrams, hydration ctx, buildgraph ctx,
  // codelens architecture) is dead weight. With cloud Anthropic prompt
  // caching it amortizes; with local llama-server (NO cache) every turn
  // pays ~7-10K tokens of prefill for a 10-char user message — 30-60s of
  // wall clock on a 30B-param Q8 GGUF before the model says a single
  // useful token. The gate is conservative: latest user message under
  // ~80 chars AND projectType=='generic' (no code keywords detected).
  // Real project work or any code-flavored prompt falls through to the
  // existing full injection pipeline unchanged.
  let latestUserText = '';
  try {
    const _p = JSON.parse(bodyStr);
    const _msgs = _p.messages || [];
    for (let _i = _msgs.length - 1; _i >= 0; _i--) {
      if (_msgs[_i].role === 'user') {
        const _c = _msgs[_i].content;
        if (typeof _c === 'string') latestUserText = _c;
        else if (Array.isArray(_c)) {
          latestUserText = _c
            .filter((b) => b && b.type === 'text' && b.text)
            .map((b) => b.text)
            .join(' ');
        }
        break;
      }
    }
  } catch (_) {}
  // Gate based ONLY on the latest user message — not the whole conversation
  // content. detectProject(content) above sees the entire system prompt +
  // history and routinely classifies casual chat as 'react/security' just
  // because the system prompt mentions React or `await Promise`. Re-detect
  // on JUST the user's latest words so a one-word "hi" / "ok" / "go" is
  // trivial even when the surrounding session is heavy.
  const _userOnlyType = detectProject(latestUserText || '');
  const _trim = latestUserText.trim();
  const isTrivialQuery = _trim.length < 80 && _userOnlyType === 'generic';
  // The gate below applies to DYNAMIC parts only. It used to zero the STATIC
  // block too, and that toggle was the most expensive line in the pipeline:
  // any <80-char message ("hi", but also "fix the second one") removed
  // system[0], the next longer message put it back, and each flip re-billed
  // the entire [system + history] prefix on every prompt-cached lane — Kimi
  // charges input_tokens on the uncached remainder, llama-server refills the
  // whole slot. Static content is compute-once and byte-stable by design, so
  // carrying it on a trivial turn costs one cache read; dropping it costs the
  // whole prefix. The dynamic tail sits LAST in system[], so gating it busts
  // only itself.

  // P2.5: split content into STATIC (session-level, safe to cache) and DYNAMIC
  // (per-request, changes often) buckets. The inject() caller places them as
  // separate blocks — only the static block carries cache_control, so the
  // cache prefix remains stable across requests within the same session.
  // Mixing dynamic content into a cached block invalidates the cache on every
  // request, and every invalidated prefix is re-billed as fresh input. The
  // multiplier depends on how much of the prompt was cached and how often the
  // dynamic part moves, so no figure is quoted here.
  const staticParts = [];  // session-level, stable across requests
  const dynamicParts = []; // per-request, changes frequently

  // --- STATIC: mindset (pure prompt file content)
  if (isMindsetEnabled() && prompts.mindset) staticParts.push(prompts.mindset);

  // --- DYNAMIC: critic feedback — changes with every failure/turn
  try {
    const { getPendingFeedback, getFailureContext } = require('./critic');
    const feedback = getPendingFeedback();
    if (feedback) dynamicParts.push(feedback);
    const failures = getFailureContext();
    if (failures) dynamicParts.push(failures);
  } catch (e) {}

  // Reflexion and trajectory blocks lived here — learning modules that only
  // ever saw traffic through this proxy, which the editor surfaces do not
  // route through. Measured across four months: zero reflections, four
  // trajectories, nothing ever re-surfaced. The live lane learns elsewhere
  // (errortax choice-lessons, the delivery queue, verifyfirst); these blocks
  // and their modules are retired.

  // --- STATIC: architecture overview (once per session, gated by _archDone)
  // EXTRA gate: only inject when the conversation is actually about code in
  // a recognized project type. For trivial chat ("reply ok") or non-code
  // queries, projectType=='generic' and codelens is 3-5K tokens of dead
  // weight per request — especially expensive on local backends (e.g.
  // llama-server) which have NO prompt caching, so the prefill cost is
  // paid in full every turn. The cloud Anthropic path amortizes via
  // cache_control breakpoints; local does not.
  // Cache-stability fix: the previous "_archDone"
  // gating sent codelens overview ONLY on the first turn of a session, then
  // omitted it forever. That made the static block content vary between
  // turn 1 and turn 2 → byte-prefix change → llama-server slot cache MISS
  // every turn 2+, paying full prefill again (3-5K tokens). The substrate
  // "one entity" thesis requires this content to be ALWAYS PRESENT anyway
  // (it's stable identity, not retrieval). We compute once (cheap CPU
  // saving) but ALWAYS inject — bytes are identical → cache hits.
  if (projectType !== 'generic') {
    try {
      if (buildInjection._archCache === undefined) {
        if (!require('./modtoggle').isModuleEnabled('codelens')) throw 0; // toggle off → no overview
        const codelens = require('./codelens');
        const overview = codelens.getArchitectureOverview();
        buildInjection._archCache = overview || null;
        if (overview && codelens._store && codelens._store.getDecisionsSummary) {
          buildInjection._archDecisionsCache = codelens._store.getDecisionsSummary() || null;
        }
      }
      if (buildInjection._archCache) {
        staticParts.push(buildInjection._archCache);
        if (buildInjection._archDecisionsCache) staticParts.push(buildInjection._archDecisionsCache);
      }
    } catch (e) {}
  }

  // --- DYNAMIC: orchestration hint. Runs the cheap triage heuristic on
  // the latest user message. Silent for inline / single-domain / question
  // prompts. Fires only when user explicitly asked for orchestration OR
  // a multi-domain build task is detected. Keeps small tasks fast and
  // prevents sub-agent fan-out by default. Trivial conversational prompts
  // never need orchestration — gate to skip the triage cost entirely.
  if (!isTrivialQuery) try {
    let _orchUserText = '';
    try {
      const _parsed = JSON.parse(bodyStr);
      const _msgs = _parsed.messages || [];
      for (let _i = _msgs.length - 1; _i >= 0; _i--) {
        if (_msgs[_i].role === 'user') {
          const _c = _msgs[_i].content;
          if (typeof _c === 'string') _orchUserText = _c;
          else if (Array.isArray(_c)) {
            _orchUserText = _c.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ');
          }
          break;
        }
      }
    } catch (e) {}
    if (_orchUserText && _orchUserText.length > 20) {
      const triageMod = require('../../shared-core/orchestrate-triage');
      const t = triageMod.triage(_orchUserText);
      if (t.mode === 'explicit_request') {
        const roles = (t.suggested_roles || []).join(', ');
        dynamicParts.push(
          '[troth/orchestration-hint] User explicitly requested multi-agent orchestration.\n' +
          '  Suggested roles: ' + (roles || '(none — defaults: backend, frontend, qa)') + '\n' +
          '  Action: call troth_orchestrate_run with this task and the roles above. ' +
          'Forward the returned summary verbatim to the user. Do NOT also do the work inline.'
        );
      } else if (t.mode === 'ask_user') {
        const roles = (t.suggested_roles || []).join(', ');
        dynamicParts.push(
          '[troth/orchestration-hint] This task spans multiple domains — orchestration may help.\n' +
          '  Detected roles: ' + roles + '\n' +
          '  Confidence: ' + (t.confidence || 0).toFixed(2) + '\n' +
          '  Reason: ' + (t.reason || '') + '\n' +
          '  Action: ASK the user FIRST: "this looks like ' + (t.suggested_roles || []).length +
          ' specialist roles (' + roles + ') — want me to orchestrate them in parallel, or handle it inline myself?" ' +
          'Only call troth_orchestrate_run after explicit user confirmation. ' +
          'Default to inline if the user prefers speed over coordination.'
        );
      }
      // mode='inline' → silent, no hint emitted.
    }
  } catch (e) {}

  // --- STATIC: structured envelope instruction. the entity design — asks
  // the LLM to tag claim/action/refusal/question/meta sections so the
  // proxy can route the response back through reconciler / executor /
  // audit log instead of reparsing free-form text. Idempotent; gated
  // once per session via _envelopeDone so we don't re-instruct mid-loop.
  // OFF unless asked for (TROTH_STRUCTURED_ENVELOPE=1). A model told to tag
  // its reply obeys, and it stops writing like a conversational partner:
  // replies came back as filled-in forms ("<claim>...</claim>
  // <question>...</question>"), stilted and repetitive, with the tags
  // visible to the operator. What
  // the instruction buys is one audit row when a reply carries refusals,
  // questions or several actions; decompose() still reads tags from any
  // model that emits them, so nothing downstream breaks by asking less.
  if (process.env.TROTH_STRUCTURED_ENVELOPE === '1') {
    try {
      if (buildInjection._envelopeCache === undefined) {
        const env = require('../../shared-core/structured-envelope');
        buildInjection._envelopeCache = env.ENVELOPE_INSTRUCTION || null;
      }
      if (buildInjection._envelopeCache) staticParts.push(buildInjection._envelopeCache);
    } catch (e) {}
  }

  // --- DYNAMIC: high-quality lessons surfaced by lesson-library ranking.
  // lesson-library quality framework in front of chronological
  // pull. Without ranking, the prefix surfaces noise (recent test errors,
  // one-off typos). With ranking, recurring + structurally-anchored +
  // recently-useful lessons rise. Property #10 — learns genuinely.
  // Skipped on trivial queries — lessons help apply correction to actual
  // work, useless overhead on a "hi"/"ok" turn (substrate still available
  // via troth-router/memory if model wants to fault them in).
  if (!isTrivialQuery) try {
    const lessonLib = require('../../shared-core/lesson-library');
    const query = require('../../shared-core/query');
    const state = require('../../shared-core/state');
    const recentLessons = query.getLessons(state, { limit: 50 }) || [];
    if (recentLessons.length) {
      const fs = require('fs');
      const ranked = lessonLib.rankLessons(recentLessons, {
        limit: 5,
        fileExists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } }
      });
      const lessonLines = [];
      for (const l of ranked) {
        const stmt = (l.output && (l.output.text || l.output.lesson_text || l.output.statement || l.output.summary)) || '';
        if (!stmt) continue;
        const q = (l._quality && l._quality.quality) || 0;
        if (q < 0.25) continue;
        const _lts = Number.isFinite(l.ts) ? l.ts : (Number.isFinite(l.timestamp) ? l.timestamp : null);
        const _ld = _lts ? '[' + new Date(_lts).toISOString().slice(0, 10) + '] ' : '';
        lessonLines.push('  · [q=' + q.toFixed(2) + '] ' + _ld + String(stmt).replace(/\s+/g, ' ').slice(0, 200));
      }
      if (lessonLines.length) {
        dynamicParts.push('[troth/lessons] Quality-ranked lessons from prior turns:\n' + lessonLines.join('\n'));
      }
    }
  } catch (e) {}

  // --- STATIC: substrate identity envelope (Property #4 — memory as identity,
  // not RAG). Top-N highest-salience commitments enter the prefix on every
  // turn, not on retrieval-by-similarity. The dream property is "always
  // present" — substrate identity is the same shape as a person's stable
  // self, not a search hit. Capped to 8 commitments × 200 chars to stay
  // lean. Cached per session via _identityDone.
  {
    try {
      // Refresh identity cache every 5 min (identity is "stable" but new
      // commitments do land throughout a long session). Between refreshes
      // the bytes are identical → cache hits.
      const now = Date.now();
      const stale = !buildInjection._identityCache ||
        (now - (buildInjection._identityCachedAt || 0) > 5 * 60 * 1000);
      if (stale) {
        // single-mind — single-mind identity surface. Delegates to the
        // canonical composeEnvelope() so the proxy injector is byte-identical
        // to the entity surface: unions anchors + scope:identity, excludes
        // tier='flagged', fuzzy-dedups, ranks by salience × authority via the
        // ONE shared fail-neutral model. This surface previously ranked by
        // SALIENCE ALONE (no authority at all — a third divergent ranking
        // beyond the two _AUTH_W copies, an internal audit), scope:identity only (no
        // anchor union), exact-norm dedup. 800-char budget + 5-min cache kept.
        const engram = require('../../shared-core/engram');
        let block = '';
        try {
          const { composeEnvelope } = require('../../shared-core/identity-envelope.js');
          block = composeEnvelope({
            listEngrams: engram.listEngrams,
            budgetItems: 8,
            charBudget: 800,
          }).block || '';
        } catch (_) { block = ''; }
        buildInjection._identityCache = block || null;
        buildInjection._identityCachedAt = now;
      }
      if (buildInjection._identityCache) staticParts.push(buildInjection._identityCache);
    } catch (e) {}
  }

  // --- STATIC: build grounding (RIG/SPADE test/build commands, deps, entry points)
  // Cache once, always inject so prefix stays byte-stable across turns.
  {
    try {
      if (buildInjection._bgCache === undefined) {
        const buildgraph = require('./buildgraph');
        buildInjection._bgCache = buildgraph.getContext() || null;
      }
      if (buildInjection._bgCache) staticParts.push(buildInjection._bgCache);
    } catch (e) {}
  }

  // --- DYNAMIC: repoMap (CodeLens query result reflects current request's focus)
  if (repoMap && repoMap.length > 30) dynamicParts.push(repoMap);

  // --- STATIC: project-specific rules (derived from project type which is session-stable)
  if (prompts[projectType]) {
    staticParts.push(prompts[projectType]);
  }

  // --- DYNAMIC: file-type rules (derived from files mentioned in THIS request)
  if (!isTrivialQuery) try {
    const fileTypeRules = detectFileTypeRules(bodyStr, prompts);
    for (const rule of fileTypeRules) dynamicParts.push(rule);
  } catch (e) {}

  // --- DYNAMIC: co-change hints (based on recent files)
  if (!isTrivialQuery) try {
    if (!require('./modtoggle').isModuleEnabled('cochange')) throw 0; // toggle off → skip hint
    if (!require('./modtoggle').isModuleEnabled('codelens')) throw 0; // recent-files ride codelens
    const codelens = require('./codelens');
    const cochange = require('./cochange');
    const recentFiles = codelens.getRecentFiles ? codelens.getRecentFiles() : [];
    if (recentFiles.length) {
      const coHint = cochange.buildCoChangeHint(recentFiles);
      if (coHint) dynamicParts.push(coHint);
    }
  } catch (e) {}

  // --- DYNAMIC: substrate engrams anchored to files in this turn's focus.
  // completes the codelens↔substrate bridge (writer landed in
  // engram.js + critic.js earlier today). For each file the agent is about
  // to touch, surface prior commitments whose provenance.file_path matches.
  // Brings cross-session decisions/learnings to the model's attention without
  // forcing a tool call. Strict: only commitments with provenance fields,
  // capped to 5 most-recent per file to keep prefix lean.
  if (!isTrivialQuery) try {
    const codelens = require('./codelens');
    const recentFiles = codelens.getRecentFiles ? codelens.getRecentFiles() : [];
    if (recentFiles.length) {
      const engram = require('../../shared-core/engram');
      const lines = [];
      const seen = new Set();
      const cwd = process.cwd();
      // listEngrams requires explicit agent_id; reuse the project-scoped one
      // the critic bridge writes under so we read what we wrote.
      const candidates = engram.listEngrams({
        agent_id: 'critic',
        cwd,
        limit: 200
      }) || [];
      for (const e of candidates) {
        const prov = e.output && e.output.provenance;
        if (!prov || !prov.file_path) continue;
        const matched = recentFiles.some(function(f) {
          return f && (prov.file_path === f || prov.file_path.endsWith(f) || f.endsWith(prov.file_path));
        });
        if (!matched) continue;
        const key = prov.file_path + '::' + (e.output.statement || '').slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        const fname = prov.file_path.split('/').pop();
        const stmt = String(e.output.statement || '').replace(/\s+/g, ' ').slice(0, 180);
        const _ets = Number.isFinite(e.ts) ? e.ts : (Number.isFinite(e.timestamp) ? e.timestamp : null);
        lines.push('  · ' + (_ets ? '[' + new Date(_ets).toISOString().slice(0, 10) + '] ' : '') + fname + ' — ' + stmt);
        if (lines.length >= 5) break;
      }
      if (lines.length) {
        // lmql.fillTemplate gives us declarative-template
        // constraint enforcement on the injected block — keeps the
        // prefix from blowing up if a single statement is huge.
        let block;
        try {
          const lmql = require('./lmql');
          const tpl = '[troth/anchored-decisions] {{header:len<200}}\n{{body:len<1500}}';
          const r = lmql.fillTemplate(tpl, {
            header: 'Prior decisions you committed to that touch the files in focus:',
            body: lines.join('\n')
          });
          block = (r && r.ok && r.prompt) ? r.prompt : null;
        } catch (e) {}
        if (!block) {
          block = '[troth/anchored-decisions] Prior decisions you committed to that touch the files in focus:\n' + lines.join('\n');
        }
        dynamicParts.push(block);
      }
    }
  } catch (e) {}

  // --- DYNAMIC: workflow state (persistent, but changes with task progress)
  if (!isTrivialQuery) try {
    const wf = require('./workflow');
    const wfBlock = wf.buildStateBlock();
    if (wfBlock) dynamicParts.push(wfBlock);
  } catch (e) {}

  // --- DYNAMIC: speculative edit hint (pre-load files mentioned in request)
  if (!isTrivialQuery) try {
    const { speculativeEditHint } = require('./skimmer');
    const specHint = speculativeEditHint(bodyStr);
    if (specHint) dynamicParts.push(specHint);
  } catch (e) {}

  // Detect if this is a NEW human instruction vs mid-loop continuation.
  // New instructions get the planning routine first, then task-specific routine.
  var isNewTask = false;
  try {
    var parsed = JSON.parse(bodyStr);
    var msgs = parsed.messages || [];
    if (msgs.length <= 1) {
      isNewTask = true; // First message = definitely new task
    } else {
      // Check last user message: has text (human) or only tool_results (mid-loop)?
      for (var mi = msgs.length - 1; mi >= 0; mi--) {
        if (msgs[mi].role === 'user') {
          var c = msgs[mi].content;
          if (typeof c === 'string' && c.trim().length > 0) isNewTask = true;
          if (Array.isArray(c)) {
            var hasText = c.some(function(b) { return b.type === 'text' && b.text && b.text.trim().length > 10; });
            var hasToolResult = c.some(function(b) { return b.type === 'tool_result'; });
            isNewTask = hasText && !hasToolResult;
          }
          break;
        }
      }
    }
  } catch (e) {}

  // Architect/Editor split:
  // Complex new task (Architect) → full planning routine + task-type routine
  // Simple new task → task-type routine only (no mandatory planning overhead)
  // Mid-loop (Editor) → minimal guidance only
  var isComplex = false;
  if (isNewTask) {
    // Detect complexity: multiple files, architecture, dashboard, API, etc.
    try {
      var lastMsg = JSON.parse(bodyStr).messages || [];
      var userText = '';
      for (var ui = lastMsg.length - 1; ui >= 0; ui--) {
        if (lastMsg[ui].role === 'user') {
          var uc = lastMsg[ui].content;
          userText = typeof uc === 'string' ? uc : (Array.isArray(uc) ? uc.filter(function(b){return b.type==='text'}).map(function(b){return b.text}).join(' ') : '');
          break;
        }
      }
      isComplex = userText.length > 120 &&
        /\b(build|create|implement|refactor|migrate|redesign|add.*feature|add.*endpoint|fix.*bug|all.*tests|dashboard|multiple|pages|api.*route|full.*app|build.*project|test.*pass)\b/i.test(userText);
    } catch (e) { isComplex = false; }
  }

  // --- DYNAMIC: routines (depend on isNewTask/isComplex/mode — all per-request)
  if (isNewTask && isComplex) {
    if (prompts['routine-planning']) dynamicParts.push(prompts['routine-planning']);
    var routineKey = 'routine-' + mode;
    if (prompts[routineKey]) dynamicParts.push(prompts[routineKey]);
    if (prompts['rvp']) dynamicParts.push(prompts['rvp']);
  } else if (!isNewTask) {
    dynamicParts.push('Execute efficiently. Read before edit. Verify after each change. Do not repeat failed approaches.');
  }

  // Detect target model for prompt adaptation
  var targetModel = 'gemini'; // default
  try {
    var cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.routing && cfg.routing.planning) targetModel = cfg.routing.planning;
  } catch (e) {}

  var staticPrompt = adaptForModel(staticParts.join('\n\n'), targetModel);
  var dynamicPrompt = adaptForModel(dynamicParts.join('\n\n'), targetModel);

  // Legacy single-string `prompt` retained so external callers that haven't
  // migrated still get a usable output. Always static+dynamic concatenated.
  var prompt = [staticPrompt, dynamicPrompt].filter(Boolean).join('\n\n');

  return { prompt, staticPrompt, dynamicPrompt, projectType, mode };
}

// Count existing cache_control breakpoints across the full request.
// Anthropic caps active breakpoints at 4 per request; exceeding this can
// trigger double-billing regressions.
function countCacheControlBreakpoints(data) {
  let n = 0;
  const scan = (block) => {
    if (block && typeof block === 'object' && block.cache_control) n++;
  };
  if (Array.isArray(data.system)) data.system.forEach(scan);
  if (Array.isArray(data.tools)) data.tools.forEach(scan);
  if (Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      if (Array.isArray(msg.content)) msg.content.forEach(scan);
    }
  }
  return n;
}

// Inject into request body with static-boundary cache-pattern awareness.
//
// The scaffolding we inject is static per-project (project type, rules, repoMap
// shape). Marking it with cache_control lets Anthropic cache the prefix so
// subsequent turns in the same project only pay a cache_read rate for it.
//
// Constraints:
// Exactly 4 cache_control breakpoints maximum across the whole request.
// Our scaffolding must be placed as its OWN block so the client's existing
//   cache_control markers on project context / messages aren't disrupted.
// If total would exceed 4, we place our block WITHOUT cache_control to stay
//   compliant (graceful degradation — scaffolding still injected, just uncached).
//
// when the v10 plugin is actively firing hooks on this machine,
// its UserPromptSubmit injector is already producing the same
// additionalContext we'd otherwise add here on the proxy side. Running
// both duplicates mode hints, project detection, and the repo map.
//
// Gated behind ~/.troth/config.json { "coexistence": true }  (default
// off) so a stale plugin_presence row never silently disables the
// proxy's scaffolding. Also honours TROTH_COEXISTENCE=1 for tests.
let _state = null;
try { _state = require('../../shared-core/state.js'); } catch (e) { /* optional */ }
function pluginIsHandlingInjection() {
  if (!_state || typeof _state.isPluginActive !== 'function') return false;
  if (!coexistenceEnabled()) return false;
  try { return !!_state.isPluginActive().active; } catch (e) { return false; }
}
function coexistenceEnabled() {
  if (process.env.TROTH_COEXISTENCE === '1') return true;
  if (process.env.TROTH_COEXISTENCE === '0') return false;
  try {
    var fsMod = require('fs');
    var pMod = require('path');
    var cfgPath = pMod.join(process.env.HOME || '', '.troth', 'config.json');
    var cfg = JSON.parse(fsMod.readFileSync(cfgPath, 'utf8'));
    return cfg && cfg.coexistence === true;
  } catch (e) { return false; }
}

function inject(bodyStr, repoMap) {
  try {
    // Coexistence short-circuit: defer to the plugin if it's active.
    if (pluginIsHandlingInjection()) {
      return bodyStr;
    }

    const data = JSON.parse(bodyStr);
    const { prompt, staticPrompt, dynamicPrompt, projectType, mode } = buildInjection(bodyStr, repoMap);

    // Two-block pattern (P2.5): static content gets cache_control, dynamic doesn't.
    // Keeping them in separate blocks prevents dynamic content (critic feedback,
    // trajectory hints, repoMap, file-type rules, co-change, workflow state,
    // speculative hints, routines) from invalidating the cached scaffolding prefix.
    const existingBreakpoints = countCacheControlBreakpoints(data);
    const canCacheStatic = existingBreakpoints < 4 && staticPrompt && staticPrompt.trim().length > 0;

    const staticBlock = (staticPrompt && staticPrompt.trim().length > 0)
      ? { type: 'text', text: staticPrompt }
      : null;
    if (staticBlock && canCacheStatic) staticBlock.cache_control = { type: 'ephemeral' };
    const dynamicBlock = (dynamicPrompt && dynamicPrompt.trim().length > 0)
      ? { type: 'text', text: dynamicPrompt }   // never cache-marked
      : null;

    // ORDER: [static(cached) → ORIGINAL
    // Claude Code system → dynamic LAST]. The dynamic block (critic feedback,
    // trajectory, repoMap, routines, workflow state) changes every turn. Placing
    // it BEFORE the large stable original system prompt truncated the auto-cacheable
    // PREFIX on OpenAI-shape providers (DeepSeek/Gemini/Qwen/GLM/codex auto-cache
    // the longest byte-stable prefix), so the big stable region was re-billed at
    // full input price every turn (~9-10x cached). Putting dynamic LAST makes
    // [static + original] one contiguous cacheable prefix; only the small dynamic
    // tail busts. No regression for Anthropic (static stays cache_control'd).
    if (data.system !== undefined) {
      if (typeof data.system === 'string') {
        const origBlock = { type: 'text', text: data.system };
        data.system = [staticBlock, origBlock, dynamicBlock].filter(Boolean);
      } else if (Array.isArray(data.system)) {
        data.system = [staticBlock, ...data.system, dynamicBlock].filter(Boolean);
      }
    } else if (data.messages && Array.isArray(data.messages)) {
      // No system field at all — set one. Anthropic's /v1/messages rejects
      // role:'system' messages ("Messages API accepts a top-level `system`
      // parameter, not 'system' as an input message role"). The legacy
      // unshift path was dormant because real claude --print always sends
      // a system field, but any other caller (curl test, custom tooling)
      // would hit a 400. Set top-level system as the typed-block array.
      data.system = [staticBlock, dynamicBlock].filter(Boolean);
    }

    return {
      body: JSON.stringify(data),
      projectType,
      mode,
      cacheBreakpointsBefore: existingBreakpoints,
      cacheBreakpointsAfter: countCacheControlBreakpoints(data),
      staticBytes: staticPrompt ? staticPrompt.length : 0,
      dynamicBytes: dynamicPrompt ? dynamicPrompt.length : 0
    };
  } catch (e) {
    return { body: bodyStr, projectType: 'unknown', mode: 'unknown' };
  }
}

module.exports = { inject, detectProject, detectMode, countCacheControlBreakpoints };
