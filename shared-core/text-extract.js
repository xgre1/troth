// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Text out of the formats an operator actually hands over.
//
// The knowledge drain read every queued file with readFileSync(path,'utf8'),
// which is correct for markdown and nonsense for a PDF: 123 PDFs, 16 rtf and 9
// docx sat in the operator's folders and would have been ingested as binary
// mojibake, embedded, and returned as recall hits.
//
// NO NEW DEPENDENCIES, and none are needed — both extractors are already on
// the machine: `pdftotext` from poppler, and `textutil`,
// which ships with macOS and converts rtf/doc/docx/html. Typical per file:
// pdf 56ms, rtf 31ms, docx 35ms, html 435ms, plain text 1ms. When a converter
// is missing the file is SKIPPED rather than ingested as garbage — a corpus
// full of mojibake is worse than a corpus without the document.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLAIN = /\.(md|markdown|txt|csv|adoc|rst)$/i;
const PDF   = /\.pdf$/i;
const OFFICE = /\.(rtf|docx?|html?)$/i;

function have(cmd) {
  try { execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; }
  catch (_) { return false; }
}

// Cached: `which` per call would cost more than the extraction on markdown.
let _hasPdftotext = null, _hasTextutil = null;
function hasPdftotext() { if (_hasPdftotext === null) _hasPdftotext = have('pdftotext'); return _hasPdftotext; }
function hasTextutil()  { if (_hasTextutil  === null) _hasTextutil  = have('textutil');  return _hasTextutil;  }

// Returns { ok, text, how } or { ok:false, reason }.
function extract(filePath, opts) {
  opts = opts || {};
  const p = String(filePath || '');
  const maxBytes = opts.max_bytes || 2 * 1024 * 1024;
  let st;
  try { st = fs.statSync(p); } catch (_) { return { ok: false, reason: 'source_gone' }; }
  if (!st.isFile()) return { ok: false, reason: 'not_a_file' };
  if (st.size > maxBytes) return { ok: false, reason: 'too_large' };

  try {
    if (PLAIN.test(p)) {
      return { ok: true, how: 'plain', text: fs.readFileSync(p, 'utf8') };
    }
    if (PDF.test(p)) {
      if (!hasPdftotext()) return { ok: false, reason: 'no_pdf_extractor' };
      const text = execFileSync('pdftotext', ['-q', '-nopgbrk', p, '-'],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      return { ok: true, how: 'pdftotext', text };
    }
    if (OFFICE.test(p)) {
      if (!hasTextutil()) return { ok: false, reason: 'no_office_extractor' };
      const text = execFileSync('textutil', ['-stdout', '-convert', 'txt', p],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      return { ok: true, how: 'textutil', text };
    }
    // Spreadsheets need a real parser; refusing is the honest answer until one
    // is chosen deliberately.
    return { ok: false, reason: 'unsupported_format' };
  } catch (e) {
    return { ok: false, reason: 'extract_failed: ' + String(e && e.message || e).slice(0, 80) };
  }
}

module.exports = { extract, hasPdftotext, hasTextutil };
