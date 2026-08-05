// SPDX-License-Identifier: AGPL-3.0-only
// Engram schemas (substrate-as-perception browser).
// Component 8.
//
// These are not Joi/Zod runtime validators (kept light) — they're
// canonical SHAPES the perception observer + action dispatcher build
// before writing to substrate's engram store. The substrate's existing
// engram audience/class taxonomy is honored: 'external' for what came
// from the web, 'substrate_internal' for vault receipts (so they're
// never exposed to model context), 'external_suspicious' for things
// the sanitization gate flagged.

'use strict';

const crypto = require('crypto');

function _hash(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex').slice(0, 16);
}

function pageVisit({ url, title, ts, ax_node_count, semantic_summary, ax_graph_text }) {
  return {
    class:    'page_visit',
    scope:    'browser:page_visit',
    audience: 'external',
    statement: 'visited ' + (title || url),
    payload: {
      url,
      title:          title || null,
      ts:             ts || Date.now(),
      ax_node_count:  ax_node_count || 0,
      semantic_summary: semantic_summary || null,
      ax_graph_hash:  ax_graph_text ? _hash(ax_graph_text) : null,
    },
  };
}

function perceptionEvent({ kind, payload, ts }) {
  return {
    class:    'perception_event',
    scope:    'browser:perception_event:' + kind,
    audience: 'external',
    statement: 'perception event ' + kind,
    payload: {
      kind,                          // 'mutation' | 'navigation' | 'error' | 'console' | 'network'
      payload: payload || {},
      ts: ts || Date.now(),
    },
  };
}

function fieldCapture({ url, form_selector, field_count, field_types, ts }) {
  return {
    class:    'field_capture',
    scope:    'browser:field_capture',
    audience: 'external',
    statement: 'form detected at ' + (form_selector || 'unknown') + ' on ' + url,
    payload: {
      url,
      form_selector: form_selector || null,
      field_count:   field_count || 0,
      field_types:   field_types || [],
      ts: ts || Date.now(),
    },
  };
}

function actionResult({ intent_id, ax_diff_summary, network_summary, completion_state, duration_ms, ts }) {
  return {
    class:    'action_result',
    scope:    'browser:action_result',
    audience: 'external',
    statement: 'action ' + intent_id + ' → ' + (completion_state || 'unknown'),
    payload: {
      intent_id,
      ax_diff_summary:  ax_diff_summary || null,
      network_summary:  network_summary || null,
      completion_state: completion_state || 'unknown',
      duration_ms:      duration_ms || 0,
      ts: ts || Date.now(),
    },
  };
}

// vault_capture_event: written when capture_to_vault fires. Records
// what was captured (key + bytes_len), NEVER the value itself.
function vaultCaptureEvent({ vault_key, capability_scope_glob, source_url, source_selector, bytes_len, ts }) {
  return {
    class:    'vault_capture_event',
    scope:    'browser:vault_capture',
    audience: 'substrate_internal',
    statement: 'captured to vault key ' + vault_key + ' (' + bytes_len + ' bytes)',
    payload: {
      vault_key,
      capability_scope_glob,
      source_url:      source_url || null,
      source_selector: source_selector || null,
      bytes_len:       bytes_len || 0,
      ts: ts || Date.now(),
    },
  };
}

// session_cookie_injection: vault-bridge wrote N cookies into the
// browser before a navigation. Bytes never recorded.
function sessionCookieInjection({ host, vault_key, cookie_count, ts }) {
  return {
    class:    'session_cookie_injection',
    scope:    'browser:session_cookie_injection',
    audience: 'substrate_internal',
    statement: 'injected ' + cookie_count + ' cookies for ' + host,
    payload: {
      host,
      vault_key,
      cookie_count: cookie_count || 0,
      ts: ts || Date.now(),
    },
  };
}

// Flagged-content engram for sanitization-gate hits. Substance is in
// the original engram (e.g. page_visit) marked external_suspicious;
// this engram records WHAT triggered.
function externalSuspicious({ source_engram_class, strip_rules_triggered, original_size, sanitized_size, ts }) {
  return {
    class:    'external_suspicious',
    scope:    'browser:external_suspicious',
    audience: 'external_suspicious',
    statement: 'sanitization flagged content (' + (strip_rules_triggered || []).join(',') + ')',
    payload: {
      source_engram_class,
      strip_rules_triggered: strip_rules_triggered || [],
      original_size:  original_size  || 0,
      sanitized_size: sanitized_size || 0,
      ts: ts || Date.now(),
    },
  };
}

// WebMCP discovery: site declares agent tools at /.well-known/webmcp.json.
function webmcpSiteCapabilities({ host, capabilities, ts }) {
  return {
    class:    'webmcp_site_capabilities',
    scope:    'browser:webmcp_capabilities',
    audience: 'external',
    statement: 'webmcp tools at ' + host + ': ' + (capabilities || []).length,
    payload: {
      host,
      capabilities: capabilities || [],
      ts: ts || Date.now(),
    },
  };
}

// operator_surface:browser_pause — partner hit CAPTCHA/2FA, waiting.
function operatorSurfaceBrowserPause({ cell_id, url, reason, page_state_engram_id, ttl_seconds, ts }) {
  return {
    class:    'operator_surface:browser_pause',
    scope:    'browser:operator_pause',
    audience: 'operator',
    statement: 'browser cell paused: ' + reason + ' at ' + url,
    payload: {
      cell_id,
      url,
      reason,
      page_state_engram_id: page_state_engram_id || null,
      ttl_seconds:          ttl_seconds || 600,
      ts: ts || Date.now(),
    },
  };
}

module.exports = {
  pageVisit,
  perceptionEvent,
  fieldCapture,
  actionResult,
  vaultCaptureEvent,
  sessionCookieInjection,
  externalSuspicious,
  webmcpSiteCapabilities,
  operatorSurfaceBrowserPause,
};
