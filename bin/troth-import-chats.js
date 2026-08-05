#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// troth-import-chats.js — import local AI chat history into the substrate corpus
// (scope docs:chats). Source-aware + detect: NOT hardcoded to one tool.
// Supported local sources: claude-cli (~/.claude/projects), codex (~/.codex/sessions).
// Web tools (ChatGPT/Claude.ai) via export-drop: --export-file <json> --provider chatgpt|claude-ai.
// Additive — never deletes. Run real (app) or headless (STATE_DB_PATH sandbox).
//
//   node bin/troth-import-chats.js --detect
//   node bin/troth-import-chats.js --source claude-cli|codex [--limit N]
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const chameleon = require('../shared-core/chameleon.js');
const AGENT = process.env.TROTH_AGENT_ID || 'local-agent';
const HOME = os.homedir();

// --distill: instead of raw chunk+embed (chameleon docs:chats archive), extract
// durable identity/knowledge engrams via the local proxy (GENTLE: one remote/local
// inference per session over HTTP, NO heavy claude-code process spawn) and record
// them as recallable memory:chat-distilled engrams. Wizard/Settings import uses this;
// the bare CLI (no --distill) keeps the raw searchable archive path unchanged.
const DISTILL = process.argv.includes('--distill');
const _http = require('http');
let _state = null, _ar = null;
if (DISTILL) { try { _state = require('../shared-core/state.js'); _ar = require('../shared-core/action-record.js'); } catch (_) {} }
const DISTILL_PROMPT = "Extract ONLY durable recall-worthy facts about the OPERATOR (identity, projects, hardware, goals, decisions, preferences, working style) from this conversation. Output 3-8 lines, each starting with '- ', standalone facts, NOT 'the user asked X'. Skip generic model facts and transient one-off Q&A.";
function _proxyDistill(text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ model: 'auto', max_tokens: 600, messages: [{ role: 'user', content: DISTILL_PROMPT + '\n\nCONVERSATION:\n' + String(text || '').slice(0, 28000) }] });
    const req = _http.request({ host: '127.0.0.1', port: 8000, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'troth-worker', 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { const j = JSON.parse(b); resolve((j.content && j.content[0] && j.content[0].text) || ''); } catch (_) { resolve(''); } });
    });
    req.on('error', () => resolve('')); req.setTimeout(120000, () => { try { req.destroy(); } catch (_) {} resolve(''); });
    req.write(payload); req.end();
  });
}
async function distillAndRecord(text, source) {
  if (!_state || !_ar) return { ok: false, recorded: 0 };
  const out = await _proxyDistill(text);
  const facts = String(out).split('\n').filter(l => /^\s*[-*]\s+/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, '').trim()).filter(l => l.length >= 8);
  let rec = 0;
  for (const f of facts) {
    const r = { id: _ar.uuidv7(), timestamp: Date.now(), type: 'commitment', agent_id: AGENT, user_id: 'default', cwd: null, memory_class: 'semantic', audience: 'model_visible', input: { source: 'import:chat-distill' }, output: { statement: f, commitment_type: 'fact', scope: 'memory:chat-distilled', source: source } };
    try { const v = _ar.validate(r); if (v && v.ok) { _state.recordAction(r, _ar.toSearchText(r)); rec++; } } catch (_) {}
  }
  return { ok: rec > 0, recorded: rec };
}

const SOURCES = {
  'claude-cli': { label: 'Claude Code', root: path.join(HOME, '.claude', 'projects') },
  'codex':      { label: 'Codex',       root: path.join(HOME, '.codex', 'sessions') },
};

function walk(root) {
  const out = []; if (!root || !fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) stack.push(fp);
      else if (e.name.endsWith('.jsonl')) out.push(fp);
    }
  }
  out.sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime);
  return out;
}
function clean(t) {
  if (!t) return ''; let s = t;
  s = s.replace(/<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|environment_context)>[\s\S]*?<\/\1>/g, ' ');
  s = s.replace(/<\/?(local-command[^>]*|command[^>]*|system-reminder|bash-[^>]*|environment_context)>/g, ' ');
  s = s.replace(/^\s*\[troth\/[^\]]*\][^\n]*$/gm, '').replace(/UserPromptSubmit hook[\s\S]*$/m, '');
  s = s.replace(/Caveat: The messages below were generated[\s\S]*?asks you to\.?/g, ' ');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Unified line→{role,text}: handles Claude (message.content) + Codex (payload.content).
function lineToTurn(d) {
  let role, content;
  if (d.type === 'user' || d.type === 'assistant') { role = d.message && d.message.role || d.type; content = d.message && d.message.content; }
  else if (d.type === 'response_item' && d.payload && d.payload.type === 'message') { role = d.payload.role; content = d.payload.content; }
  else return null;
  if (role !== 'user' && role !== 'assistant') return null;
  let txt = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(b => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text')).map(b => b.text).join('\n') : '';
  const c = clean(txt);
  return c && c.length > 1 ? `${role.toUpperCase()}: ${c}` : null;
}
function extract(jp) {
  const parts = []; let turns = 0;
  let data; try { data = fs.readFileSync(jp, 'utf8'); } catch { return { text: '', turns: 0 }; }
  for (const ln of data.split('\n')) {
    if (!ln) continue; let d; try { d = JSON.parse(ln); } catch { continue; }
    const t = lineToTurn(d); if (t) { parts.push(t); turns++; }
  }
  return { text: parts.join('\n\n'), turns };
}

// ── Web export parsers ───────────────────────
// ChatGPT export ZIP -> conversations.json = ARRAY; each conv.mapping = node tree
//   { <id>: { message:{author:{role}, content:{content_type:'text', parts:[]}, create_time}, parent, children } }
function parseChatGPTExport(arr) {
  const out = [];
  for (const c of (Array.isArray(arr) ? arr : [])) {
    const map = c && c.mapping; if (!map) continue;
    const nodes = Object.values(map).filter(n => n && n.message);
    nodes.sort((x, y) => ((x.message.create_time || 0) - (y.message.create_time || 0)));
    const parts = [];
    for (const n of nodes) {
      const m = n.message, role = m.author && m.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const cont = m.content; let txt = '';
      if (cont && cont.content_type === 'text' && Array.isArray(cont.parts)) txt = cont.parts.filter(x => typeof x === 'string').join('\n');
      const cl = clean(txt); if (cl && cl.length > 1) parts.push(role.toUpperCase() + ': ' + cl);
    }
    if (parts.length) out.push({ title: String(c.title || 'ChatGPT conversation').slice(0, 40), text: parts.join('\n\n') });
  }
  return out;
}
// Claude.ai export ZIP -> conversations.json = ARRAY; each { uuid, name, chat_messages:[{sender:'human'|'assistant', text}] }
function parseClaudeAiExport(arr) {
  const out = [];
  for (const c of (Array.isArray(arr) ? arr : [])) {
    const msgs = c && c.chat_messages; if (!Array.isArray(msgs)) continue;
    const parts = [];
    for (const m of msgs) {
      const role = m.sender === 'human' ? 'user' : (m.sender === 'assistant' ? 'assistant' : null);
      if (!role) continue;
      let txt = typeof m.text === 'string' ? m.text
        : Array.isArray(m.content) ? m.content.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
      const cl = clean(txt); if (cl && cl.length > 1) parts.push(role.toUpperCase() + ': ' + cl);
    }
    if (parts.length) out.push({ title: String(c.name || 'Claude.ai conversation').slice(0, 40), text: parts.join('\n\n') });
  }
  return out;
}

// Provenance already in the substrate for scope docs:chats. Lets the import
// skip sessions it already ingested -> re-running is idempotent (additive, no
// duplicates). Best-effort: empty set on any failure.
function loadExisting() {
  try { return new Set(chameleon.listIngestedSources(DISTILL ? 'memory:chat-distilled' : 'docs:chats')); }
  catch (_) { return new Set(); }
}

(async () => {
  const a = process.argv.slice(2);
  if (a.includes('--detect')) {
    const existing = loadExisting();
    const found = [];
    for (const [id, s] of Object.entries(SOURCES)) {
      const files = walk(s.root);
      if (!files.length) continue;
      let imported = 0;
      for (const f of files) {
        if (existing.has(`import:${id}:` + path.basename(f, '.jsonl'))) imported++;
      }
      found.push({ source: id, label: s.label, sessions: files.length, imported, fresh: files.length - imported });
    }
    console.log(JSON.stringify({ detected: found }));
    return;
  }
  // Web export-drop: --export-file <conversations.json> --provider chatgpt|claude-ai
  const expIdx = a.indexOf('--export-file');
  if (expIdx >= 0) {
    const file = a[expIdx + 1];
    let provider = a[a.indexOf('--provider') + 1] || 'auto';
    let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error('ERR cannot read export ' + e.message); process.exit(1); }
    const arr = Array.isArray(raw) ? raw : (raw.conversations || []);
    if (provider !== 'chatgpt' && provider !== 'claude-ai') {
      const first = arr[0] || {};
      provider = first.mapping ? 'chatgpt' : (Array.isArray(first.chat_messages) ? 'claude-ai' : 'chatgpt');
    }
    const convs = provider === 'claude-ai' ? parseClaudeAiExport(arr) : parseChatGPTExport(arr);
    const existing = loadExisting();
    let imported = 0, chunks = 0, turns = 0, skipped = 0;
    for (let i = 0; i < convs.length; i++) {
      const cv = convs[i], cap = cv.text.length > 200000 ? cv.text.slice(0, 200000) : cv.text;
      // Content-stable provenance key so re-dropping the same export is idempotent
      // (a conversation keeps its key even when the export grows; index would not).
      const wkey = crypto.createHash('sha1').update((cv.title || '') + '\n' + cv.text).digest('hex').slice(0, 16);
      const src = 'import:' + provider + ':web:' + wkey;
      if (existing.has(src)) { skipped++; }
      else if (cap.length >= 50) {
        const r = DISTILL ? await distillAndRecord(cap, src) : await chameleon.ingestDocument({ agent_id: AGENT, scope: 'docs:chats', text: cap, title: provider + ': ' + cv.title, source: src });
        if (r && r.ok) { imported++; chunks += (r.recorded || 0); turns += cv.text.split('\n\n').length; existing.add(src); }
      }
      console.log(JSON.stringify({ progress: { done: i + 1, total: convs.length, chunks, skipped } }));
    }
    console.log(JSON.stringify({ result: { source: provider, label: provider === 'claude-ai' ? 'Claude.ai' : 'ChatGPT', sessions: imported, chunks, turns, skipped } }));
    return;
  }
  const source = a[a.indexOf('--source') + 1] || 'claude-cli';
  const limit = parseInt(a[a.indexOf('--limit') + 1] || '0') || 0;
  const def = SOURCES[source]; if (!def) { console.error('ERR unknown source ' + source); process.exit(1); }
  const files = walk(def.root); const pick = limit > 0 ? files.slice(0, limit) : files;
  const existing = loadExisting();
  let imported = 0, chunks = 0, turns = 0, skipped = 0;
  for (let i = 0; i < pick.length; i++) {
    const src = `import:${source}:` + path.basename(pick[i], '.jsonl');
    if (existing.has(src)) {
      skipped++;
      console.log(JSON.stringify({ progress: { done: i + 1, total: pick.length, chunks, skipped } }));
      continue;
    }
    const { text, turns: n } = extract(pick[i]);
    if (text && text.length >= 100) {
      const cap = text.length > 200000 ? text.slice(0, 200000) : text;
      const r = DISTILL ? await distillAndRecord(cap, src) : await chameleon.ingestDocument({ agent_id: AGENT, scope: 'docs:chats', text: cap, title: `${def.label}: ${path.basename(pick[i], '.jsonl').slice(0, 40)}`, source: src });
      if (r && r.ok) { imported++; chunks += (r.recorded || 0); turns += n; existing.add(src); }
    }
    console.log(JSON.stringify({ progress: { done: i + 1, total: pick.length, chunks, skipped } }));
  }
  console.log(JSON.stringify({ result: { source, label: def.label, sessions: imported, chunks, turns, skipped } }));
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
