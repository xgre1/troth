// SPDX-License-Identifier: AGPL-3.0-only
// Role registry — declarative role → transport + system prompt mapping.
//
// Project-local `.troth/roles.json` overrides the global
// `~/.troth/roles.json` which itself overrides BUILTIN_ROLES below.
// Loader is pure JSON; no eval, no yaml, no schema bloat.
//
// Schema per role:
//   {
//     transport_hint: 'router' | 'anthropic' | 'llamacpp' | 'ollama',
//     model_pref:     'qwen3-max' | 'claude-sonnet-4-6' | 'gemma-4-31b' | ...,
//     system_prompt:  string,
//     capabilities:   string[]  // 'network' | 'write' | 'read'
//   }
//
// All fields optional. Missing fields fall through to dispatch defaults
// (router fallback chain) and the empty system prompt.
//
// Why JSON not YAML: zero deps, every editor highlights it, every CI
// validates it for free. Why no eval: roles.json is a security surface;
// a worker decides which LLM and which capabilities based on it. Pure
// data.

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const PROJECT_LOCAL_REL = path.join('.troth', 'roles.json');
const GLOBAL_PATH = path.join(HOME, '.troth', 'roles.json');

// Sane defaults the orchestrator can always lean on. Every role here is
// a starting point; real projects override per-cwd via `.troth/roles.json`.
const BUILTIN_ROLES = Object.freeze({
  backend: {
    transport_hint: 'router',
    model_pref: 'qwen3-max',
    system_prompt:
      'You are the BACKEND specialist. Implement server-side logic, APIs, ' +
      'database schemas, migrations. Write tested code. Stay in /server ' +
      'and /api directories unless the task explicitly says otherwise.',
    capabilities: ['network', 'write']
  },
  frontend: {
    transport_hint: 'anthropic',
    model_pref: 'claude-sonnet-4-6',
    system_prompt:
      'You are the FRONTEND specialist. Implement UI components, styling, ' +
      'and client-side state. Stay in /src, /components, /pages unless ' +
      'the task explicitly says otherwise.',
    capabilities: ['network', 'write']
  },
  qa: {
    transport_hint: 'llamacpp',
    model_pref: 'gemma-4-31b',
    system_prompt:
      'You are the QA specialist. Read existing code and tests, write new ' +
      'tests, run the test suite, report regressions. Do NOT modify ' +
      'production code — only test files.',
    capabilities: ['write']
  },
  designer: {
    transport_hint: 'anthropic',
    model_pref: 'claude-sonnet-4-6',
    system_prompt:
      'You are the DESIGNER specialist. Make visual + UX decisions: ' +
      'spacing, typography, color, micro-interactions. Edit CSS / Tailwind ' +
      'classes / SVG / design tokens. Do not change business logic.',
    capabilities: ['write']
  },
  researcher: {
    transport_hint: 'router',
    model_pref: 'claude-sonnet-4-6',
    system_prompt:
      'You are the RESEARCHER. Read the codebase, search the web, ' +
      'summarize findings into engrams. Do NOT modify any files. Output ' +
      'is structured engram_record calls.',
    capabilities: ['network']
  }
});

function _safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}
  return null;
}

function loadRoles(cwd) {
  cwd = cwd || process.cwd();
  const projectFile = path.join(cwd, PROJECT_LOCAL_REL);
  const projectRoles = _safeReadJson(projectFile)  || {};
  const globalRoles  = _safeReadJson(GLOBAL_PATH)  || {};
  // Merge order: builtin < global < project. Later wins on key conflict.
  return Object.assign({}, BUILTIN_ROLES, globalRoles, projectRoles);
}

function getRole(name, cwd) {
  if (!name) return null;
  const all = loadRoles(cwd);
  return all[name] || null;
}

function listRoles(cwd) {
  return Object.keys(loadRoles(cwd));
}

// Validate a role definition has the minimum shape the supervisor needs.
// Returns { ok, errors }.
function validateRole(role) {
  const errors = [];
  if (!role || typeof role !== 'object') return { ok: false, errors: [{ kind: 'not_object' }] };
  if (role.transport_hint && typeof role.transport_hint !== 'string') {
    errors.push({ kind: 'bad_field', field: 'transport_hint' });
  }
  if (role.capabilities && !Array.isArray(role.capabilities)) {
    errors.push({ kind: 'bad_field', field: 'capabilities' });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  loadRoles,
  getRole,
  listRoles,
  validateRole,
  BUILTIN_ROLES,
  PROJECT_LOCAL_REL,
  GLOBAL_PATH
};
