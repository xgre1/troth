#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Mind layer — Stop hook companion that persists a refreshed
// mind-state snapshot at turn end. Most sessions never hit the
// PreCompact threshold; without a Stop-side persist, those sessions
// don't update mind state and the next session-start loads stale
// orientation.
//
// Same recompute logic as pre-compact.mjs uses: latest snapshot +
// recent intent records + recent mind_decision events folded into
// project.key_decisions. Failures are non-fatal; we never block the
// Stop the agent needs.
//
// Default ON. Opt out via env TROTH_STOP_MIND_PERSIST=0.

import { createRequire } from 'node:module';
import { readStdinJson, allow, log } from './_lib.mjs';

if (process.env.TROTH_STOP_MIND_PERSIST === '0') { allow(); }

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
let stateModule; // fail-open: bare marketplace clone has no node_modules
try { stateModule = require(pluginRoot + '/../shared-core/state.js'); } catch (_) { console.log('{}'); process.exit(0); }
let actionRec; // fail-open: bare marketplace clone has no node_modules
try { actionRec = require(pluginRoot + '/../shared-core/action-record.js'); } catch (_) { console.log('{}'); process.exit(0); }
let mindState; // fail-open: bare marketplace clone has no node_modules
try { mindState = require(pluginRoot + '/../shared-core/mind-state.js'); } catch (_) { console.log('{}'); process.exit(0); }
const payload = await readStdinJson();
const session_id = payload.session_id || null;
const cwd        = payload.cwd || process.cwd();

try {
  // No agent_id filter on the read side — mind state is unified per
  // cwd across writers (CLI bootstrap, hooks, MCP). Filtering by
  // 'claude-code' alone would drop CLI-written snapshots and re-emit
  // an empty state, wiping projects the user just bootstrapped.
  const view = mindState.recomputeFromSubstrate(stateModule, { cwd });
  if (view && view.mind_state) {
    // Deduplicate: only persist when content actually changed.
    // Without this guard, every Stop fires a near-identical snapshot
    // and bloats the substrate (N turns × per-cwd). Compare the new
    // view against the prev snapshot loaded inside recompute.
    let prevState = null;
    if (view.prev_snapshot_id) {
      const prevRow = stateModule.getAction(view.prev_snapshot_id);
      const prevRec = prevRow ? actionRec.fromRow(prevRow) : null;
      prevState = prevRec && prevRec.output && prevRec.output.mind_state;
    }
    if (prevState && !mindState.hasMeaningfulChanges(prevState, view.mind_state)) {
      log('Stop.mind.skip', {
        session_id,
        decision: 'skipped',
        reason: 'no_meaningful_change',
        metadata: { prev: view.prev_snapshot_id }
      });
      allow();
    }

    const built = mindState.buildSnapshotRecord({
      id: require('crypto').randomUUID(),
      timestamp: Date.now(),
      agent_id: 'claude-code',
      cwd,
      mind_state: view.mind_state,
      trigger: 'stop',
      prev_snapshot_id: view.prev_snapshot_id
    });
    if (built.ok) {
      const validation = actionRec.validate(built.record);
      if (validation.ok) {
        const writtenId = stateModule.recordAction(built.record, actionRec.toSearchText(built.record));
        log('Stop.mind.persist', {
          session_id,
          decision: writtenId ? 'persisted' : 'write_failed',
          metadata: {
            snapshot_id: writtenId,
            intents_seen: view.intents_seen,
            decisions_seen: view.decisions_seen,
            prev: view.prev_snapshot_id
          }
        });
      } else {
        log('Stop.mind.error', { session_id, reason: 'action_record_invalid', metadata: { errors: validation.errors } });
      }
    } else {
      log('Stop.mind.error', { session_id, reason: 'snapshot_build_failed', metadata: { errors: built.errors } });
    }
  }
} catch (e) {
  log('Stop.mind.error', { session_id, reason: 'mind_persist_threw', metadata: { message: String(e && e.message || e) } });
}

// Stop hook contract: emit empty {} to allow normal stop semantics.
// (allow() emits {} via emit(), which exits via process.exit(0).)
allow();
