// SPDX-License-Identifier: AGPL-3.0-only
// Code conventions detector — extract project-specific style from existing
// code so the agent matches it instead of imposing defaults.
//
// Detects: indent (tabs vs N spaces), quote style (single vs double), semi
// colons vs none, naming (camelCase vs snake_case), import style.

const fs = require('fs');
const path = require('path');

function detectFromFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { return null; }
  const lines = content.split('\n').slice(0, 200);

  // Indent
  let tabs = 0, twoSpace = 0, fourSpace = 0;
  for (const line of lines) {
    if (/^\t/.test(line)) tabs++;
    else if (/^    \S/.test(line)) fourSpace++;
    else if (/^  \S/.test(line)) twoSpace++;
  }
  const indentMax = Math.max(tabs, twoSpace, fourSpace);
  let indent = 'unknown';
  if (indentMax === tabs && tabs > 0) indent = 'tabs';
  else if (indentMax === fourSpace && fourSpace > 0) indent = '4-space';
  else if (indentMax === twoSpace && twoSpace > 0) indent = '2-space';

  // Quotes (JS/TS)
  const single = (content.match(/'[^']*'/g) || []).length;
  const double = (content.match(/"[^"]*"/g) || []).length;
  const quotes = single > double * 1.5 ? 'single' : double > single * 1.5 ? 'double' : 'mixed';

  // Semicolons
  const lineEnds = lines.filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const withSemi = lineEnds.filter(l => l.trim().endsWith(';')).length;
  const semiRatio = lineEnds.length ? withSemi / lineEnds.length : 0;
  const semicolons = semiRatio > 0.5 ? 'required' : semiRatio < 0.1 ? 'avoided' : 'mixed';

  return { indent, quotes, semicolons };
}

function detectFromDir(dir, sampleSize) {
  sampleSize = sampleSize || 5;
  const files = [];
  function walk(d, depth) {
    if (depth > 3 || files.length >= sampleSize * 4) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(js|ts|jsx|tsx)$/.test(e.name) && !/\.(test|spec|min)\./.test(e.name)) files.push(full);
    }
  }
  walk(dir, 0);
  if (!files.length) return null;

  // Sample files, aggregate
  const sample = files.slice(0, sampleSize);
  const results = sample.map(detectFromFile).filter(Boolean);
  if (!results.length) return null;

  // Vote
  function mode(arr) {
    const counts = {};
    for (const v of arr) counts[v] = (counts[v] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }
  return {
    indent: mode(results.map(r => r.indent)),
    quotes: mode(results.map(r => r.quotes)),
    semicolons: mode(results.map(r => r.semicolons)),
    sampledFiles: sample.length,
  };
}

let cache = null;
function init(dir) {
  cache = detectFromDir(dir);
  if (cache) {
    console.log('[conventions] indent:' + cache.indent + ' quotes:' + cache.quotes + ' semi:' + cache.semicolons);
  }
}

function getContext() {
  if (!cache) return null;
  return '## Project Code Conventions (from existing code — match these)\n' +
    '- Indent: ' + cache.indent + '\n' +
    '- Quotes: ' + cache.quotes + '\n' +
    '- Semicolons: ' + cache.semicolons + '\n' +
    'When writing new code in this project, use these conventions exactly.';
}

function getStats() { return cache; }

module.exports = { init, detectFromDir, detectFromFile, getContext, getStats };
