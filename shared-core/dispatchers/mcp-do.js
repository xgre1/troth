// SPDX-License-Identifier: AGPL-3.0-only
// Governed MCP executor - the partner's "extra hands," under STVC.
//
//  audit + operator design. Before this, mcp-client's mcp_call
// spawned a downstream MCP server and ran tools/call UNGOVERNED - outside
// the intent system, with no capability wall, no observation engram, no
// kill-switch. This adapter is the dispatch-time half of the fix: a call
// arrives as an intent engram (scope 'intent:mcp:call:<server>'), the
// write-time STVC wall already gated it (capability covers intent, not
// globally paused, grounded in a sealed decision), and here we mechanically
// run the downstream tool and let the dispatcher write the observation.
//
// Modeled on dispatchers/http-do.js (same shape: scope_match,
// dispatch(intent, capability, ctx), _validate, capability defense-in-depth,
// ctx._mcp_mock test injection). The transport is delegated to
// shared-core/tools/mcp-client.js (getDownstream + rpc) so the layered
// global+project registry, the stdio bridge for http servers, and the
// $vault env resolution all live in ONE place and this adapter stays thin.
//
// Payload shape: { server, tool, args?, workspace? }
//   server    - configured downstream MCP name (global mcp-clients.json OR
//               project .mcp.json; project wins collisions)
//   tool      - the downstream tool to invoke
//   args      - structured arguments for the downstream tool (object)
//   workspace - optional cwd for project-.mcp.json resolution; falls back
//               to ctx.cwd (threaded from the tool contract)
//
// Capability scope shape (defense-in-depth, mirrors http-do's URL check):
//   capability:mcp:<server-name>   authorizes exactly that server
//   capability:mcp:*               authorizes any server
// The write-time wall (capability_covers_intent + intent.mcpCapabilityCoversIntent)
// already enforces this; we RE-CHECK here so a capability whose scope drifted
// from the intent's payload.server still gets refused at dispatch (TOCTOU +
// belt-and-suspenders, same rationale as http-do._capabilityCoversUrl).

'use strict';

const ADAPTER_SCOPE = 'intent:mcp:call:*';

function _validate(payload) {
  if (!payload || typeof payload !== 'object') return 'payload required';
  if (typeof payload.server !== 'string' || !payload.server.length) return 'server (non-empty string) required';
  if (typeof payload.tool !== 'string' || !payload.tool.length) return 'tool (non-empty string) required';
  if (payload.args !== undefined && payload.args !== null && typeof payload.args !== 'object') {
    return 'args must be an object when present';
  }
  return null;
}

// Does the capability scope cover this server? Accepts the exact-name form
// (capability:mcp:<server>) and the wildcard (capability:mcp:*). Any other
// shape is a non-cover (fail-closed). Mirrors http-do._capabilityCoversUrl.
function _capabilityCoversServer(capScope, server) {
  if (typeof capScope !== 'string' || typeof server !== 'string') return false;
  if (capScope.indexOf('capability:mcp:') !== 0) return false;
  const capServer = capScope.slice('capability:mcp:'.length);
  if (capServer === '*') return true;
  return capServer === server;
}

async function dispatch(intent, capability, ctx) {
  ctx = ctx || {};
  const payload = (intent && intent.payload) || {};
  const invalid = _validate(payload);
  if (invalid) return { ok: false, error: 'mcp_payload_invalid: ' + invalid };

  // Capability defense-in-depth. The write wall already ran, but re-check
  // that the (possibly drifted) capability still covers payload.server so a
  // mismatch is refused at dispatch rather than silently contacting the
  // wrong server. Only enforced when a capability is present (the dispatcher
  // passes the resolved capability engram).
  if (capability) {
    if (!_capabilityCoversServer(capability.scope, payload.server)) {
      return { ok: false, error: 'capability_does_not_cover_server: cap=' + capability.scope + ' server=' + payload.server };
    }
  }

  // Test injection - identical contract to http-do's ctx._http_mock. Lets a
  // test exercise the governed path (write -> STVC -> dispatch -> observation)
  // WITHOUT spawning a real downstream MCP. The mock sees {server, tool, args}
  // and returns either the downstream result directly or {ok, result, error}.
  if (typeof ctx._mcp_mock === 'function') {
    try {
      const mres = await Promise.resolve(ctx._mcp_mock({
        server: payload.server,
        tool:   payload.tool,
        args:   payload.args || {},
        intent, capability
      }));
      return {
        ok: mres && mres.ok !== false,
        result: (mres && mres.result) || mres,
        cost_usd: (mres && typeof mres.cost_usd === 'number') ? mres.cost_usd : 0,
        error: (mres && mres.ok === false) ? (mres.error || 'mock_reported_failure') : null
      };
    } catch (e) { return { ok: false, error: 'mcp_mock_threw: ' + (e && e.message || e) }; }
  }

  // Real transport - delegate to mcp-client. Never throw: convert any spawn /
  // rpc failure into { ok:false, error } so the dispatcher records a clean
  // observation engram (fail-closed, same as http-do). workspace flows from
  // payload.workspace or ctx.cwd so a project .mcp.json entry resolves.
  let client;
  try { client = require('../tools/mcp-client.js'); }
  catch (e) { return { ok: false, error: 'mcp_client_unavailable: ' + (e && e.message || e) }; }
  const workspace = payload.workspace || (ctx && ctx.cwd) || null;
  let state;
  try { state = await client.getDownstream(payload.server, { workspace }); }
  catch (e) { return { ok: false, error: 'mcp_spawn_failed: ' + (e && e.message || String(e)) }; }
  let res;
  try {
    res = await client.rpc(state, 'tools/call', { name: payload.tool, arguments: payload.args || {} });
  } catch (e) {
    return { ok: false, error: 'mcp_rpc_failed: ' + (e && e.message || String(e)) };
  }
  return {
    ok: true,
    result: res,
    cost_usd: 0   // downstream MCP calls are unmetered here; a metered server can surface cost in its own result
  };
}

module.exports = {
  scope_match: ADAPTER_SCOPE,
  param_schema: { server: 'string', tool: 'string', args: 'object?', workspace: 'string?' },
  // medium: a downstream tool call typically mutates external state that
  // needs effort to undo (a file created, a row written) but is not the
  // irrevocable class. Per-server capability:mcp:<server> can raise/lower
  // the ceiling via max_irreversibility, exactly like http-do.
  irreversibility_class: 'medium',
  dispatch,
  // Test surface
  _validate,
  _capabilityCoversServer
};
