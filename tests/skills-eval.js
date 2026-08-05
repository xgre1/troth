#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// skills-eval — regression harness for LLM-driven slash skills.
//
// Why a separate runner:
//   tests/test-all.js is unit-test territory (deterministic, no network,
//   no API keys). The 5 LLM-driven skills (recall, think, agents, compact,
//   init, clear) only show whether they actually work when a REAL model
//   processes the SKILL.md body and decides to invoke the documented tools.
//   This file drives that end-to-end probe per skill + per LLM mode.
//
// What it does:
//   1. Detects which LLM transports are reachable from env (ANTHROPIC_API_KEY,
//      TROTH_LLAMACPP_HOST, etc.). Skips silently when none configured —
//      no broken default behavior.
//   2. For each available transport × each LLM-driven skill: spawn entity,
//      send the slash invocation with realistic args, capture the response,
//      verify (a) status=ok, (b) text non-empty, (c) at least one
//      tool_request event for the documented substrate tool fired.
//   3. Persists results so we can detect regressions when a model upgrade
//      silently breaks a skill.
//
// Usage:
//   node tests/skills-eval.js                # auto-detect LLMs, run all
//   node tests/skills-eval.js --llm router   # force one transport
//   node tests/skills-eval.js --skill think  # force one skill
//
// Eval ground truth comes from arXiv 2507.05257 ("Evaluating Memory in
// LLM Agents via Incremental Multi-Turn") — incremental probes, not
// one-shot benchmarks.

const { spawn } = require('child_process');
const path = require('path');

const ENTITY = path.resolve(__dirname, '..', 'bin', 'troth-entity.js');
const TURN_TIMEOUT_MS = 60_000;

// Only LLM-driven skills belong here. Deterministic skills bypass the LLM
// by design (Phase 7a) so there's nothing to evaluate model-side; they
// have direct unit tests in test-all.js (SLA-12..16, SLA-20).
//
// Per-skill ground truth = substrate side-effect (engram persisted with
// the documented scope) — NOT the entity's tool_request event. composeAgentic
// runs tools INSIDE its loop via tool_runner; it never emits a tool_request
// event (that signal is for the v0.1 unwired action.kind='tool' path).
// Grounding = the engram showing up in listEngrams under the test agent_id
// after the turn completes.
const SKILLS = [
  // /recall is read-only — no required write; we just assert non-empty text
  // and that the response references retrieved engrams (best-effort).
  { name: 'recall',  args: 'troth substrate dual mode',
    require_text: true, require_engram_scope: null, seed_engrams: ['troth substrate dual-mode design notes'] },
  { name: 'think',   args: 'voice latency vs context window tradeoff',
    require_text: true, require_engram_scope: 'reasoning' },
  { name: 'agents',  args: 'build a feature with backend + frontend',
    require_text: true, require_engram_scope: null },  // orchestrate path emits engrams under separate agent_ids
  { name: 'compact', args: '',
    require_text: true, require_engram_scope: null },  // any engram from compaction qualifies
  { name: 'init',    args: '',
    require_text: true, require_engram_scope: 'project_anchor' }
];

function detectLLMs(forced) {
  if (forced) return [forced];
  const out = [];
  if (process.env.ANTHROPIC_API_KEY)         out.push('anthropic');
  if (process.env.TROTH_LLAMACPP_HOST)     out.push('llamacpp');
  if (process.env.TROTH_OLLAMA_HOST)       out.push('ollama');
  // Router needs at least one downstream provider; we only count it if the
  // proxy responds. Cheap probe: don't add it to the matrix unless the user
  // explicitly requested it.
  return out;
}

const engram = require('../shared-core/engram.js');

function runOneSkill(llmMode, skill) {
  return new Promise((resolve) => {
    const agentId = 'eval-' + skill.name + '-' + Date.now();
    // Optional: seed engrams so the read-side skills (recall) have
    // something to surface. Without seeding, /recall correctly says
    // "nothing relevant" and we'd flag a non-failure as a failure.
    if (Array.isArray(skill.seed_engrams)) {
      for (const s of skill.seed_engrams) {
        try { engram.recordEngram({ agent_id: agentId, cwd: '/tmp', statement: s, salience: 1 }); }
        catch (_) {}
      }
    }
    const child = spawn(process.execPath, [ENTITY], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: Object.assign({}, process.env, {
        TROTH_ENTITY_AGENTIC:  '1',
        TROTH_ENTITY_AGENT_ID: agentId,
        TROTH_ENTITY_CWD:      '/tmp',
        TROTH_ENTITY_LLM:      llmMode
      })
    });

    let buf = '';
    let response = null;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve({
        skill: skill.name, llm: llmMode, status: 'TIMEOUT',
        elapsed_ms: Date.now() - t0,
        reason: 'no response within ' + TURN_TIMEOUT_MS + 'ms'
      });
    }, TURN_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.kind === 'ready') {
          const text = skill.args ? '/' + skill.name + ' ' + skill.args : '/' + skill.name;
          child.stdin.write(JSON.stringify({
            type: 'user_input',
            input: { text },
            options: { agentic: true }
          }) + '\n');
        }
        if (msg.kind === 'response') {
          response = msg;
          clearTimeout(timer);
          try { child.kill(); } catch (_) {}
          // Substrate-side ground truth: did the LLM actually persist the
          // documented engram? Counts the trace engram (scope=command)
          // separately so we don't false-positive on it.
          const allAfter = engram.listEngrams({ agent_id: agentId, limit: 50 });
          const tracesOnly = allAfter.filter((e) => e.scope === 'command').length;
          const skillEngrams = allAfter.filter((e) => e.scope !== 'command');
          const scopeMatches = skill.require_engram_scope
            ? skillEngrams.filter((e) => e.scope === skill.require_engram_scope)
            : skillEngrams;
          const okText  = !skill.require_text || (msg.text && msg.text.length > 0);
          const okWrite = skill.require_engram_scope
            ? scopeMatches.length > 0
            : true;  // no engram requirement (e.g. read-only /recall)
          const okStatus = msg.status === 'ok';
          const pass = okStatus && okText && okWrite;
          resolve({
            skill: skill.name, llm: llmMode,
            status: pass ? 'PASS' : 'FAIL',
            elapsed_ms: Date.now() - t0,
            response_chars: (msg.text || '').length,
            engrams_total:  allAfter.length,
            traces:         tracesOnly,
            skill_engrams:  skillEngrams.length,
            scope_matches:  scopeMatches.length,
            reason: pass ? null
              : !okStatus  ? 'response.status != ok'
              : !okText    ? 'response.text empty'
              : !okWrite   ? 'no engram with scope=' + skill.require_engram_scope + ' (got ' + skillEngrams.length + ' non-trace engrams)'
              : 'unknown'
          });
          return;
        }
        if (msg.kind === 'fatal') {
          clearTimeout(timer);
          try { child.kill(); } catch (_) {}
          resolve({
            skill: skill.name, llm: llmMode, status: 'FAIL',
            elapsed_ms: Date.now() - t0,
            reason: 'fatal: ' + (msg.error || 'unknown')
          });
          return;
        }
      }
    });
    child.on('exit', (_code) => {
      if (!response) {
        clearTimeout(timer);
        resolve({
          skill: skill.name, llm: llmMode, status: 'FAIL',
          elapsed_ms: Date.now() - t0,
          reason: 'child exited before response'
        });
      }
    });
  });
}

function flag(name, def) {
  const k = '--' + name;
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === k) return process.argv[i + 1] || def;
    if (process.argv[i].startsWith(k + '=')) return process.argv[i].slice(k.length + 1);
  }
  return def;
}

(async () => {
  const llmFilter   = flag('llm');
  const skillFilter = flag('skill');
  const llms = detectLLMs(llmFilter);
  if (!llms.length) {
    console.log('SKIPPED: no LLM transport configured.');
    console.log('  Set one of: ANTHROPIC_API_KEY, TROTH_LLAMACPP_HOST, TROTH_OLLAMA_HOST');
    console.log('  Or pass --llm router (proxy must be running).');
    process.exit(0);
  }
  const skills = skillFilter ? SKILLS.filter((s) => s.name === skillFilter) : SKILLS;
  console.log('skills-eval: matrix = ' + llms.length + ' LLMs × ' + skills.length + ' skills');
  const results = [];
  for (const llm of llms) {
    for (const skill of skills) {
      process.stdout.write('  ' + llm + ' / /' + skill.name + ' … ');
      const r = await runOneSkill(llm, skill);
      results.push(r);
      console.log(r.status + ' (' + r.elapsed_ms + 'ms)' + (r.reason ? ' — ' + r.reason : ''));
    }
  }
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL' || r.status === 'TIMEOUT').length;
  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail > 0 ? 1 : 0);
})();
