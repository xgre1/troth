// SPDX-License-Identifier: AGPL-3.0-only
// troth mcp-audit — measure how much prompt space each MCP server costs.
//
// The MCP schemas a client loads at startup go into the locked system-prefix
// of every single turn. A heavyweight Playwright/Vercel/Supabase stack can
// add 30-50K tokens to that prefix, silently shrinking the user's effective
// context. Research source: gist.github.com/GGPrompts + context-mode blog.
//
// This command scans the user's configured MCP servers, spawns each one,
// asks it for its tool list, sums the bytes, and prints a ranked report
// with recommendations. No mutation — purely diagnostic.
//
// Token estimate: bytes / 3.3 (empirical for Claude tokenizer on JSON).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const COLOR_RESET = '\x1b[0m';
const COLOR_DIM = '\x1b[2m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_RED = '\x1b[31m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_BOLD = '\x1b[1m';

const HOME = os.homedir();

function loadMcpSources() {
  const sources = [];
  // 1. user settings
  const userSettings = path.join(HOME, '.claude', 'settings.json');
  if (fs.existsSync(userSettings)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
      if (cfg.mcpServers) {
        for (const [name, spec] of Object.entries(cfg.mcpServers)) {
          sources.push({ scope: 'user', name, spec });
        }
      }
    } catch (e) { /* ignore */ }
  }
  // 2. project .mcp.json (in current dir walking up)
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    const candidate = path.join(dir, '.mcp.json');
    if (fs.existsSync(candidate)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (cfg.mcpServers) {
          for (const [name, spec] of Object.entries(cfg.mcpServers)) {
            if (!sources.find(s => s.name === name)) {
              sources.push({ scope: 'project:' + candidate, name, spec });
            }
          }
        }
      } catch (e) { /* ignore */ }
      break;
    }
    dir = path.dirname(dir);
  }
  return sources;
}

function probeServer(source, timeoutMs) {
  return new Promise((resolve) => {
    const spec = source.spec;
    // Only probe stdio servers — HTTP servers (type: "http" or "url" present)
    // carry no local schema cost; their tools are fetched at use-time.
    if (spec.type === 'http' || spec.url) {
      return resolve({ ...source, kind: 'http', tools: null, bytes: 0, note: 'HTTP MCP — no startup schema cost' });
    }
    if (!spec.command) {
      return resolve({ ...source, kind: 'unknown', tools: null, bytes: 0, note: 'No command; cannot probe' });
    }

    const args = spec.args || [];
    const env = Object.assign({}, process.env, spec.env || {});
    const proc = spawn(spec.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (err, tools) => {
      if (done) return; done = true;
      try { proc.kill('SIGTERM'); } catch (e) {}
      if (err) resolve({ ...source, kind: 'stdio', tools: null, bytes: 0, error: err });
      else {
        const bytes = Buffer.byteLength(JSON.stringify(tools || []), 'utf8');
        resolve({ ...source, kind: 'stdio', tools, bytes, estTokens: Math.round(bytes / 3.3) });
      }
    };

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      // MCP stdio is newline-delimited JSON-RPC. Look for tools/list response.
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 'probe-tools' && msg.result && Array.isArray(msg.result.tools)) {
            finish(null, msg.result.tools);
            return;
          }
          if (msg.id === 'probe-init' && msg.result) {
            // After init ack, send tools/list.
            const req = JSON.stringify({ jsonrpc: '2.0', id: 'probe-tools', method: 'tools/list', params: {} });
            proc.stdin.write(req + '\n');
          }
        } catch (e) { /* partial line */ }
      }
    });
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', (e) => finish('spawn failed: ' + e.message));
    proc.on('exit', (code) => {
      if (!done) finish('server exited (code=' + code + ') before responding. stderr: ' + stderr.slice(0, 200));
    });

    // Initialize the MCP server.
    const initReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 'probe-init',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'troth-mcp-audit', version: '1.0.0' }
      }
    });
    proc.stdin.write(initReq + '\n');

    setTimeout(() => finish('probe timeout after ' + timeoutMs + 'ms (stderr: ' + stderr.slice(0, 100) + ')'), timeoutMs);
  });
}

function recommendation(result) {
  if (result.error) return { label: 'error', color: COLOR_RED };
  if (result.kind === 'http') return { label: 'ok (http)', color: COLOR_GREEN };
  if (result.bytes === 0) return { label: 'empty', color: COLOR_DIM };
  if (result.bytes > 20000) return { label: 'HEAVY — consider deferring', color: COLOR_RED };
  if (result.bytes > 8000) return { label: 'moderate', color: COLOR_YELLOW };
  return { label: 'light', color: COLOR_GREEN };
}

async function main() {
  // --timeout=<ms> lets slow-starting servers (codebase-memory, heavy RAG)
  // finish their init before we give up. Default 8s; pass more if a real
  // server times out.
  const argv = process.argv.slice(2);
  let timeoutMs = 8000;
  for (const a of argv) {
    const m = /^--timeout=(\d+)$/.exec(a);
    if (m) timeoutMs = parseInt(m[1]);
  }

  const sources = loadMcpSources();
  if (!sources.length) {
    console.log('No MCP servers found in ~/.claude/settings.json or nearest .mcp.json.');
    process.exit(0);
  }

  console.log(COLOR_BOLD + 'Probing ' + sources.length + ' MCP server(s) (timeout ' + (timeoutMs/1000) + 's)…' + COLOR_RESET);
  const results = await Promise.all(sources.map(s => probeServer(s, timeoutMs)));

  // Sort by bytes desc so the fattest offenders are on top.
  results.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));

  console.log('');
  console.log(COLOR_BOLD + '  MCP server                       scope       tools    bytes   ~tokens   verdict' + COLOR_RESET);
  console.log('  ' + '-'.repeat(90));
  let totalBytes = 0;
  for (const r of results) {
    const rec = recommendation(r);
    const tools = r.tools ? r.tools.length.toString() : '-';
    const bytes = r.bytes ? r.bytes.toLocaleString() : '-';
    const toks = r.estTokens ? r.estTokens.toLocaleString() : '-';
    const name = r.name.padEnd(32);
    const scope = r.scope.slice(0, 11).padEnd(11);
    const lineA = '  ' + name + ' ' + scope + ' ' + tools.padStart(6) + ' ' + bytes.padStart(8) + ' ' + toks.padStart(8) + '   ' + rec.color + rec.label + COLOR_RESET;
    console.log(lineA);
    if (r.error) console.log('      ' + COLOR_DIM + r.error + COLOR_RESET);
    totalBytes += r.bytes || 0;
  }
  console.log('  ' + '-'.repeat(90));
  const totalTokens = Math.round(totalBytes / 3.3);
  console.log(COLOR_BOLD + '  TOTAL'.padEnd(57) + totalBytes.toLocaleString().padStart(8) + ' ' + totalTokens.toLocaleString().padStart(8) + COLOR_RESET);
  console.log('');
  console.log(COLOR_DIM + '  Token estimate: bytes / 3.3 (Claude tokenizer on JSON schemas).' + COLOR_RESET);
  console.log(COLOR_DIM + '  These are locked into the system prefix of every turn until an MCP-deferral mechanism' + COLOR_RESET);
  console.log(COLOR_DIM + '  lazy-loads them. HEAVY servers are the highest-leverage disable/defer targets.' + COLOR_RESET);

  if (totalTokens > 20000) {
    console.log('');
    console.log(COLOR_YELLOW + '⚠  Combined schema overhead exceeds 20K tokens. For a Max-plan user with a 220K/5h' + COLOR_RESET);
    console.log(COLOR_YELLOW + '   quota this is ~9% of your budget burned before the agent does anything.' + COLOR_RESET);
    console.log(COLOR_YELLOW + '   Consider removing MCP servers you rarely use from .claude/settings.json.' + COLOR_RESET);
  }
}

module.exports = { main };
