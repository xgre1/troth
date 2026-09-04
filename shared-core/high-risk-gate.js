// SPDX-License-Identifier: AGPL-3.0-only High-risk action confirmation gate.
// Some actions aren't destructive enough to hard-refuse (Wall 1 refusal
// taxonomy) but are consequential enough that the operator should approve
// before the substrate does them autonomously: - git push (publishes code) -
// package install (pulls + runs untrusted code) - write to ~/.ssh (auth
// surface change) - write to dotfiles (environment change) - delete > N files
// (bulk loss risk) - money tx (financial) - send email / SMS (external
// communication) - signup new domain (account creation) Regime-aware: -
// sandbox regime → auto-approve (low blast radius) - host regime →
// require-confirm (real blast radius) Pattern: tool returns refused with
// reason='awaiting_operator_approval' + request_id. Operator resolves via
// existing operator_request inbox. Partner polls / sees on next turn. NOT
// literal thread-block (Node single-threaded; would deadlock everything).
// Distinct from refusal-taxonomy.js HARD_CATEGORIES which REJECT (no operator
// path). This module is the SOFT-confirm tier. - confirmation is STRUCTURAL —
// substrate refuses to proceed without recorded operator approval; not a
// prompt rule - out-of-process operator gate (Knight Capital pattern
// humans-in-the-loop for high-blast-radius actions) - Common practice:
// deploy-tool confirmations (Vercel CLI, Kubernetes kubectl --confirm,
// Terraform apply gate)

'use strict';

const state = require('./state.js');

const CATEGORIES = Object.freeze({
  GIT_PUSH:       'git_push',
  PKG_INSTALL:    'pkg_install',
  SSH_WRITE:      'ssh_write',
  DOTFILE_WRITE:  'dotfile_write',
  DELETE_MANY:    'delete_many',
  MONEY_TX:       'money_tx',
  SEND_EMAIL:     'send_email',
  SEND_SMS:       'send_sms',
  SIGNUP_DOMAIN:  'signup_domain'
});

const DEFAULT_DELETE_MANY_THRESHOLD = 5;

// Pattern matchers — first-match wins. Patterns are RegExp or function
// (action, ctx) => bool. Each entry: { category, match, why }.
const PATTERNS = [
  { category: CATEGORIES.GIT_PUSH,
    match: /\bgit\s+push\b/i,
    why: 'git push publishes commits; reversible only by force-push or revert' },
  { category: CATEGORIES.PKG_INSTALL,
    match: /\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b|\bpip\s+install\b|\bbrew\s+install\b|\bgem\s+install\b|\bcargo\s+install\b/i,
    why: 'package install pulls + executes external code from registry' },
  { category: CATEGORIES.SSH_WRITE,
    match: /(\~|\$HOME|\/Users\/[^\/]+|\/home\/[^\/]+)\/\.ssh\b/i,
    why: '~/.ssh changes affect every host authentication; critical credential surface' },
  { category: CATEGORIES.DOTFILE_WRITE,
    match: /(\~|\$HOME|\/Users\/[^\/]+|\/home\/[^\/]+)\/\.[a-z][a-z0-9_-]+(rc|profile|zsh|bash|env|tool-versions)\b/i,
    why: 'dotfile changes affect shell environment globally; subtle scope' },
  { category: CATEGORIES.SEND_EMAIL,
    match: /\b(gmail_send|email_send|sendmail|mailx|smtp)\b/i,
    why: 'email send is external + irreversible delivery' },
  { category: CATEGORIES.SEND_SMS,
    match: /\b(twilio_sms_send|sms_send)\b/i,
    why: 'SMS is external + irreversible + per-message cost' },
  { category: CATEGORIES.MONEY_TX,
    match: /\b(stripe_create_charge|payment_create|transfer|payout|request_payment)\b/i,
    why: 'money transfer is irreversible without dispute process' },
  { category: CATEGORIES.SIGNUP_DOMAIN,
    match: /\b(register_domain|namecheap_create|godaddy_purchase|domain_purchase)\b/i,
    why: 'domain registration is annual cost + identity surface' }
];

// Classify a single action string + context.
//   action: { command?: string, tool?: string, args?: object }
//   ctx:    { regime?: 'sandbox'|'host' }
function classifyHighRisk(action, ctx) {
  if (!action) return { matched: false, reasons: [] };
  const haystack = [
    action.command || '',
    action.tool || '',
    action.args ? JSON.stringify(action.args) : ''
  ].join(' ');

  const matched = [];
  for (const pat of PATTERNS) {
    if (pat.match instanceof RegExp) {
      if (pat.match.test(haystack)) matched.push({ category: pat.category, why: pat.why });
    } else if (typeof pat.match === 'function') {
      if (pat.match(action, ctx)) matched.push({ category: pat.category, why: pat.why });
    }
  }

  // Function-based DELETE_MANY: needs args inspection (e.g., file count)
  if (typeof action.args === 'object' && action.args) {
    const threshold = (ctx && ctx.delete_many_threshold) || DEFAULT_DELETE_MANY_THRESHOLD;
    if (Array.isArray(action.args.files) && action.args.files.length >= threshold) {
      matched.push({ category: CATEGORIES.DELETE_MANY, why: 'bulk delete >= ' + threshold + ' files' });
    }
    if (typeof action.args.delete_count === 'number' && action.args.delete_count >= threshold) {
      matched.push({ category: CATEGORIES.DELETE_MANY, why: 'delete_count >= ' + threshold });
    }
  }

  return {
    matched:    matched.length > 0,
    categories: matched.map(m => m.category),
    reasons:    matched
  };
}

// Decide whether to gate. Returns:
//   { decision: 'pass' | 'auto_approve' | 'require_confirm',
//     classification, regime, operator_request_payload? }
function decideGate(action, ctx) {
  ctx = ctx || {};
  const classification = classifyHighRisk(action, ctx);
  if (!classification.matched) {
    return { decision: 'pass', classification, regime: ctx.regime || 'host' };
  }
  const regime = ctx.regime || 'host';
  if (regime === 'sandbox') {
    return {
      decision: 'auto_approve',
      classification,
      regime,
      reason: 'sandbox_regime_auto_approve'
    };
  }
  // Host regime → require confirm
  return {
    decision: 'require_confirm',
    classification,
    regime,
    operator_request_payload: {
      kind:    'approval',
      urgency: 'high',
      detail: {
        action_summary: (action && (action.command || action.tool)) || 'unknown',
        categories:     classification.categories,
        reasons:        classification.reasons,
        goal_id:        ctx.goal_id || null,
        goal_class:     ctx.goal_class || null,
        regime:         regime
      }
    }
  };
}

// File the operator_request via existing state.recordOperatorRequest.
// Returns { request_id, ok, decision }.
function fileForConfirmation(action, ctx) {
  const gate = decideGate(action, ctx);
  if (gate.decision !== 'require_confirm') {
    return { ok: true, decision: gate.decision, classification: gate.classification };
  }
  let requestId = null;
  try {
    if (typeof state.recordOperatorRequest === 'function') {
      const r = state.recordOperatorRequest({
        goal_id:    (ctx && ctx.goal_id) || null,
        goal_class: (ctx && ctx.goal_class) || null,
        kind:       gate.operator_request_payload.kind,
        urgency:    gate.operator_request_payload.urgency,
        detail:     gate.operator_request_payload.detail
      });
      requestId = (r && typeof r === 'object') ? (r.id || null) : r;
    }
  } catch (_) {}
  return {
    ok:             !!requestId,
    decision:       gate.decision,
    request_id:     requestId,
    classification: gate.classification,
    regime:         gate.regime,
    refused:        true,
    reason:         'awaiting_operator_approval',
    detail:         'High-risk action: ' + gate.classification.categories.join(',') +
                    '. Operator must approve via inbox (request_id=' + (requestId || 'unrecorded') + ').'
  };
}

module.exports = {
  classifyHighRisk,
  decideGate,
  fileForConfirmation,
  CATEGORIES,
  PATTERNS,
  DEFAULT_DELETE_MANY_THRESHOLD
};
