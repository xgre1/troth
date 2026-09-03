// SPDX-License-Identifier: AGPL-3.0-only
// cmd-mcp.js - `troth mcp approve|pending|reject` (conversational MCP
// registration, operator side).
//
// Flow: the operator pastes an MCP config
// snippet in chat, the PARTNER stages it via mcp_register_request into the
// inert ~/.troth/mcp-pending.json, and the operator approves ONCE here.
// Approve = move the entry pending -> active (~/.troth/mcp-clients.json,
// atomic on both files) + seal capability:mcp:<name> --max medium via the
// SAME signer path as `troth cap mint` (TROTH_OPERATOR_PASSPHRASE works
// non-interactively; the desktop app shells out to this command headlessly).
// The partner can never do this itself: the active registry is partner-
// write-blocked (path-policy + bash-safety) and the capability needs the
// operator signature.
//
// Output is machine-friendly: ONE JSON line on stdout on success, one JSON
// line on stderr + exit 2 on refusal, so the app can parse either stream.
// Wired from the `command === "mcp"` block in bin/troth.js, before the MCP
// stdio server starts (these subcommands own stdout; the server must not).
module.exports = function run(ctx) {
  const { passthrough, _getOperatorSigner } = ctx;
  const sub = passthrough[0]; // "approve" | "pending" | "reject"
  const mcpClient = require('../shared-core/tools/mcp-client.js');

  function fail(obj) { console.error(JSON.stringify(obj)); process.exit(2); }

  if (sub === 'pending') {
    // List staged requests. config stays out of the line (it can carry env
    // key NAMES); the app fetches details from the file if it needs them.
    let rows;
    try {
      rows = mcpClient.listPendingServers().map((r) => ({
        name: r.name, transport: r.transport, note: r.note, requested_at: r.requested_at
      }));
    } catch (e) {
      fail({ ok: false, error: e && e.code === 'REGISTRY_MALFORMED' ? 'pending_malformed' : 'pending_unreadable', detail: e && e.message, path: e && e.path });
    }
    console.log(JSON.stringify({ ok: true, pending: rows }));
    process.exit(0);
  }

  const name = passthrough[1];
  if ((sub !== 'approve' && sub !== 'reject' && sub !== 'probe') || !name) {
    console.error('Usage: troth mcp pending | troth mcp approve <name> | troth mcp reject <name> | troth mcp probe <name>');
    process.exit(2);
  }

  if (sub === 'probe') {
    mcpClient.probe(name, { workspace: process.cwd() }).then((r) => {
      console.log(JSON.stringify(r));
      process.exit(r && r.state === 'connected' ? 0 : 1);
    }).catch((e) => fail({ ok: false, error: 'probe_failed', detail: e && e.message }));
    return;
  }

  if (sub === 'reject') {
    let r;
    try { r = mcpClient.rejectPendingServer(name); }
    catch (e) { fail({ ok: false, error: e && e.code === 'REGISTRY_MALFORMED' ? 'pending_malformed' : 'pending_unreadable', detail: e && e.message, path: e && e.path }); }
    if (!r.ok) fail({ ok: false, error: r.reason, name: name });
    console.log(JSON.stringify({ ok: true, rejected: name }));
    process.exit(0);
  }

  // sub === "approve" - the ONE operator approval in the flow.
  const opKey = require('../shared-core/operator-key.js');
  const intentMod = require('../shared-core/intent.js');
  if (!opKey.exists()) {
    fail({ ok: false, error: 'no_operator_key', hint: 'Run `troth init` first.' });
  }
  // Unlock BEFORE touching any file: a wrong passphrase must not consume
  // the staged entry or activate anything (fail-closed ordering).
  var signer;
  try { signer = _getOperatorSigner('Operator passphrase').signer; }
  catch (e) { fail({ ok: false, error: 'unlock_failed', detail: e.message }); }
  try {
    const moved = mcpClient.approvePendingServer(name);
    if (!moved.ok) fail({ ok: false, error: moved.reason, name: name });
    // Seal capability:mcp:<name> --max medium. Byte-identical extra_output
    // discipline as bin/cmd-cap.js: the signed canonical body must EXACTLY
    // equal what writeCapability persists, or the substrate refuses.
    const scope = 'capability:mcp:' + name;
    const extra = {
      payload_schema:       null,
      max_irreversibility:  'medium',
      expiry:               null,
      revoked:              false,
      scope_glob:           scope,
      parent_capability_id: null,
      budget_usd:           null,
      budget_window_ms:     null
    };
    const canon = opKey.canonicalEngramBody({
      statement: 'cap ' + scope,
      scope: scope,
      source_authority: 'operator_confirmed',
      extra_output: extra
    });
    const res = intentMod.writeCapability({
      scope: scope,
      statement: 'cap ' + scope,
      max_irreversibility: 'medium',
      expiry: null,
      signature: signer.sign(canon),
      extra_output: extra
    });
    if (!res.ok) {
      // Entry is already active but ungoverned: without the capability every
      // mcp_call still fails closed at the STVC wall, so this is safe to
      // hand back with a manual-seal hint rather than roll back.
      fail({
        ok: false, error: 'capability_seal_failed', reason: res.error,
        detail: res.detail || null, name: name, activated: true,
        hint: 'Entry is active but calls stay refused until sealed. Run: troth cap mint ' + scope + ' --max medium'
      });
    }
    try { require('../shared-core/presence.js').recordPresenceProof(signer, { note: 'auto via troth mcp approve' }); } catch (_) {}
    console.log(JSON.stringify({
      ok: true, approved: name, capability_id: res.id, capability_scope: scope,
      max_irreversibility: 'medium', active_path: moved.active_path
    }));
  } finally { try { signer.lock(); } catch (_) {} }
  process.exit(0);
};
