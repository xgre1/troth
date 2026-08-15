#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Constraint capture — the operator's "don't" becomes ledger state the moment
// it is said.
//
// UserPromptSubmit. Runs the trilingual freeze/lift detector from
// shared-core/constraint-ledger.js against the operator's message. A freeze
// writes an operator_constraint row and CONFIRMS it in additionalContext so
// the model (and the operator, expanding the hook output) can see the wall go
// up. A lift is fail-closed: it only releases freezes the detector can match
// to the operator's own words — a generic "go" never unlocks a scoped
// "I'll tell you when to push", and a negation near the verb never unlocks
// anything. Enforcement lives in the troth-bash server gate; this hook is the
// scribe that gives the gate something to enforce.
//
// Born 2026-08-15: an explicit "μην κάνεις τίποτα" was violated by a push a
// few turns later. The freeze had no row, so the gate had no state, so the
// wall did not exist. Never again — text does not bind, state does.

import { createRequire } from 'node:module';
import { readStdinJson, allow, addContext, log, recordAction } from './_lib.mjs';

const require = createRequire(import.meta.url);
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();

let ledger;
try { ledger = require(pluginRoot + '/../shared-core/constraint-ledger.js'); }
catch (_) { allow(); }

const payload = await readStdinJson();
const text = String(payload.prompt || '');
const session = payload.session_id || 'unknown';

// Only the OPERATOR's own words register or lift constraints. The second
// blind trial (2026-08-16) proved the hole live: a task-notification quoted
// a freeze verbatim ("...the operator said: 'min kaneis tipota'... Greek
// for 'don't do anything'") and this hook captured a PHANTOM freeze from a
// system turn no human wrote. Anything notification- or command-shaped is
// not a prompt — skip before the detector ever runs.
const NOT_OPERATOR = /\[SYSTEM NOTIFICATION - NOT USER INPUT\]|<task-notification>|<local-command-caveat>|<command-name>|<system-reminder>/;
if (NOT_OPERATOR.test(text)) { allow(); }

try {
  const freeze = ledger.detectFreeze(text);
  if (freeze) {
    const id = ledger.recordFreeze({ scope: freeze.scope, quote: freeze.quote, cwd: payload.cwd });
    log('UserPromptSubmit.constraint_capture', {
      session_id: session, decision: 'freeze', metadata: { id, scope: freeze.scope }
    });
    recordAction({
      type: 'decision', session_id: session, cwd: payload.cwd,
      input: { kind: 'constraint_capture', scope: freeze.scope, quote: freeze.quote },
      output: { decision: 'freeze', id }
    });
    addContext('[troth/constraint] FREEZE REGISTERED — the operator said: "' + freeze.quote +
      '" (scope: ' + freeze.scope + '). Outward actions in this scope are now BLOCKED at ' +
      'dispatch until the operator lifts it in fresh words. Do not infer permission from ' +
      'anything said before this line.');
  } else {
    const active = ledger.activeConstraints({});
    if (active.length) {
      const lifted = ledger.detectLift(text, active);
      for (const row of lifted) {
        ledger.recordLift(row.id, {
          scope: row.input && row.input.scope, quote: text.slice(0, 160), cwd: payload.cwd
        });
      }
      if (lifted.length) {
        log('UserPromptSubmit.constraint_capture', {
          session_id: session, decision: 'lift', metadata: { count: lifted.length }
        });
        addContext('[troth/constraint] LIFTED by the operator\'s words: ' +
          lifted.map(r => '"' + ((r.input && r.input.quote) || '') + '"').join(', ') +
          '. Remaining active freezes: ' + (active.length - lifted.length) + '.');
      }
    }
  }
} catch (_) { /* capture is best-effort; the gate reads whatever the ledger holds */ }

allow();
