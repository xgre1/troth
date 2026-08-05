// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// control-audit — factory for the control-channel audit callback.
//
// Tees every control-channel boundary event (kind=control_channel.*) into
// (a) a substrate engram (existing behaviour, soft / discardable, observable
//     via /recall and the live-view ring), and
// (b) the tamper-evident signed-audit chain (shared-core/signed-audit.js),
//     restricted to ACTION events — dispatched and handler_threw. The chain
//     is the operator's structural proof per design R17: "operator can
//     prove tamper to a third party without trusting the substrate."
//
// Why a factory: bin/troth-entity.js previously inlined this as a closure,
// which made signed-audit-on-dispatch impossible to test without booting the
// full entity. Extracting it keeps the layering thin and makes
// tests/signed-audit-dispatch.test.js a unit test, not a process test.

const DEFAULT_SIGNED_KINDS = new Set([
  'control_channel.dispatched',
  'control_channel.handler_threw'
]);

function makeControlAudit(opts) {
  opts = opts || {};
  const recordEngram = opts.recordEngram;
  const signedAudit  = opts.signedAudit || null;
  const signedKinds  = opts.signedKinds
    ? new Set(opts.signedKinds)
    : DEFAULT_SIGNED_KINDS;
  const AGENT_ID = opts.agent_id;
  const CWD      = opts.cwd;
  const USER_ID  = opts.user_id;
  const keyDir   = opts.signed_audit_key_dir; // optional override (tests)

  return function audit(kind, fields) {
    fields = fields || {};
    try {
      if (recordEngram) {
        recordEngram({
          agent_id: AGENT_ID, cwd: CWD, user_id: USER_ID,
          statement: kind + (fields.scope ? ' (' + fields.scope + ')' : ''),
          scope:  'internal:control_channel_audit',
          source: kind
        });
      }
    } catch (_) { /* engram audit best-effort */ }

    if (signedAudit && signedKinds.has(kind)) {
      const record = {
        kind,
        scope: fields.scope || null,
        ok:    fields.ok === undefined ? null : !!fields.ok,
        err:   fields.err || null,
        ts:    Date.now()
      };
      // Fire-and-forget: a key-dir IO failure must not break dispatch.
      // signed-audit.signAndAppend returns a promise that rejects on
      // unrecoverable errors; we swallow so the channel stays up.
      Promise.resolve()
        .then(() => signedAudit.signAndAppend({
          record,
          action_id: null,
          kind,
          key_dir: keyDir || undefined
        }))
        .catch(() => { /* signed audit best-effort */ });
    }
  };
}

module.exports = { makeControlAudit, DEFAULT_SIGNED_KINDS };
