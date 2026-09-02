// SPDX-License-Identifier: AGPL-3.0-only
// vault-capture.js — move a credential the operator already holds in a tool
// of their own (the gh session, a keychain item, an environment variable)
// into the vault, from the process that owns the unlocked session. The
// partner asks by NAME and receives a receipt; the value travels
// source → this process → vault and never appears in a return value, an
// error message or a log line. Sources are a closed list: a name that is
// not on it is refused before anything runs.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const spawnPurpose = require('./tools/spawn-purpose.js');

const READ_TIMEOUT_MS = 10 * 1000;

// The proxy often runs from launchd or a service shell whose PATH stops at
// /usr/bin, while the operator's tools live under Homebrew or ~/.local. A
// name is resolved on PATH first, then in those known places; only a
// binary that exists is ever spawned, and the argv stays product-authored.
const KNOWN_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.HOME || os.homedir(), '.local', 'bin'), '/opt/local/bin'];
function resolveBinary(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).concat(KNOWN_BIN_DIRS);
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
  }
  return name;   // the spawn then reports ENOENT as tool_missing
}

const SOURCES = {
  gh: {
    describe: 'gh session token',
    defaults: () => ({ key: 'github', host: 'github.com' }),
    read: (p, run) => run(resolveBinary('gh'), ['auth', 'token'])
  },
  keychain: {
    describe: 'keychain item',
    defaults: (p) => ({ key: p.service ? String(p.service) : null }),
    read: (p, run) => {
      if (!p.service) throw Object.assign(new Error('service_required'), { code: 'service_required' });
      const args = ['find-generic-password', '-s', String(p.service)];
      if (p.account) args.push('-a', String(p.account));
      args.push('-w');
      return run('security', args);
    }
  },
  env: {
    describe: 'environment variable of the vault process',
    defaults: (p) => ({ key: p.name ? String(p.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') : null }),
    read: (p) => {
      if (!p.name) throw Object.assign(new Error('name_required'), { code: 'name_required' });
      return String(process.env[String(p.name)] || '');
    }
  }
};

// Default runner: stdout only, stderr discarded, and a failure re-thrown
// with its exit status alone — execFileSync's own error carries the
// captured stdout, which here would be the credential.
function runCommand(cmd, args) {
  try {
    return String(spawnPurpose.execFileSync('vault-capture', cmd, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: READ_TIMEOUT_MS
    }));
  } catch (e) {
    const err = new Error(cmd + ' exited ' + (e && e.status != null ? e.status : ((e && e.code) || 'unknown')));
    err.code = (e && e.code === 'ENOENT') ? 'tool_missing' : 'source_failed';
    throw err;
  }
}

function hostOf(v) {
  return String(v || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
}

// captureFromSource(params, deps) → receipt, never the value.
// params: { source, key?, host?, scope?, injection?, description?, overwrite?,
//           service?, account?, name? }
// deps:   { vault?, run?, engram? } — the test seams; production resolves each.
function captureFromSource(params, deps) {
  const p = params || {};
  deps = deps || {};
  const vault = deps.vault || require('./vault.js');
  const run = deps.run || runCommand;
  const src = SOURCES[String(p.source || '')];
  if (!src) return { ok: false, error: 'unknown_source', sources: Object.keys(SOURCES) };
  const d = src.defaults(p);
  const key = (p.key && String(p.key).trim()) || d.key;
  if (!key) return { ok: false, error: 'key_required' };
  const host = hostOf(p.host) || d.host || null;
  const scope = (p.scope && String(p.scope).trim()) || (host ? 'capability:http:do:*.' + host : null);
  if (!scope) return { ok: false, error: 'scope_or_host_required' };
  let value;
  try { value = String(src.read(p, run) || '').trim(); }
  catch (e) {
    return { ok: false, error: (e && e.code) || 'source_failed', detail: String((e && e.message) || '').slice(0, 120) };
  }
  if (!value) {
    return { ok: false, error: 'source_empty', hint: 'the ' + src.describe + ' answered with nothing; sign in there first' };
  }
  const draft = {
    key, value,
    capability_scope_glob: scope,
    injection: p.injection || { kind: 'bearer' },
    description: p.description || (src.describe + ', captured from ' + p.source)
  };
  let out;
  if (!vault.isUnlocked()) {
    // Locked is not a dead end: the drop-box takes the capture and the
    // entry appears at the next unlock, exactly as a browser capture does.
    const sealed = vault.seal(draft);
    if (!sealed.ok) return { ok: false, error: sealed.error };
    out = { ok: true, key, scope, source: p.source, sealed_for_unlock: true, pending_drops: sealed.pending_drops };
  } else {
    const w = vault.writeEntry(Object.assign({ overwrite: p.overwrite === true }, draft));
    if (!w.ok) return { ok: false, error: w.error };
    out = { ok: true, key, scope, source: p.source };
  }
  try {
    (deps.engram || require('./engram.js')).recordEngram({
      agent_id: 'operator',
      statement: 'credential captured from ' + p.source + ' into the vault as ' + key + ' for ' + scope,
      source: 'vault-capture', scope: 'vault:capture', salience: 0.5, auto_verify: false
    });
  } catch (_) { /* the receipt stands without the audit line */ }
  return out;
}

// Where the proxy is: the env the app exports, else the operator's config,
// else the default. The unlocked vault session lives in the proxy process,
// so a capture asked for from any other process travels there.
function proxyBase() {
  const fromEnv = String(process.env.TROTH_PROXY_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  let host = '127.0.0.1', port = 8000;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.troth', 'config.json'), 'utf8')) || {};
    if (typeof c.host === 'string' && c.host) host = c.host;
    if (c.port) port = parseInt(c.port, 10) || port;
  } catch (_) { /* defaults */ }
  return 'http://' + host + ':' + port;
}

// The tool face, one entry for every faculty: a local model in the proxy's
// own tool loop captures in this process; an MCP host or a worker reaches
// the proxy over HTTP. Either way the value never enters a model context.
const schema = {
  type: 'function',
  function: {
    name: 'vault_capture',
    description: 'Move a credential the operator already holds in a tool of their own into the vault, by NAME only: source "gh" (the gh session token), "keychain" (a keychain item: service, account?) or "env" (an environment variable of the proxy: name). The value is stored under key with a capability scope for host (capability:http:do:*.<host>); the reply is a receipt, never the value. Use before an intent needs a credential the vault does not hold yet.',
    parameters: {
      type: 'object',
      properties: {
        source:    { type: 'string', enum: Object.keys(SOURCES), description: 'Where the operator already keeps the credential.' },
        key:       { type: 'string', description: 'Vault entry name (default: github for gh, the service for keychain, the lower-cased name for env).' },
        host:      { type: 'string', description: 'API host the credential belongs to, e.g. github.com; seals capability:http:do:*.<host>.' },
        service:   { type: 'string', description: 'keychain only: the item service name.' },
        account:   { type: 'string', description: 'keychain only: the item account, when the service alone is ambiguous.' },
        name:      { type: 'string', description: 'env only: the variable name.' },
        overwrite: { type: 'boolean', description: 'Replace an existing entry of the same key (rotation). Default false: an existing key is refused.' }
      },
      required: ['source']
    }
  }
};

async function run(args, ctx) {
  const a = args || {};
  const body = {};
  for (const k of ['source', 'key', 'host', 'service', 'account', 'name', 'overwrite']) if (a[k] !== undefined) body[k] = a[k];
  const vault = (ctx && ctx._vault) || require('./vault.js');
  if (vault.isUnlocked()) return captureFromSource(body, { vault });
  const base = (ctx && ctx._proxyBase) || proxyBase();
  try {
    const r = await fetch(base + '/api/vault/capture-cli', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    let j; try { j = await r.json(); } catch (_) { j = { ok: false, error: 'bad_reply', status: r.status }; }
    return j;
  } catch (e) {
    return { ok: false, error: 'proxy_unreachable', detail: String((e && e.message) || e), hint: 'run `troth start`; the vault session lives in the proxy' };
  }
}

module.exports = { schema, run, captureFromSource, proxyBase, resolveBinary, SOURCES, runCommand, hostOf, READ_TIMEOUT_MS };
