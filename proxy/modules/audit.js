// SPDX-License-Identifier: AGPL-3.0-only
// Audit log — security-relevant events to a tamper-evident JSONL file.
//
// What gets logged: provider switches, credential reads, dangerous-bash
// blocks, security-audit findings, rollbacks, memory wipes, config changes.
//
// File: ~/.troth/audit.log (append-only, never modified or deleted by troth)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || require('os').homedir();
const LOG_PATH = path.join(HOME, '.troth', 'audit.log');

let prevHash = null;

function ensureFile() {
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
  } catch (e) {}
}

function loadLastHash() {
  if (prevHash !== null) return prevHash;
  try {
    if (!fs.existsSync(LOG_PATH)) { prevHash = ''; return prevHash; }
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (!lines.length) { prevHash = ''; return prevHash; }
    const last = JSON.parse(lines[lines.length - 1]);
    prevHash = last.hash || '';
    return prevHash;
  } catch (e) { prevHash = ''; return ''; }
}

function log(event, details) {
  ensureFile();
  loadLastHash();
  const entry = {
    ts: new Date().toISOString(),
    event,
    details: details || {},
    prevHash,
  };
  // Hash chain — each entry includes hash of previous
  entry.hash = crypto.createHash('sha256')
    .update(JSON.stringify(entry))
    .digest('hex').slice(0, 16);
  prevHash = entry.hash;
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {}
}

function getRecent(limit) {
  limit = limit || 50;
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Verify hash chain integrity (detects tampering)
function verify() {
  try {
    if (!fs.existsSync(LOG_PATH)) return { ok: true, count: 0 };
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    let lastHash = '';
    for (let i = 0; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]);
      if (entry.prevHash !== lastHash) return { ok: false, brokenAt: i };
      const expected = crypto.createHash('sha256')
        .update(JSON.stringify({ ts: entry.ts, event: entry.event, details: entry.details, prevHash: entry.prevHash }))
        .digest('hex').slice(0, 16);
      if (entry.hash !== expected) return { ok: false, brokenAt: i, kind: 'hash mismatch' };
      lastHash = entry.hash;
    }
    return { ok: true, count: lines.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { log, getRecent, verify };
