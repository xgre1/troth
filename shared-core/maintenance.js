// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The maintenance worker: the upkeep every install needs even when no
// entity daemon runs — the embedding drain, the document drain, the chat
// import, the backup, the WAL replica, the ledger's own hygiene — and,
// unless switched off, the memory's understanding tasks. One list and one
// start road, shared by the process that hosts the worker (bin/
// troth-maintenance.js, a child the proxy keeps alive beside its loop) and
// by the in-process fallback the proxy uses when told to keep it inside.
const bw = require('./background-worker.js');

// TROTH_UNDERSTANDING=0 keeps the understanding tasks out.
function taskList(env) {
  env = env || process.env;
  const upkeep = [bw.tasks.embeddingBackfill, bw.tasks.knowledgeDrain, bw.tasks.outcomeFold, bw.tasks.importSync, bw.tasks.backup, bw.tasks.walReplicate, bw.tasks.ledgerPrune, bw.tasks.carriedFreeze];
  const understanding = env.TROTH_UNDERSTANDING === '0' ? [] : [bw.tasks.workingMemoryConsolidation, bw.tasks.instanceConsolidation, bw.tasks.memoryHygiene, bw.tasks.knowledgeUnderstanding];
  return upkeep.concat(understanding);
}

// Starts the worker in THIS process and returns its handle. opts.notify(n)
// receives each task's notes; opts.agent_id is the id the understanding
// tasks write under (the operator's own, the same id the session watcher
// records dialogue turns under, so what the memory understands lands
// where recall reads).
function start(opts) {
  opts = opts || {};
  const state = require('./state.js');
  const ar = require('./action-record.js');
  const { resolveAgentId } = require('./agent-id.js');
  return bw.startWorker({
    tasks: opts.tasks || taskList(opts.env),
    cross_process_lease: true,
    idle_threshold_ms: Math.max(parseInt(process.env.TROTH_MAINT_IDLE_MS || '60000', 10) || 60000, 0),
    tick_ms: Math.max(parseInt(process.env.TROTH_MAINT_TICK_MS || '30000', 10) || 30000, 250),
    submit: (ev) => {
      // The ledger row (and only that) lands, so readiness gets a heartbeat
      // and the lease binds across processes. operational/substrate_internal
      // keeps these OUT of every recall pool.
      try {
        if (!ev || ev.type !== 'decision') return;
        const rec = {
          id: ar.uuidv7(), timestamp: Date.now(), type: 'decision',
          agent_id: 'maintenance', user_id: 'default', cwd: null,
          memory_class: 'operational', audience: 'substrate_internal',
          input: ev.input || {}, output: ev.output || {}
        };
        const v = ar.validate(rec);
        if (v && v.ok) state.recordAction(rec, ar.toSearchText(rec));
      } catch (_) { /* best-effort */ }
    },
    getView: () => view(opts),
    notify: typeof opts.notify === 'function' ? opts.notify : null
  });
}

// The view a task runs against: the substrate context of this machine's
// partner, the same for a ticked run and a run asked for by name.
function view(opts) {
  const { resolveAgentId } = require('./agent-id.js');
  return { substrate_ctx: { agent_id: (opts && opts.agent_id) || resolveAgentId(), user_id: 'default', cwd: null } };
}

module.exports = { taskList, start, view };
