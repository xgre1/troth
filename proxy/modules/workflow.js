// SPDX-License-Identifier: AGPL-3.0-only
// Workflow state machine — Cursor-style persistent task state.
//
// Research [Plan]: Cursor uses workflow_state.md + project_config.md to track
// where the agent is in a multi-step task. State persists across turns so the
// agent doesn't lose track of "where am I in the plan?" mid-task.
//
// We persist state to .troth/workflow.json in the project dir.
//   {
//     "task": "build user profile feature",
//     "phase": "implementing", // planning | implementing | verifying | done
//     "plan": "Architect-generated plan text",
//     "completed_steps": ["read users.js", "added /profile route"],
//     "pending_steps": ["add tests", "run npm test"],
//     "started_at": ms,
//     "last_update_at": ms
//   }
//
// State is reset when:
//   - User sends a new top-level task (different from current)
//   - Idle > 1 hour (treated as new session)
//   - phase becomes "done"

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectDir = process.env.GF_WATCH_DIR || process.cwd();
const STATE_FILE = path.join(projectDir, '.troth', 'workflow.json');
const IDLE_RESET_MS = 60 * 60 * 1000;

let state = null;

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Reset if idle too long
    if (Date.now() - (data.last_update_at || 0) > IDLE_RESET_MS) return null;
    return data;
  } catch (e) { return null; }
}

function save(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {}
}

function clear() {
  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (e) {}
  state = null;
}

function taskHash(taskText) {
  return crypto.createHash('sha256').update((taskText || '').slice(0, 500)).digest('hex').slice(0, 12);
}

// Called when a new task is detected. Initialize or update state.
function startTask(taskText, plan) {
  const hash = taskHash(taskText);
  const existing = load();
  if (existing && existing.task_hash === hash) {
    // Same task — keep state, just update timestamp
    existing.last_update_at = Date.now();
    if (plan && !existing.plan) existing.plan = plan;
    state = existing;
    save(state);
    return state;
  }
  // New task — fresh state
  state = {
    task: (taskText || '').slice(0, 200),
    task_hash: hash,
    phase: plan ? 'implementing' : 'planning',
    plan: plan || null,
    completed_steps: [],
    pending_steps: plan ? extractStepsFromPlan(plan) : [],
    started_at: Date.now(),
    last_update_at: Date.now(),
  };
  save(state);
  return state;
}

function extractStepsFromPlan(planText) {
  if (!planText) return [];
  const steps = [];
  const lines = planText.split('\n');
  let inSteps = false;
  for (const line of lines) {
    if (/^##\s*Steps/i.test(line.trim())) { inSteps = true; continue; }
    if (inSteps && /^##\s/.test(line.trim())) break;
    if (inSteps) {
      const m = line.match(/^\s*(?:\d+\.|\-)\s+(.+)/);
      if (m) steps.push(m[1].trim());
    }
  }
  return steps;
}

// DAG construction (research [Plan] Devin pattern):
// Detect step dependencies via keyword matching:
//   - "after X", "depends on X", "requires X" → dep on X
//   - Steps mentioning the same file are likely sequential
//   - "in parallel", "concurrently" → mark as parallelizable
// Returns: { nodes: [{id, text, deps}], parallelGroups: [[id,id], ...] }
function buildPlanDAG(planText) {
  const steps = extractStepsFromPlan(planText);
  const nodes = steps.map((text, i) => ({ id: i + 1, text, deps: [] }));

  for (let i = 0; i < nodes.length; i++) {
    const text = nodes[i].text.toLowerCase();
    // Explicit dependency markers
    const depMatch = text.match(/(?:after|depends on|requires?|once)\s+(?:step\s+)?(\d+)/);
    if (depMatch) {
      const depNum = parseInt(depMatch[1]);
      if (depNum > 0 && depNum <= nodes.length && depNum !== nodes[i].id) {
        nodes[i].deps.push(depNum);
      }
    }
    // File-based sequential dependency (if step mentions same file as prior)
    const fileRefs = text.match(/[\w/-]+\.[a-z]{2,4}/g) || [];
    if (fileRefs.length && i > 0) {
      for (let j = 0; j < i; j++) {
        const priorRefs = nodes[j].text.toLowerCase().match(/[\w/-]+\.[a-z]{2,4}/g) || [];
        const overlap = fileRefs.some(f => priorRefs.includes(f));
        if (overlap && !nodes[i].deps.includes(nodes[j].id)) {
          nodes[i].deps.push(nodes[j].id);
        }
      }
    }
  }

  // Parallelizable groups: steps with no shared deps and explicitly marked, or
  // independent of each other (no overlapping deps, no overlapping files)
  const parallelGroups = [];
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i].text.toLowerCase();
    if (/in parallel|concurrently|simultaneously/.test(t)) {
      // Find peer steps (sibling deps)
      const group = [nodes[i].id];
      for (let j = i + 1; j < nodes.length; j++) {
        const t2 = nodes[j].text.toLowerCase();
        if (/in parallel|concurrently|simultaneously/.test(t2) &&
            JSON.stringify(nodes[j].deps.sort()) === JSON.stringify(nodes[i].deps.sort())) {
          group.push(nodes[j].id);
        }
      }
      if (group.length >= 2) parallelGroups.push(group);
    }
  }

  return { nodes, parallelGroups };
}

// Mark a step as completed (called from critic when matching tool action observed)
function markStepCompleted(stepDesc) {
  if (!state) state = load();
  if (!state) return;
  state.completed_steps.push(stepDesc);
  state.pending_steps = state.pending_steps.filter(s => s.toLowerCase() !== stepDesc.toLowerCase());
  state.last_update_at = Date.now();
  save(state);
}

function setPhase(phase) {
  if (!state) state = load();
  if (!state) return;
  state.phase = phase;
  state.last_update_at = Date.now();
  if (phase === 'done') { clear(); return; }
  save(state);
}

// Build injection block for the system prompt
function buildStateBlock() {
  if (!state) state = load();
  if (!state) return null;
  const completed = state.completed_steps.length ?
    state.completed_steps.slice(-5).map(s => '- [x] ' + s).join('\n') : '- (none yet)';
  const pending = state.pending_steps.length ?
    state.pending_steps.slice(0, 5).map(s => '- [ ] ' + s).join('\n') : '- (none queued)';
  return `## Workflow State (mid-task — continue from here)
Task: ${state.task}
Phase: ${state.phase}

Completed:
${completed}

Pending:
${pending}

Resume the task. Don't restart planning unless the task changed.`;
}

function getState() {
  if (!state) state = load();
  return state;
}

module.exports = { startTask, markStepCompleted, setPhase, buildStateBlock, getState, clear, buildPlanDAG };
