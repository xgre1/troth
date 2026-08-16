// SPDX-License-Identifier: AGPL-3.0-only
// The sync op catalogue — the ALLOWLIST of substrate operations a paired
// device may perform over the network, each mapped onto the same one-road
// implementation every local surface already uses (engram.js, lesson.js,
// dialogue-memory.js, recall.js, substrate-tools.js). The full tool
// registry also holds world-acting tools (browser, api_call, repo writes);
// those are deliberately NOT here — the substrate endpoint moves memory,
// never hands.
//
// Per op:
//   kind       'write' ops are journaled events (gseq, watermark, replay-
//              idempotent); 'read' ops are plain queries, never journaled.
//   op_v       highest args-shape version this build understands. Args are
//              weak-schema JSON, additive-only: never rename, repurpose or
//              remove a field — a semantic change is a new op_v with an
//              upcaster, or a new op name. Strings, never enums, in synced
//              values: an unknown string quarantines, an unknown enum
//              crashes an old reader.
//   monotonic  CALM classification, recorded so an op cannot quietly change
//              class: monotonic ops are pure appends that would converge
//              even without the hub's total order; non-monotonic ones
//              (claim supersede, rule tombstone — later additions) lean on
//              gseq. The hub must learn a new op BEFORE any device is
//              allowed to emit it.
'use strict';

const OPS = {
  engram_record: {
    kind: 'write', op_v: 1, monotonic: true,
    run: async (args, ctx) => {
      const engram = require('../engram.js');
      let embedding = null;
      if (ctx.embedding_host) {
        try { embedding = await engram.embedRequest(ctx.embedding_host, String(args.statement || '')); }
        catch (_) { embedding = null; }
      }
      const id = engram.recordEngram({
        _local: true,
        id: typeof args.id === 'string' ? args.id : undefined,
        agent_id: ctx.agent_id,
        user_id:  ctx.user_id,
        cwd:      ctx.cwd,
        statement: args.statement,
        source: 'sync:' + (ctx.device_id || 'device'),
        salience: typeof args.salience === 'number' ? args.salience : 1.0,
        scope:    typeof args.scope === 'string' ? args.scope : undefined,
        audience: typeof args.audience === 'string' ? args.audience : undefined,
        embedding
      });
      return { ok: !!id, id, embedded: !!embedding };
    }
  },

  rule_record: {
    kind: 'write', op_v: 1, monotonic: false,
    run: async (args, ctx) => {
      const lesson = require('../lesson.js');
      return await lesson.recordRule({
        _local: true,
        text:    args.text,
        why:     args.why || null,
        scope:   args.scope === 'project' ? 'project' : 'global',
        cwd:     ctx.cwd || null,
        agent_id: ctx.agent_id,
        confirm: !!args.confirm,
        embedding_host: ctx.embedding_host || null
      });
    }
  },

  dialogue_turn: {
    kind: 'write', op_v: 1, monotonic: true,
    run: async (args, ctx) => {
      const dm = require('../dialogue-memory.js');
      const ok = dm.recordTurn({
        _local: true,
        id: typeof args.id === 'string' ? args.id : undefined,
        agent_id: ctx.agent_id,
        user_id:  ctx.user_id,
        cwd:      ctx.cwd,
        user_text:      args.user_text || '',
        assistant_text: args.assistant_text || '',
        faculty:         args.faculty || null,
        conversation_id: args.conversation_id || null,
        elapsed_ms:      args.elapsed_ms || null
      });
      // false covers both "duplicate inside the dedup window" and "substrate
      // unavailable"; neither changes what the device should do (nothing),
      // so one honest bit suffices.
      return { ok: true, recorded: !!ok };
    }
  },

  // Reads delegate to the same implementations the language faculty uses,
  // so remote recall and local recall cannot drift apart. The hub resolves
  // its OWN embedding host — a device never dictates where vectors come
  // from.
  recall: {
    kind: 'read', op_v: 1,
    run: (args, ctx) => {
      const recallMod = require('../recall.js');
      const a = Object.assign({}, args || {});
      delete a.embedding_host;
      return recallMod.recall(Object.assign(a, { _local: true, agent_id: ctx.agent_id || a.agent_id, cwd: ctx.cwd || a.cwd }));
    }
  },
  engram_search:   { kind: 'read', op_v: 1, run: (a, c) => _registryRun('engram_search', a, c) },
  dialogue_recent: { kind: 'read', op_v: 1, run: (a, c) => _registryRun('dialogue_recent', a, c) },
  dialogue_search: { kind: 'read', op_v: 1, run: (a, c) => _registryRun('dialogue_search', a, c) },
  rule_list:       { kind: 'read', op_v: 1, run: (a, c) => _registryRun('rule_list', a, c) }
};

function _registryRun(name, args, ctx) {
  const { REGISTRY } = require('../substrate-tools.js');
  const entry = REGISTRY[name];
  if (!entry) throw new Error('registry_missing:' + name);
  return entry.run(args || {}, Object.assign({ _local: true }, ctx || {}));
}

// Typed resolution. An unknown name and a future arg-shape are DIFFERENT
// failures with different remedies (teach the hub the op vs update this
// build), so they answer by name instead of collapsing into one error.
function getOp(op, op_v) {
  const entry = OPS[op];
  if (!entry) return { error: 'version_not_supported', versionType: 'op', op };
  const v = Number.isInteger(op_v) ? op_v : 1;
  if (v > entry.op_v) {
    return { error: 'version_not_supported', versionType: 'op_v', op, supported: entry.op_v, requested: v };
  }
  return { entry };
}

function describe() {
  const out = {};
  for (const name of Object.keys(OPS)) out[name] = { kind: OPS[name].kind, op_v: OPS[name].op_v };
  return out;
}

module.exports = { OPS, getOp, describe };
