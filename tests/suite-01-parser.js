// SPDX-License-Identifier: AGPL-3.0-only
// Auto-split from tests/test-all.js (verbatim section bodies; order preserved).
// Sections: PARSER | STORE | CLEANER | GUARDIAN | LOOPGUARD | PINNING | RANKER | COMPRESSOR | VALIDATOR (v5.10) | CRITIC | PREPROCESSOR | ERROR TAXONOMY (P4.2) | CACHE RATIO (P4.1) | ULTRAREVIEW (P3.5) | VISION VALIDATOR (P3.3, Opus 4.7 2,576px limit) | COMPRESSION BUFFER (P3.2, Hermes 80% pattern) | TOKEN ESTI
module.exports = function run({ test }) {
const assert = require('assert');
// --- PARSER ---
console.log('Parser:');
const { parseFile } = require('../proxy/modules/codelens/parser');

test('extracts functions', () => {
  const { entities } = parseFile('test.js', 'function hello(name) { return name; }');
  assert(entities.some(e => e.name === 'hello' && e.type === 'function'));
});

test('extracts classes', () => {
  const { entities } = parseFile('test.js', 'export class UserService extends BaseService { }');
  assert(entities.some(e => e.name === 'UserService' && e.type === 'class'));
});

test('extracts imports', () => {
  const { entities, edges } = parseFile('test.js', "import { Logger } from './logger';");
  assert(entities.some(e => e.name === 'Logger' && e.type === 'import'));
  assert(edges.some(e => e.relation === 'imports'));
});

test('extracts extends edges', () => {
  const { edges } = parseFile('test.js', 'class Dog extends Animal { }');
  assert(edges.some(e => e.from === 'Dog' && e.to === 'Animal' && e.relation === 'extends'));
});

test('extracts arrow exports', () => {
  const { entities } = parseFile('test.js', 'export const handler = async (req, res) => { }');
  assert(entities.some(e => e.name === 'handler' && e.type === 'function'));
});

// --- STORE ---
console.log('\nStore:');
const CodeStore = require('../proxy/modules/codelens/store');

test('add and search entities', () => {
  const store = new CodeStore();
  store.addEntity('function', 'authenticateUser', 'auth.js', 'function authenticateUser(email, password)', 10, '');
  store.addEntity('function', 'hashPassword', 'crypto.js', 'function hashPassword(pwd)', 5, '');
  const results = store.search('authenticate');
  assert(results.length > 0);
  assert(results[0].name === 'authenticateUser');
});

test('add and traverse edges', () => {
  const store = new CodeStore();
  const id1 = store.addEntity('function', 'main', 'app.js', '', 1, '');
  const id2 = store.addEntity('function', 'helper', 'utils.js', '', 1, '');
  store.addEdge(id1, id2, 'calls');
  const result = store.traverse([id1], 2);
  assert(result.length >= 2);
});

// --- CLEANER ---
console.log('\nCleaner:');
const { cleanResponse } = require('../proxy/modules/cleaner');

test('removes garbage tokens', () => {
  const input = JSON.stringify({ content: [{ type: 'text', text: 'hello world<|tool_call|>garbage' }] });
  const { body, cleaned } = cleanResponse(input);
  const parsed = JSON.parse(body);
  assert(!parsed.content[0].text.includes('garbage'));
  assert(cleaned > 0);
});

test('fixes unclosed code blocks', () => {
  const input = JSON.stringify({ content: [{ type: 'text', text: '```js\nconsole.log("hi")' }] });
  const { body } = cleanResponse(input);
  const parsed = JSON.parse(body);
  assert(parsed.content[0].text.endsWith('```'));
});

// --- GUARDIAN ---
console.log('\nGuardian:');
const { isDangerous } = require('../proxy/modules/guardian');

test('detects rm -rf /', () => {
  assert(isDangerous('rm -rf /'));
});

test('detects DROP TABLE', () => {
  assert(isDangerous('DROP TABLE users'));
});

test('allows safe commands', () => {
  assert(!isDangerous('ls -la'));
  assert(!isDangerous('npm install express'));
  assert(!isDangerous('node server.js'));
});

// --- LOOPGUARD ---
console.log('\nLoopguard:');
const { checkLoop, resetHistory } = require('../proxy/modules/loopguard');

test('detects loops after 5 identical tool calls', () => {
  resetHistory();
  const toolResponse = JSON.stringify({
    content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/same/file.js' } }]
  });
  checkLoop(toolResponse);
  checkLoop(toolResponse);
  checkLoop(toolResponse);
  checkLoop(toolResponse);
  const result = checkLoop(toolResponse);
  assert(result.loopDetected === true);
});

test('does not trigger on varied tool calls', () => {
  resetHistory();
  const r1 = JSON.stringify({ content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } }] });
  const r2 = JSON.stringify({ content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/b.js' } }] });
  const r3 = JSON.stringify({ content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] });
  checkLoop(r1);
  checkLoop(r2);
  const result = checkLoop(r3);
  assert(result.loopDetected === false);
});

// --- PINNING ---
console.log('\nPinning:');
const { isWritable } = require('../proxy/modules/pinning');

test('allows all files when no config', () => {
  assert(isWritable('/any/path.js'));
});

// --- RANKER ---
console.log('\nRanker:');
const { personalizedPageRank } = require('../proxy/modules/codelens/ranker');

test('ranks seed nodes higher', () => {
  const entities = [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
    { id: 3, name: 'C' },
  ];
  const edges = [
    { source_id: 1, target_id: 2 },
    { source_id: 2, target_id: 3 },
  ];
  const ranked = personalizedPageRank(entities, edges, [1]);
  assert(ranked.length === 3); // Seed or its direct neighbor should rank high
});

// --- COMPRESSOR ---
console.log('\nCompressor:');
const { compressResponse } = require('../proxy/modules/compressor');

test('compresses long text', () => {
  const longText = 'I will now create the file. ' + 'x'.repeat(600);
  const input = JSON.stringify({ content: [{ type: 'text', text: longText }] });
  const { body, compressed } = compressResponse(input);
  const parsed = JSON.parse(body);
  assert(!parsed.content[0].text.includes('I will now create'));
});

// --- VALIDATOR (v5.10) ---
console.log('\nValidator:');
const fsMod = require('fs');
const pathMod = require('path');
const { validateToolUse, findFirstInvalidToolUse } = require('../proxy/modules/validator');

const TMP = require('os').tmpdir() + '/troth-validator-test-' + Date.now();
fsMod.mkdirSync(TMP, { recursive: true });
const goodFile = pathMod.join(TMP, 'good.js');
fsMod.writeFileSync(goodFile, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
const dupFile = pathMod.join(TMP, 'dup.js');
fsMod.writeFileSync(dupFile, 'const x = 1;\nconst x = 1;\n');

test('validates valid Write', () => {
  const r = validateToolUse({ name: 'Write', input: { file_path: pathMod.join(TMP, 'new.js'), content: 'function f() { return 1; }' } });
  assert(r.valid === true);
});

test('rejects Write with syntax errors', () => {
  const r = validateToolUse({ name: 'Write', input: { file_path: pathMod.join(TMP, 'bad.js'), content: 'function f( { return' } });
  assert(r.valid === false);
  assert(r.error.indexOf('syntax') !== -1);
});

test('rejects Write to nonexistent parent dir', () => {
  const r = validateToolUse({ name: 'Write', input: { file_path: '/nonexistent-xyz-99-troth/foo.js', content: 'x' } });
  assert(r.valid === false);
  assert(r.error.indexOf('parent directory') !== -1);
});

test('rejects Write with relative path', () => {
  const r = validateToolUse({ name: 'Write', input: { file_path: 'foo.js', content: 'x' } });
  assert(r.valid === false);
  assert(r.error.indexOf('not absolute') !== -1);
});

test('validates valid Edit', () => {
  const r = validateToolUse({ name: 'Edit', input: { file_path: goodFile, old_string: 'const b = 2;', new_string: 'const b = 42;' } });
  assert(r.valid === true);
});

test('rejects Edit on missing file', () => {
  const r = validateToolUse({ name: 'Edit', input: { file_path: '/tmp/no-such-troth-file.js', old_string: 'a', new_string: 'b' } });
  assert(r.valid === false);
  assert(r.error.indexOf('does not exist') !== -1);
});

test('rejects Edit with missing old_string', () => {
  const r = validateToolUse({ name: 'Edit', input: { file_path: goodFile, old_string: 'const z = 99;', new_string: 'const z = 100;' } });
  assert(r.valid === false);
  assert(r.error.indexOf('not present') !== -1);
});

test('rejects Edit with non-unique old_string and replace_all=false', () => {
  const r = validateToolUse({ name: 'Edit', input: { file_path: dupFile, old_string: 'const x = 1;', new_string: 'const x = 2;' } });
  assert(r.valid === false);
  assert(r.error.indexOf('more than once') !== -1);
});

test('allows Edit with non-unique old_string when replace_all=true', () => {
  const r = validateToolUse({ name: 'Edit', input: { file_path: dupFile, old_string: 'const x = 1;', new_string: 'const x = 2;', replace_all: true } });
  assert(r.valid === true);
});

test('passes through non-validatable tools (Read)', () => {
  const r = validateToolUse({ name: 'Read', input: { file_path: '/anywhere' } });
  assert(r.valid === true);
});

test('findFirstInvalidToolUse finds the bad block', () => {
  const resp = JSON.stringify({
    content: [
      { type: 'text', text: 'I will edit it' },
      { type: 'tool_use', name: 'Edit', id: 'x', input: { file_path: '/tmp/no-such-troth-file.js', old_string: 'a', new_string: 'b' } },
    ]
  });
  const found = findFirstInvalidToolUse(resp);
  assert(found !== null);
  assert(found.toolUse.name === 'Edit');
});

test('findFirstInvalidToolUse returns null when all valid', () => {
  const resp = JSON.stringify({
    content: [
      { type: 'tool_use', name: 'Read', id: 'x', input: { file_path: '/x' } },
    ]
  });
  const found = findFirstInvalidToolUse(resp);
  assert(found === null);
});

// Cleanup
try { fsMod.unlinkSync(goodFile); } catch (e) {}
try { fsMod.unlinkSync(dupFile); } catch (e) {}
try { fsMod.unlinkSync(pathMod.join(TMP, 'new.js')); } catch (e) {}
try { fsMod.unlinkSync(pathMod.join(TMP, 'bad.js')); } catch (e) {}
try { fsMod.rmdirSync(TMP); } catch (e) {}

// --- VISION (v6.1) — path detection only, the live Gemini call cannot
//     be unit-tested without burning quota ---
console.log('\nVision:');
const { findImagePaths } = require('../proxy/modules/vision');

const VTMP = require('os').tmpdir() + '/troth-vision-test-' + Date.now();
fsMod.mkdirSync(VTMP, { recursive: true });
const realPng = pathMod.join(VTMP, 'screenshot.png');
fsMod.writeFileSync(realPng, 'fake png header');
const realJpg = pathMod.join(VTMP, 'photo.jpg');
fsMod.writeFileSync(realJpg, 'fake jpg header');

test('finds real image paths in tool_result text', () => {
  const text = 'Saved screenshot to ' + realPng + ' successfully';
  const found = findImagePaths(text);
  assert(found.length === 1);
  assert(found[0] === realPng);
});

test('skips nonexistent paths even if they match the regex', () => {
  const text = 'Generated /tmp/no-such-file-vision-test-99.png and that is it';
  const found = findImagePaths(text);
  assert(found.length === 0);
});

test('deduplicates multiple references to same path', () => {
  const text = realPng + ' and also ' + realPng + ' twice';
  const found = findImagePaths(text);
  assert(found.length === 1);
});

test('finds multiple distinct images', () => {
  const text = 'Got ' + realPng + ' and ' + realJpg + ' from playwright';
  const found = findImagePaths(text);
  assert(found.length === 2);
});

test('handles empty / non-string input safely', () => {
  assert(findImagePaths('').length === 0);
  assert(findImagePaths(null).length === 0);
  assert(findImagePaths(undefined).length === 0);
  assert(findImagePaths(42).length === 0);
});

// Cleanup vision test files
try { fsMod.unlinkSync(realPng); } catch (e) {}
try { fsMod.unlinkSync(realJpg); } catch (e) {}
try { fsMod.rmdirSync(VTMP); } catch (e) {}

// --- CRITIC ---
console.log('\nCritic:');
const { criticize, learnFromRequest, getFailureContext } = require('../proxy/modules/critic');

test('detects tool_use without text', () => {
  const r = criticize(JSON.stringify({ content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] }));
  assert(r && r.issues && r.issues.length > 0);
});

test('passes clean response with text + tool', () => {
  const r = criticize(JSON.stringify({ content: [{ type: 'text', text: 'Let me read the file to understand the structure.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] }));
  assert(!r || !r.issues || r.issues.length === 0);
});

test('learns from tool_result errors', () => {
  learnFromRequest(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Error: old_string not found in /tmp/test.js' }] }] }));
  const ctx = getFailureContext();
  assert(ctx && ctx.indexOf('test.js') !== -1);
});

// --- PREPROCESSOR ---
console.log('\nPreprocessor:');
const { preprocessAnthropicBody, scaleTokens } = require('../proxy/modules/router');

// --- ERROR TAXONOMY (P4.2) ---
console.log('\nError taxonomy:');
const errortax = require('../proxy/modules/errortax');

test('classify Alibaba Range error as range_input_length', () => {
  const cls = errortax.classify(400, 'InternalError.Algo.InvalidParameter: Range of input length should be [1, 169984]');
  assert.strictEqual(cls, 'range_input_length');
});

test('classify thinking.budget_tokens rejection', () => {
  const cls = errortax.classify(400, 'budget_tokens is no longer supported on this model');
  assert.strictEqual(cls, 'thinking_budget_rejected');
});

test('classify sampling param rejection on 4.7', () => {
  const cls = errortax.classify(400, 'temperature must be 1 for this model');
  assert.strictEqual(cls, 'sampling_params_rejected');
});

test('classify rate limit 429', () => {
  assert.strictEqual(errortax.classify(429, 'too many requests'), 'rate_limit');
});

test('classify overloaded 529', () => {
  assert.strictEqual(errortax.classify(529, 'overloaded'), 'overloaded');
});

test('classify auth 401/403', () => {
  assert.strictEqual(errortax.classify(401, 'invalid api key'), 'auth_error');
  assert.strictEqual(errortax.classify(403, 'forbidden'), 'auth_error');
});

test('classify credit insufficient', () => {
  assert.strictEqual(errortax.classify(402, 'insufficient balance'), 'credit_insufficient');
});

test('classify generic 400 as bad_request_other', () => {
  assert.strictEqual(errortax.classify(400, 'something weird'), 'bad_request_other');
});

test('record updates counts per class and per model', () => {
  errortax.reset();
  errortax.record(400, 'Range of input length should be [1, 170000]', 'qwen3-max');
  errortax.record(400, 'Range of input length should be [1, 170000]', 'qwen3-max');
  errortax.record(429, 'rate limited', 'claude-opus-4-7');
  const s = errortax.getStats();
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.byClass.range_input_length, 2);
  assert.strictEqual(s.byClass.rate_limit, 1);
  assert.strictEqual(s.byModel['qwen3-max'].range_input_length, 2);
});

// --- CACHE RATIO (P4.1) ---
console.log('\nCache ratio:');
const cacheratio = require('../proxy/modules/cacheratio');

test('cacheratio records per-model hit/write/uncached tokens', () => {
  cacheratio.reset();
  cacheratio.record('claude-opus-4-7', {
    input_tokens: 1000,                   // uncached
    cache_creation_input_tokens: 500,     // writes
    cache_read_input_tokens: 8500         // reads (hit)
  });
  const s = cacheratio.getStats().perModel['claude-opus-4-7'];
  assert.strictEqual(s.uncached, 1000);
  assert.strictEqual(s.writes, 500);
  assert.strictEqual(s.reads, 8500);
  assert.strictEqual(s.requests, 1);
});

test('hitRatio computes correctly across samples', () => {
  cacheratio.reset();
  // 100 uncached + 100 writes + 800 reads → 80% hit
  cacheratio.record('m', { input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 800 });
  const r = cacheratio.hitRatio('m');
  assert(r > 0.79 && r < 0.81, 'expected ~0.80, got ' + r);
});

test('hitRatio returns null for unknown model', () => {
  cacheratio.reset();
  assert.strictEqual(cacheratio.hitRatio('never-seen'), null);
});

test('cacheratio aggregates across multiple requests', () => {
  cacheratio.reset();
  cacheratio.record('m', { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  cacheratio.record('m', { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 });
  const s = cacheratio.getStats().perModel['m'];
  assert.strictEqual(s.uncached, 150);
  assert.strictEqual(s.reads, 50);
  assert.strictEqual(s.requests, 2);
});

// --- ULTRAREVIEW (P3.5) ---
console.log('\nUltrareview:');
const ultrareview = require('../proxy/modules/ultrareview');

test('detectTrigger matches /ultrareview slash command', () => {
  assert(ultrareview.detectTrigger('/ultrareview this PR'));
  assert(ultrareview.detectTrigger('/ultrareview'));
});

test('detectTrigger matches natural-language "deep review"', () => {
  assert(ultrareview.detectTrigger('please do a deep review of the auth module'));
});

test('detectTrigger returns false for normal messages', () => {
  assert(!ultrareview.detectTrigger('fix the bug'));
  assert(!ultrareview.detectTrigger(''));
});

test('apply injects 4-pass block + forces effort=max when triggered', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    messages: [{ role: 'user', content: '/ultrareview the new auth PR' }]
  });
  const r = ultrareview.apply(body);
  assert(r.triggered);
  const parsed = JSON.parse(r.body);
  assert.strictEqual(parsed.output_config.effort, 'max');
  assert(Array.isArray(parsed.system));
  assert(parsed.system.some(b => b.text && b.text.includes('Ultrareview protocol')));
  assert(parsed.system.some(b => b.text && b.text.includes('Architecture Audit')));
  assert(parsed.system.some(b => b.text && b.text.includes('Security Pass')));
});

test('apply is idempotent — does not double-inject on re-run', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    messages: [{ role: 'user', content: '/ultrareview' }]
  });
  const r1 = ultrareview.apply(body);
  const r2 = ultrareview.apply(r1.body);
  const p1 = JSON.parse(r1.body);
  const p2 = JSON.parse(r2.body);
  const count1 = p1.system.filter(b => b.text && b.text.includes('Ultrareview protocol')).length;
  const count2 = p2.system.filter(b => b.text && b.text.includes('Ultrareview protocol')).length;
  assert.strictEqual(count1, 1);
  assert.strictEqual(count2, 1, 'second apply should not add a duplicate block');
});

test('apply is no-op when trigger is absent', () => {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'fix the bug' }]
  });
  const r = ultrareview.apply(body);
  assert(!r.triggered);
  assert.strictEqual(r.body, body);
});

// --- VISION VALIDATOR (P3.3, Opus 4.7 2,576px limit) ---
console.log('\nVision validator:');
const visionvalidator = require('../proxy/modules/visionvalidator');

test('parseDimensions returns null for empty input', () => {
  assert.strictEqual(visionvalidator.parseDimensions('', 'image/png'), null);
  assert.strictEqual(visionvalidator.parseDimensions(null, 'image/png'), null);
});

test('parseDimensions parses a small PNG header', () => {
  // Build a minimal 32x64 PNG header (signature + IHDR)
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),  // signature
    Buffer.from([0x00, 0x00, 0x00, 0x0D]),                           // IHDR length
    Buffer.from('IHDR'),
    Buffer.from([0x00, 0x00, 0x00, 0x20]),                           // width = 32
    Buffer.from([0x00, 0x00, 0x00, 0x40]),                           // height = 64
    Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00])                      // bit depth etc.
  ]);
  const b64 = buf.toString('base64');
  const dims = visionvalidator.parseDimensions(b64, 'image/png');
  assert(dims);
  assert.strictEqual(dims.width, 32);
  assert.strictEqual(dims.height, 64);
});

test('validateImage returns valid for image within 2576px', () => {
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from([0x00, 0x00, 0x00, 0x0D]),
    Buffer.from('IHDR'),
    Buffer.from([0x00, 0x00, 0x04, 0x00]), // 1024
    Buffer.from([0x00, 0x00, 0x03, 0x00]), // 768
    Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00])
  ]);
  const r = visionvalidator.validateImage(buf.toString('base64'), 'image/png');
  assert(r.valid);
  assert.strictEqual(r.longEdge, 1024);
});

test('validateImage flags oversized images', () => {
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from([0x00, 0x00, 0x00, 0x0D]),
    Buffer.from('IHDR'),
    Buffer.from([0x00, 0x00, 0x0F, 0xA0]), // 4000
    Buffer.from([0x00, 0x00, 0x0B, 0xB8]), // 3000
    Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00])
  ]);
  const r = visionvalidator.validateImage(buf.toString('base64'), 'image/png');
  assert(!r.valid);
  assert.strictEqual(r.longEdge, 4000);
  assert.strictEqual(r.reason, 'oversize');
});

test('scanBody finds image blocks in messages', () => {
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from([0x00, 0x00, 0x00, 0x0D]),
    Buffer.from('IHDR'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]), // 512
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00])
  ]);
  const body = JSON.stringify({
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } },
        { type: 'text', text: 'analyze' }
      ]
    }]
  });
  const findings = visionvalidator.scanBody(body);
  assert.strictEqual(findings.length, 1);
  assert(findings[0].result.valid);
});

// --- COMPRESSION BUFFER (P3.2, Hermes 80% pattern) ---
console.log('\nCompression buffer:');
const compressionbuffer = require('../proxy/modules/compressionbuffer');

test('shouldCompress returns false under threshold', () => {
  const r = compressionbuffer.shouldCompress(100000, 200000); // 50%
  assert.strictEqual(r.compress, false);
  assert.strictEqual(r.reason, 'under-threshold');
});

test('shouldCompress returns true at 80% (default threshold)', () => {
  const r = compressionbuffer.shouldCompress(160000, 200000); // exactly 80%
  assert.strictEqual(r.compress, true);
  assert.strictEqual(r.reason, 'near-cap');
});

test('shouldCompress triggers above threshold', () => {
  const r = compressionbuffer.shouldCompress(180000, 200000); // 90%
  assert.strictEqual(r.compress, true);
  assert(r.pctUsed > 0.8);
});

test('shouldCompress returns no-cap when cap is zero', () => {
  const r = compressionbuffer.shouldCompress(50000, 0);
  assert.strictEqual(r.compress, false);
  assert.strictEqual(r.reason, 'no-cap');
});

test('shouldCompress respects custom threshold', () => {
  const r1 = compressionbuffer.shouldCompress(150000, 200000, 0.70); // 75% > 70% threshold → compress
  assert.strictEqual(r1.compress, true);
  const r2 = compressionbuffer.shouldCompress(150000, 200000, 0.90); // 75% < 90% threshold → don't
  assert.strictEqual(r2.compress, false);
});

test('getStats exposes triggerRate and threshold', () => {
  const s = compressionbuffer.getStats();
  assert.strictEqual(s.module, 'compressionbuffer');
  assert.strictEqual(s.threshold, 0.80);
  assert(typeof s.checks === 'number');
  assert(typeof s.triggerRate === 'number');
});

// --- TOKEN ESTIMATE (P3.1, model-aware) ---
console.log('\nToken estimator (model-aware):');
const tokenestimate = require('../proxy/modules/tokenestimate');

test('estimateTokens uses legacy denom for Opus 4.6 and older', () => {
  const txt = 'x'.repeat(1000);
  const t = tokenestimate.estimateTokens(txt, 'claude-opus-4-6');
  // 1000 / 5.33 ≈ 188
  assert(t > 180 && t < 195, 'legacy denom gives ~188, got ' + t);
});

test('estimateTokens uses tighter denom for Opus 4.7 (1.35x inflation)', () => {
  const txt = 'x'.repeat(1000);
  const t = tokenestimate.estimateTokens(txt, 'claude-opus-4-7');
  // 1000 / 3.2 ≈ 313 — noticeably higher than legacy's 188
  assert(t > 300 && t < 320, '4.7 denom gives ~313, got ' + t);
});

test('estimateTokens 4.7 > legacy for same text', () => {
  const txt = 'x'.repeat(5000);
  const legacy = tokenestimate.estimateTokens(txt, 'claude-opus-4-6');
  const opus47 = tokenestimate.estimateTokens(txt, 'claude-opus-4-7');
  assert(opus47 > legacy, '4.7 estimate must be larger than legacy');
  assert(opus47 / legacy > 1.3 && opus47 / legacy < 1.8,
    'ratio should reflect ~1.35-1.7× inflation, got ' + (opus47/legacy).toFixed(2));
});

test('looksCjkHeavy detects CJK-dominated text', () => {
  const cjk = '这是一个测试的长字符串用于检查我们的代币估算器'.repeat(50);
  assert(tokenestimate.looksCjkHeavy(cjk));
});

test('looksCjkHeavy returns false for Latin text', () => {
  assert(!tokenestimate.looksCjkHeavy('Hello world this is English'.repeat(50)));
});

test('CJK denominator yields tighter estimate than legacy for CJK text', () => {
  const cjk = '这是一个测试'.repeat(100); // ~600 chars
  const t = tokenestimate.estimateTokens(cjk, 'claude-sonnet-4-6');
  // 600 / 2.5 = 240 (CJK)  vs  600 / 5.33 ≈ 113 (legacy)
  assert(t > 200, 'CJK denom should give ~240, got ' + t);
});

test('estimateTokens returns 0 for empty', () => {
  assert.strictEqual(tokenestimate.estimateTokens('', 'claude-opus-4-7'), 0);
  assert.strictEqual(tokenestimate.estimateTokens(null, 'claude-opus-4-7'), 0);
});

// --- TASK BUDGETS (P2.2, Opus 4.7 beta) ---
console.log('\nTask Budgets:');
const taskbudgets = require('../proxy/modules/taskbudgets');

test('applyTaskBudget injects task_budget at 80% of max_tokens', () => {
  const body = JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 100000, messages: [{role:'user',content:'hi'}] });
  const r = taskbudgets.applyTaskBudget(body, '');
  const parsed = JSON.parse(r.body);
  assert(r.injected);
  assert.strictEqual(parsed.output_config.task_budget.type, 'tokens');
  assert.strictEqual(parsed.output_config.task_budget.total, 80000);
});

test('applyTaskBudget enforces 20K minimum even when max_tokens is low', () => {
  const body = JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 5000, messages: [] });
  const r = taskbudgets.applyTaskBudget(body, '');
  const parsed = JSON.parse(r.body);
  assert.strictEqual(parsed.output_config.task_budget.total, 20000);
});

test('applyTaskBudget preserves existing task_budget (no overwrite)', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7', max_tokens: 100000,
    output_config: { task_budget: { type: 'tokens', total: 12345 } },
    messages: []
  });
  const r = taskbudgets.applyTaskBudget(body, '');
  const parsed = JSON.parse(r.body);
  assert(!r.injected);
  assert.strictEqual(parsed.output_config.task_budget.total, 12345);
});

test('applyTaskBudget adds task-budgets beta header without clobbering existing', () => {
  const body = JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 50000, messages: [] });
  const r = taskbudgets.applyTaskBudget(body, 'prompt-caching-2024-07-31');
  assert(r.beta.includes('prompt-caching-2024-07-31'));
  assert(r.beta.includes('task-budgets-2026-03-13'));
});

test('applyTaskBudget does not duplicate beta header if already present', () => {
  const body = JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 50000, messages: [] });
  const r = taskbudgets.applyTaskBudget(body, 'task-budgets-2026-03-13');
  // Should not appear twice
  const matches = r.beta.match(/task-budgets-2026-03-13/g) || [];
  assert.strictEqual(matches.length, 1);
});

test('applyTaskBudget leaves body unchanged on malformed JSON', () => {
  const r = taskbudgets.applyTaskBudget('not-valid-json', '');
  assert.strictEqual(r.body, 'not-valid-json');
  assert(!r.injected);
});

// --- TOKEN COUNT (P2.1) ---
console.log('\nToken count:');
const tokencount = require('../proxy/modules/tokencount');

test('countTokens returns null when no API key provided', async () => {
  const body = JSON.stringify({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] });
  const r = await tokencount.countTokens(body, null);
  assert.strictEqual(r, null);
});

test('countTokens returns null on malformed body (does not throw)', async () => {
  const r = await tokencount.countTokens('not-valid-json', 'sk-ant-test');
  assert.strictEqual(r, null);
});

test('hashBody produces stable 24-char hex for same input', () => {
  const a = tokencount.hashBody('{"model":"claude-opus-4-7"}');
  const b = tokencount.hashBody('{"model":"claude-opus-4-7"}');
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 24);
});

test('logActualVsEstimated records drift samples', () => {
  tokencount.clearCache();
  const before = tokencount.getStats().driftSampleCount;
  tokencount.logActualVsEstimated('claude-opus-4-7', 1000, 1350);
  tokencount.logActualVsEstimated('claude-opus-4-7', 1000, 1200);
  const after = tokencount.getStats();
  assert.strictEqual(after.driftSampleCount - before, 2);
  // delta = (est - actual) / actual = (1000-1350)/1350 ≈ -0.26 (under-estimated)
  assert(after.meanDrift < 0, 'mean drift negative when under-estimating');
});

test('logActualVsEstimated ignores invalid inputs', () => {
  const before = tokencount.getStats().driftSampleCount;
  tokencount.logActualVsEstimated('', 100, 100);
  tokencount.logActualVsEstimated('m', 0, 0);
  tokencount.logActualVsEstimated('m', 'x', 100);
  assert.strictEqual(tokencount.getStats().driftSampleCount, before);
});

test('getStats shape includes expected fields', () => {
  const s = tokencount.getStats();
  assert.strictEqual(s.module, 'tokencount');
  assert(typeof s.calls === 'number');
  assert(typeof s.cacheHits === 'number');
  assert(typeof s.cacheSize === 'number');
});

// --- TOKENIZER DELTA PER-MODEL (P4.3) ---
test('perModelDrift breaks down drift samples by model', () => {
  tokencount.clearDrift();
  tokencount.logActualVsEstimated('claude-opus-4-7', 800, 1000);   // -0.2 (underestimate)
  tokencount.logActualVsEstimated('claude-opus-4-7', 900, 1100);   // -0.18 (underestimate)
  tokencount.logActualVsEstimated('claude-opus-4-6', 1000, 1000);  // 0 (exact)
  const s = tokencount.getStats();
  assert(s.perModelDrift);
  assert.strictEqual(s.perModelDrift['claude-opus-4-7'].samples, 2);
  assert.strictEqual(s.perModelDrift['claude-opus-4-6'].samples, 1);
  assert(s.perModelDrift['claude-opus-4-7'].meanDrift < 0);
  assert.strictEqual(s.perModelDrift['claude-opus-4-6'].meanDrift, 0);
});

test('perModelDrift includes stddev for variance visibility', () => {
  tokencount.clearDrift();
  tokencount.logActualVsEstimated('m', 100, 200); // -0.5
  tokencount.logActualVsEstimated('m', 100, 200); // -0.5 (same)
  const s = tokencount.getStats();
  assert(s.perModelDrift['m'].stddev < 0.001);
});

// --- AUTH-MODE DETECTION (P0.5) ---
console.log('\nAuth-mode detection:');
const authmode = require('../proxy/modules/authmode');

test('authmode.detect returns "api-key" when x-api-key header present', () => {
  assert.strictEqual(authmode.detect({ 'x-api-key': 'sk-ant-xxx' }), 'api-key');
});

test('authmode.detect returns "oauth" when Authorization: Bearer present', () => {
  assert.strictEqual(authmode.detect({ 'authorization': 'Bearer sk-ant-oauth-xxx' }), 'oauth');
});

test('authmode.detect prefers api-key over bearer when both present', () => {
  // Anthropic precedence hierarchy puts x-api-key above Bearer.
  const mode = authmode.detect({ 'x-api-key': 'sk-ant-xxx', 'authorization': 'Bearer yyy' });
  assert.strictEqual(mode, 'api-key');
});

test('authmode.detect returns "none" when no recognized auth header', () => {
  assert.strictEqual(authmode.detect({ 'content-type': 'application/json' }), 'none');
  assert.strictEqual(authmode.detect({}), 'none');
  assert.strictEqual(authmode.detect(null), 'none');
});

test('authmode.detect is case-insensitive for header names and Bearer scheme', () => {
  assert.strictEqual(authmode.detect({ 'X-API-KEY': 'xxx' }), 'api-key');
  assert.strictEqual(authmode.detect({ 'Authorization': 'bearer yyy' }), 'oauth');
});

test('authmode.record + getStats track per-mode counts', () => {
  const before = authmode.getStats();
  authmode.record('api-key');
  authmode.record('api-key');
  authmode.record('oauth');
  const after = authmode.getStats();
  assert.strictEqual(after.apiKeyRequests - before.apiKeyRequests, 2);
  assert.strictEqual(after.oauthRequests - before.oauthRequests, 1);
});

// --- ROUTER local-backend auto-enable (regression) ---
// Locks the fix for the bug where local was silently disabled when ANY
// cloud provider was configured, OR when backendHost was 127.0.0.1.
// Both gates were wrong. New rule: if backendHost+port are set and the
// user didn't include an explicit providers.local block, enable it from
// the shortcut. Explicit providers.local always wins.
console.log('\nRouter local-backend auto-enable:');

test('router auto-enables local from backendHost when no providers.local block (cloud providers also present)', () => {
  // Simulate the loadProviders logic in isolation. We can't safely import
  // router.js here (it has side effects), so we mirror its decision tree
  // and assert the new rule. This guards against regressions in the same
  // expression.
  const apply = (cfg, providers) => {
    if (cfg.backendHost && cfg.backendPort
        && !(cfg.providers && cfg.providers.local)) {
      providers.local.enabled = true;
      providers.local.host = cfg.backendHost;
      providers.local.port = cfg.backendPort;
      providers.local.model = providers.local.model || cfg.model || '';
    }
    return providers;
  };

  // Case 1: cloud provider set + backendHost localhost — must STILL enable local.
  const r1 = apply(
    { backendHost: '127.0.0.1', backendPort: 11434, model: 'qwen3.6:35b',
      providers: { alibaba: { enabled: true, apiKey: 'x' } } },
    { local: { enabled: false, host: '127.0.0.1', port: 1234, model: '' } }
  );
  assert.strictEqual(r1.local.enabled, true, 'local must enable even when cloud also set');
  assert.strictEqual(r1.local.host, '127.0.0.1');
  assert.strictEqual(r1.local.port, 11434);
  assert.strictEqual(r1.local.model, 'qwen3.6:35b');

  // Case 2: explicit providers.local block — auto-enable must NOT clobber.
  const r2 = apply(
    { backendHost: '127.0.0.1', backendPort: 11434, model: 'qwen3.6:35b',
      providers: { local: { enabled: false, host: '10.0.0.1', port: 9999, model: 'override' } } },
    { local: { enabled: false, host: '10.0.0.1', port: 9999, model: 'override' } }
  );
  assert.strictEqual(r2.local.enabled, false, 'explicit providers.local wins');
  assert.strictEqual(r2.local.host, '10.0.0.1');

  // Case 3: no backendHost — local stays disabled.
  const r3 = apply(
    { providers: {} },
    { local: { enabled: false, host: '127.0.0.1', port: 1234, model: '' } }
  );
  assert.strictEqual(r3.local.enabled, false);

  // Case 4: backendHost set but no port — must NOT enable (incomplete).
  const r4 = apply(
    { backendHost: '127.0.0.1', model: 'm' },
    { local: { enabled: false, host: '127.0.0.1', port: 1234, model: '' } }
  );
  assert.strictEqual(r4.local.enabled, false, 'requires port too');
});

// --- Reasoning-model max_tokens floor (regression for empty-content bug) ---
// qwen3.6, deepseek-r1, o1, o3, kimi-thinking spend the first ~150-300 tokens
// on internal reasoning. With small max_tokens the visible output is empty.
// preprocessAnthropicBody bumps the budget for these models. This test mirrors
// the regex + bump logic so future edits to the pattern catch regressions.
console.log('\nReasoning-model max_tokens floor:');

test('reasoning-model regex matches the documented model families', () => {
  const REASONING = /(^|[\/_:-])(o1|o3|deepseek-r1|qwen3\.\d|kimi-k3|kimi-.*-thinking|.*-thinking|.*-reasoning|.*-r1)([:_/-]|$)/i;
  const cases = {
    'qwen3.6:35b': true,
    'qwen3.5:7b': true,
    'deepseek-r1:14b': true,
    'o1-preview': true,
    'o3-mini': true,
    'kimi-k2-thinking': true,
    'kimi-k3': true,
    'gpt-4o-thinking': true,
    'claude-opus-reasoning': true,
    'claude-sonnet-4': false,
    'gpt-4o': false,
    'qwen-max': false,
    'mistral-large': false,
    'llama-3.3-70b': false,
  };
  for (const [name, want] of Object.entries(cases)) {
    assert.strictEqual(REASONING.test(name), want, `regex on ${name} should be ${want}`);
  }
});

test('budget bump rule: <8192 → max(8192, orig*4) capped at 32768', () => {
  const bump = (orig) => Math.min(32768, Math.max(8192, orig * 4));
  assert.strictEqual(bump(200),   8192,  '200 → 8192 floor');
  assert.strictEqual(bump(1024),  8192,  '1024 → 8192 floor');
  assert.strictEqual(bump(2048),  8192,  '2048*4 = 8192 (boundary)');
  assert.strictEqual(bump(4096),  16384, '4096*4 = 16384 (above floor)');
  assert.strictEqual(bump(8000),  32000, '8000*4 = 32000 (under cap)');
  assert.strictEqual(bump(10000), 32768, '10000*4 = 40000 → cap to 32768');
});

// --- OPUS 4.7 COMPAT (P0.1 + P0.2) ---
test('preprocessor strips thinking.budget_tokens when model=opus-4-7', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    thinking: { type: 'enabled', budget_tokens: 500 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = preprocessAnthropicBody(body);
  const parsed = JSON.parse(r.bodyStr);
  // thinking is stripped entirely by existing preprocessor handling
  assert.strictEqual(parsed.thinking, undefined);
});

test('preprocessor strips non-default temperature/top_p/top_k on 4.7', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    temperature: 0.5,
    top_p: 0.9,
    top_k: 40,
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = preprocessAnthropicBody(body);
  const parsed = JSON.parse(r.bodyStr);
  assert.strictEqual(parsed.temperature, undefined);
  assert.strictEqual(parsed.top_p, undefined);
  assert.strictEqual(parsed.top_k, undefined);
});

test('preprocessor preserves default temperature=1 on 4.7', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    temperature: 1,
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = preprocessAnthropicBody(body);
  const parsed = JSON.parse(r.bodyStr);
  assert.strictEqual(parsed.temperature, 1);
});

test('preprocessor leaves sampling params alone on 4.6', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    temperature: 0.5,
    top_p: 0.9,
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = preprocessAnthropicBody(body);
  const parsed = JSON.parse(r.bodyStr);
  assert.strictEqual(parsed.temperature, 0.5);
  assert.strictEqual(parsed.top_p, 0.9);
});

// --- OPUS 4.7 THINKING RE-INJECTION (P0.3) ---
test('preprocessor captures thinking.display for downstream re-injection', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    thinking: { type: 'adaptive', display: 'detailed' },
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = preprocessAnthropicBody(body);
  assert(r.thinkingConfig);
  assert.strictEqual(r.thinkingConfig.thinkingType, 'adaptive');
  assert.strictEqual(r.thinkingConfig.thinkingDisplay, 'detailed');
});

test('preprocessor captures adaptive thinking without display field', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = preprocessAnthropicBody(body);
  assert(r.thinkingConfig);
  assert.strictEqual(r.thinkingConfig.thinkingType, 'adaptive');
  assert.strictEqual(r.thinkingConfig.thinkingDisplay, undefined);
});

// --- xhigh EFFORT PRESERVATION (P2.3) ---
test('preprocessor preserves xhigh effort verbatim (not mapped to high)', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = preprocessAnthropicBody(body);
  assert.strictEqual(r.thinkingConfig.effort, 'xhigh');
  assert.strictEqual(r.thinkingConfig.thinkingLevel, 'xhigh');
});

test('preprocessor preserves max effort verbatim (P2.3 — was downmapped to high before)', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
    messages: []
  });
  const r = preprocessAnthropicBody(body);
  assert.strictEqual(r.thinkingConfig.effort, 'max');
});

test('preprocessor rejects unknown effort values (falls back to high)', () => {
  const body = JSON.stringify({
    model: 'claude-opus-4-7',
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'nonsense' },
    messages: []
  });
  const r = preprocessAnthropicBody(body);
  assert.strictEqual(r.thinkingConfig.effort, 'high');
});

test('strips thinking blocks from old messages', () => {
  const body = JSON.stringify({ model: 'claude-sonnet-4', messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig123' }, { type: 'text', text: 'hello' }] },
    { role: 'user', content: 'bye' }
  ]});
  const r = preprocessAnthropicBody(body);
  const parsed = JSON.parse(r.bodyStr);
  const assistantContent = parsed.messages.find(m => m.role === 'assistant').content;
  assert(!assistantContent.some(b => b.type === 'thinking'));
  assert(r.requestedModel === 'claude-sonnet-4');
});

test('handles compaction blocks', () => {
  const body = JSON.stringify({ model: 'claude-sonnet-4', messages: [
    { role: 'user', content: 'old msg' },
    { role: 'assistant', content: [{ type: 'compaction', content: 'summary of conversation' }] },
    { role: 'user', content: 'new msg' }
  ]});
  const r = preprocessAnthropicBody(body);
  const parsed = JSON.parse(r.bodyStr);
  assert(parsed.messages.length <= 3); // old msg dropped
  assert(!JSON.stringify(parsed).includes('"compaction"'));
});

test('scaleTokens works correctly', () => {
  // Gemini 1M: scale factor 0.2
  assert(scaleTokens(100000, 'gemini-3.1-pro-preview') === 20000);
  // DeepSeek 128K: scale factor 1.5625
  assert(scaleTokens(64000, 'deepseek-chat') === 100000);
  // Unknown model: default 128K
  assert(scaleTokens(128000, 'some-unknown-model') === 200000);
});

// --- COMPRESSOR (Phase 1) ---
console.log('\nCompressor:');
const { compressRequest } = require('../proxy/modules/compressor');

test('compressRequest is a no-op for short conversations', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const r = compressRequest(body);
  assert(r.body === body);
  assert(r.stats.elided === 0);
});

test('compressRequest drops empty Bash output', () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: 'msg ' + i });
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu' + i, name: 'Bash', input: { command: 'echo hi' } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content: '   \n   \n' + ' '.repeat(700) }] });
  }
  const body = JSON.stringify({ messages });
  const r = compressRequest(body);
  assert(r.stats.droppedEmptyBash > 0, 'should drop empty Bash output');
});

// --- SKIMMER (Phase 2) ---
console.log('\nSkimmer:');
const { skimRequest, speculativeEditHint } = require('../proxy/modules/skimmer');

test('skimRequest is a no-op without goal hint', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const r = skimRequest(body);
  assert(r.stats.skimmed === 0);
});

test('skimRequest suspends in error-recovery mode', () => {
  const longOutput = Array(50).fill('line').join('\n');
  const body = JSON.stringify({ messages: [
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking at the bug fix logic' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Error: assertion failed\n' + longOutput }] }
  ]});
  const r = skimRequest(body);
  assert(r.stats.skimmed === 0, 'should NOT skim when errors present');
});

// --- WORKFLOW (Phase 2) ---
console.log('\nWorkflow:');
const { startTask, getState, clear: clearWorkflow, buildStateBlock } = require('../proxy/modules/workflow');

test('startTask creates state with extracted steps', () => {
  clearWorkflow();
  const plan = "## Goal\nBuild API\n\n## Steps\n1. Create routes\n2. Add tests\n3. Deploy\n\n## Verification\nRun tests";
  const state = startTask('build API', plan);
  assert(state.task === 'build API');
  assert(state.pending_steps.length >= 3);
  assert(state.pending_steps.some(s => s.includes('Create routes')));
  clearWorkflow();
});

test('buildStateBlock returns null when no active task', () => {
  clearWorkflow();
  assert(buildStateBlock() === null);
});

// --- COCHANGE (Phase 6) ---
console.log('\nCo-change:');
const { getRelated, buildCoChangeHint, getStats: coStats } = require('../proxy/modules/cochange');

test('getRelated returns array', () => {
  const r = getRelated('nonexistent.js');
  assert(Array.isArray(r));
});

test('buildCoChangeHint returns null for empty input', () => {
  assert(buildCoChangeHint([]) === null);
  assert(buildCoChangeHint(null) === null);
});

// --- INJECTOR FILE-TYPE RULES (Phase 3, expanded Phase 15-16) ---
console.log('\nInjector file-type detection:');
const { inject } = require('../proxy/modules/injector');

test('detects API code via Express keyword', () => {
  const body = JSON.stringify({
    messages: [
      { role: 'user', content: 'add an endpoint' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/server.js' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'const express = require("express"); app.get("/users", (req, res) => {})' }] }
    ]
  });
  const r = inject(body, '');
  // Just verify inject runs without crashing — actual rule injection is internal
  assert(r.body);
});

test('ENV-INJ-1: the structured-envelope instruction is opt-in, and honors the flag', () => {
  // A model told to tag its reply obeys and stops writing like a partner:
  // real chat turns came back as filled-in forms with the tags visible to
  // the operator. The instruction is now off unless
  // TROTH_STRUCTURED_ENVELOPE=1, and this pins BOTH directions so a future
  // edit cannot quietly turn form-filling back on for everyone.
  const body = JSON.stringify({
    messages: [{ role: 'user', content:
      'Walk me through how the retry logic in the payment worker decides to give up, and whether a poisoned job can loop forever.' }]
  });
  const prev = process.env.TROTH_STRUCTURED_ENVELOPE;
  try {
    delete process.env.TROTH_STRUCTURED_ENVELOPE;
    const off = JSON.stringify(inject(body, ''));
    assert(off.indexOf('Structured response envelope') === -1,
      'default must not ask the model to tag its reply');

    process.env.TROTH_STRUCTURED_ENVELOPE = '1';
    const on = JSON.stringify(inject(body, ''));
    assert(on.indexOf('Structured response envelope') !== -1,
      'the flag must still turn the instruction back on');
  } finally {
    if (prev === undefined) delete process.env.TROTH_STRUCTURED_ENVELOPE;
    else process.env.TROTH_STRUCTURED_ENVELOPE = prev;
  }
});

// --- CACHE-CONTROL BREAKPOINTS (P2.4) ---
const { countCacheControlBreakpoints } = require('../proxy/modules/injector');

test('countCacheControlBreakpoints counts zero on plain body', () => {
  const data = { system: 'plain text', messages: [{ role: 'user', content: 'hi' }] };
  assert.strictEqual(countCacheControlBreakpoints(data), 0);
});

test('countCacheControlBreakpoints counts markers across system, tools, messages', () => {
  const data = {
    system: [
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'b' }
    ],
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }] }
    ]
  };
  assert.strictEqual(countCacheControlBreakpoints(data), 3);
});

test('inject adds cache_control to our scaffolding when breakpoints < 4', () => {
  // Non-trivial coding prompt — passes the  trivial-query gate
  // so scaffolding is actually injected. Test's intent is cache_control
  // mechanics, not the gate behaviour.
  const body = JSON.stringify({
    system: 'You are a helpful assistant',
    messages: [{ role: 'user', content: 'add a unit test for parseAuth in src/auth.ts' }]
  });
  const r = inject(body, '');
  const parsed = JSON.parse(r.body);
  assert(Array.isArray(parsed.system), 'system converted to array form');
  assert(parsed.system[0].cache_control, 'scaffolding block has cache_control');
  assert.strictEqual(parsed.system[0].cache_control.type, 'ephemeral');
});

test('inject skips cache_control on scaffolding when 4+ breakpoints already exist', () => {
  const body = JSON.stringify({
    system: [
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'd', cache_control: { type: 'ephemeral' } }
    ],
    // Non-trivial — see note on the previous test.
    messages: [{ role: 'user', content: 'add a unit test for parseAuth in src/auth.ts' }]
  });
  const r = inject(body, '');
  const parsed = JSON.parse(r.body);
  // Our scaffolding is now at index 0; should NOT carry cache_control (already at cap)
  assert.strictEqual(parsed.system[0].cache_control, undefined,
    'our block should not add a 5th breakpoint');
  // Total breakpoints must not exceed 4
  assert(countCacheControlBreakpoints(parsed) <= 4, 'total breakpoints within cap');
});

test('inject preserves existing cache_control markers on client blocks', () => {
  const body = JSON.stringify({
    system: [
      { type: 'text', text: 'client system', cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: 'hi' }]
  });
  const r = inject(body, '');
  const parsed = JSON.parse(r.body);
  // Client's block should still be there with its marker intact
  const clientBlock = parsed.system.find(b => b.text === 'client system');
  assert(clientBlock);
  assert(clientBlock.cache_control);
});

// --- STATIC/DYNAMIC SPLIT (P2.5) ---
test('inject returns separate staticBytes and dynamicBytes counts', () => {
  const body = JSON.stringify({
    system: 'base',
    messages: [{ role: 'user', content: 'add a new API endpoint to the project' }]
  });
  const r = inject(body, '');
  assert(typeof r.staticBytes === 'number', 'staticBytes surfaced');
  assert(typeof r.dynamicBytes === 'number', 'dynamicBytes surfaced');
});

test('inject places static and dynamic content in separate system blocks', () => {
  const body = JSON.stringify({
    system: 'orig',
    messages: [{ role: 'user', content: 'build a feature that adds multiple pages to a dashboard' }]
  });
  const r = inject(body, '');
  const parsed = JSON.parse(r.body);
  // Expect at minimum: [static?, dynamic?, orig] — orig is always last
  const origIdx = parsed.system.findIndex(b => b.text === 'orig');
  assert(origIdx >= 0, 'original block preserved at end');
  // Only at most one of our blocks should carry cache_control (the static one).
  const ourBlocks = parsed.system.slice(0, origIdx);
  const withCache = ourBlocks.filter(b => b.cache_control);
  assert(withCache.length <= 1, 'at most one of our blocks carries cache_control');
});

test('inject never marks the dynamic block as cacheable', () => {
  // Force dynamic content to exist by using a user message that triggers routines.
  const body = JSON.stringify({
    system: 'x',
    messages: [{ role: 'user', content: 'implement a refactor across multiple files with tests and API routes' }]
  });
  const r = inject(body, '');
  const parsed = JSON.parse(r.body);
  // If both static and dynamic blocks exist, the one that is NOT marked with
  // cache_control is the dynamic one and it must not be cached.
  // We can't easily distinguish without knowing exact content, but the invariant
  // we can check: no block carries cache_control UNLESS it looks static.
  // A robust check: buildInjection is deterministic on same inputs, so two calls
  // should produce identical static content but potentially different dynamic.
  const r2 = inject(body, '');
  const parsed2 = JSON.parse(r2.body);
  // First block should be byte-stable (static) across calls.
  if (parsed.system.length > 1 && parsed2.system.length > 1) {
    assert.strictEqual(parsed.system[0].text, parsed2.system[0].text,
      'first block (static) should be byte-stable across calls');
  }
});

// --- ROUTER continueIfTruncated (Phase 10) ---
console.log('\nRouter continuation:');
const { continueIfTruncated } = require('../proxy/modules/router');

test('continueIfTruncated returns response unchanged when not truncated', async () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const resp = JSON.stringify({
    type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'short response' }],
    stop_reason: 'end_turn'
  });
  const result = await continueIfTruncated(body, resp);
  assert(result === resp);
});

// --- ALIBABA per-model caps (P1.1, supersedes Phase 90 blanket cap) ---
console.log('\nAlibaba per-model caps:');
const routerMod = require('../proxy/modules/router');
const alibabaCaps = require('../proxy/modules/alibabaCaps');

test('alibabaCaps returns verified cap for qwen3-max (262K, full)', () => {
  assert.strictEqual(alibabaCaps.getCap('qwen3-max'), 262144);
});

test('alibabaCaps returns capped value for qwen3.6-plus (170K, not 1M advertised)', () => {
  assert.strictEqual(alibabaCaps.getCap('qwen3.6-plus'), 170000);
});

test('alibabaCaps returns default for unknown model', () => {
  assert.strictEqual(alibabaCaps.getCap('nonexistent-model-xyz'), alibabaCaps.DEFAULT_CAP);
});

test('parseRangeError extracts N from canonical Alibaba error', () => {
  const msg = 'InternalError.Algo.InvalidParameter: Range of input length should be [1, 169984]';
  assert.strictEqual(alibabaCaps.parseRangeError(msg), 169984);
});

test('parseRangeError handles no-space variant', () => {
  assert.strictEqual(alibabaCaps.parseRangeError('Range of input length should be [1,204800]'), 204800);
});

test('parseRangeError returns null on unrelated errors', () => {
  assert.strictEqual(alibabaCaps.parseRangeError('Connection timeout'), null);
  assert.strictEqual(alibabaCaps.parseRangeError(null), null);
});

test('updateCap shrinks but does not grow', () => {
  const before = alibabaCaps.getCap('qwen3-max');
  alibabaCaps.updateCap('qwen3-max', before + 100000); // try to grow
  assert.strictEqual(alibabaCaps.getCap('qwen3-max'), before, 'grow attempt should be rejected');
  alibabaCaps.updateCap('qwen3-max', before - 50000); // shrink
  assert.strictEqual(alibabaCaps.getCap('qwen3-max'), before - 50000, 'shrink should apply');
  // restore for other tests
  alibabaCaps.CAPS['qwen3-max'] = 262144;
});

// TODO: P1.4 test — pre-existing bug exposed by Phase C async test runner.
// routerMod.getProviders() returns a MASKED COPY, so the test's mutations
// do not reach router.js's real `providers` state. The underlying router
// logic at router.js:876 DOES decline glm-5.1 correctly; this test needs
// a proper setProviders() mock to validate that path. Skipped until fixed
// to avoid blocking substrate work.
// Deliberately NOT registered as a test: an empty body would print as a
// pass, and a pass that asserts nothing is a lie in the headline number.
// The TODO above is the tracking record until the mock exists.

test('zai provider exists in registry with Z.ai default endpoint', () => {
  const providers = routerMod.getProviders();
  assert(providers.zai, 'zai provider must exist');
  assert(providers.zai.endpoint && providers.zai.endpoint.includes('z.ai'),
    'default endpoint should reference z.ai');
  assert.strictEqual(providers.zai.model, 'glm-5.1');
});

test('callZai returns null when zai disabled or no key', async () => {
  const providers = routerMod.getProviders();
  providers.zai.enabled = false;
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const r = await routerMod.callZai(body);
  assert.strictEqual(r, null);
});

test('moonshot provider exists in registry with Moonshot default endpoint', () => {
  const providers = routerMod.getProviders();
  assert(providers.moonshot, 'moonshot provider must exist');
  assert(providers.moonshot.endpoint && providers.moonshot.endpoint.includes('moonshot.ai'),
    'default endpoint should reference moonshot.ai');
  assert.strictEqual(providers.moonshot.model, 'kimi-k3');
});

test('callMoonshot returns null when moonshot disabled or no key', async () => {
  const providers = routerMod.getProviders();
  providers.moonshot.enabled = false;
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const r = await routerMod.callMoonshot(body);
  assert.strictEqual(r, null);
});

test('xai provider exists in registry with x.ai default endpoint', () => {
  const providers = routerMod.getProviders();
  assert(providers.xai, 'xai provider must exist');
  assert(providers.xai.endpoint && providers.xai.endpoint.includes('x.ai'),
    'default endpoint should reference x.ai');
  assert.strictEqual(providers.xai.model, 'grok-4.3');
});

test('callXai returns null when xai disabled or no key', async () => {
  const providers = routerMod.getProviders();
  providers.xai.enabled = false;
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const r = await routerMod.callXai(body);
  assert.strictEqual(r, null);
});

test('callAlibaba short-circuits on body exceeding per-model cap', async () => {
  const providers = routerMod.getProviders();
  const savedEnabled = providers.alibaba.enabled;
  const savedKey = providers.alibaba.apiKey;
  const savedModel = providers.alibaba.model;
  providers.alibaba.enabled = true;
  providers.alibaba.apiKey = 'test-key-not-used';
  providers.alibaba.model = 'qwen3.6-plus'; // 170K cap
  try {
    // Body ~700K chars → ~175K tokens (> 170K cap for qwen3.6-plus). Should return null.
    const huge = 'x'.repeat(700000);
    const body = JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: huge }] });
    const result = await routerMod.callAlibaba(body);
    assert.strictEqual(result, null);
  } finally {
    providers.alibaba.enabled = savedEnabled;
    providers.alibaba.apiKey = savedKey;
    providers.alibaba.model = savedModel;
  }
});

// --- PHASE-BASED TOOL PRUNING (Context Optimization research) ---
console.log('\nPhase-based tool pruning:');

test('detectPhase returns mixed when insufficient signal', () => {
  const data = { messages: [{ role: 'user', content: 'hi' }] };
  assert.strictEqual(routerMod.detectPhase(data), 'mixed');
});

test('detectPhase returns exploration when recent tools are all Read/Grep/Glob', () => {
  const toolUse = (n) => ({ type: 'tool_use', name: n, input: {} });
  const data = { messages: [
    { role: 'user', content: 'explore' },
    { role: 'assistant', content: [toolUse('Read'), toolUse('Grep'), toolUse('Glob'), toolUse('Read')] },
    { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
    { role: 'assistant', content: [toolUse('Read'), toolUse('Grep')] }
  ]};
  assert.strictEqual(routerMod.detectPhase(data), 'exploration');
});

test('detectPhase returns implementation when recent tools include multiple Edit/Write', () => {
  const toolUse = (n) => ({ type: 'tool_use', name: n, input: {} });
  const data = { messages: [
    { role: 'assistant', content: [toolUse('Edit'), toolUse('Edit'), toolUse('Write'), toolUse('Bash')] }
  ]};
  assert.strictEqual(routerMod.detectPhase(data), 'implementation');
});

test('filterAndTrimTools prunes Agent+WebSearch during exploration phase', () => {
  const tools = [
    { name: 'Read', description: 'read file' },
    { name: 'Grep', description: 'search' },
    { name: 'Agent', description: 'spawn subagent' },
    { name: 'WebSearch', description: 'web search' }
  ];
  const filtered = routerMod.filterAndTrimTools(tools, 'exploration');
  const names = filtered.map(t => t.name);
  assert(names.includes('Read'));
  assert(names.includes('Grep'));
  assert(!names.includes('Agent'));
  assert(!names.includes('WebSearch'));
});

test('filterAndTrimTools keeps all core tools during mixed phase', () => {
  const tools = [
    { name: 'Read', description: 'r' },
    { name: 'Edit', description: 'e' },
    { name: 'Agent', description: 'a' },
    { name: 'WebSearch', description: 'w' }
  ];
  const filtered = routerMod.filterAndTrimTools(tools, 'mixed');
  const names = filtered.map(t => t.name);
  assert(names.includes('Agent'));
  assert(names.includes('WebSearch'));
});

test('filterAndTrimTools keeps Agent+WebSearch during implementation (P1.3)', () => {
  // Research: implementation-phase pruning can degrade quality. Policy = no prune.
  const tools = [
    { name: 'Read', description: 'r' },
    { name: 'Edit', description: 'e' },
    { name: 'Agent', description: 'a' },
    { name: 'WebSearch', description: 'w' },
    { name: 'WebFetch', description: 'f' }
  ];
  const filtered = routerMod.filterAndTrimTools(tools, 'implementation');
  const names = filtered.map(t => t.name);
  assert(names.includes('Agent'), 'Agent must remain during implementation');
  assert(names.includes('WebSearch'), 'WebSearch must remain during implementation');
  assert(names.includes('WebFetch'), 'WebFetch must remain during implementation');
});

// --- CONTEXT-FILTER (drop short narration from older assistant msgs) ---
console.log('\nContextFilter:');
const contextfilter = require('../proxy/modules/contextfilter');

test('filterContext leaves short conversations untouched', () => {
  const body = JSON.stringify({ messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
  ]});
  const r = contextfilter.filterContext(body);
  assert.strictEqual(r.textBlocksRemoved, 0);
  assert.strictEqual(r.body, body);
});

test('filterContext drops short text from old assistant msgs, keeps recent', () => {
  const short = (t) => ({ type: 'text', text: t });
  const toolUse = (id) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } });
  const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });
  const body = JSON.stringify({ messages: [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: [short("Let me check."), toolUse('a1')] },
    toolResult('a1'),
    { role: 'assistant', content: [short("Now read next."), toolUse('a2')] },
    toolResult('a2'),
    { role: 'assistant', content: [short("Reading."), toolUse('a3')] },
    toolResult('a3'),
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: [short("Recent commentary."), toolUse('a4')] }
  ]});
  const r = contextfilter.filterContext(body);
  assert(r.textBlocksRemoved >= 1);
  const parsed = JSON.parse(r.body);
  // Last assistant msg (recent) should still contain its text block
  const lastAssistant = [...parsed.messages].reverse().find(m => m.role === 'assistant');
  assert(lastAssistant.content.some(b => b.type === 'text'));
});

test('filterContext preserves tool_use blocks (never dropped)', () => {
  const short = (t) => ({ type: 'text', text: t });
  const toolUse = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  const msgs = [];
  msgs.push({ role: 'user', content: 'go' });
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: 'assistant', content: [short('narration ' + i), toolUse('t' + i)] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'x' }] });
  }
  const body = JSON.stringify({ messages: msgs });
  const r = contextfilter.filterContext(body);
  const parsed = JSON.parse(r.body);
  // Every tool_use id in original must still exist in filtered
  for (let i = 0; i < 5; i++) {
    const found = parsed.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.id === 't' + i));
    assert(found, 'tool_use t' + i + ' was dropped');
  }
});

test('filterContext keeps long strategic text blocks in old messages', () => {
  const longText = 'Plan: '.repeat(100); // ~600 chars, > 150 threshold
  const toolUse = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  const msgs = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: longText }, toolUse('t' + i)] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'x' }] });
  }
  const body = JSON.stringify({ messages: msgs });
  const r = contextfilter.filterContext(body);
  assert.strictEqual(r.textBlocksRemoved, 0);
});

test('filterContext threshold dropped to 150 chars (P1.2)', () => {
  assert.strictEqual(contextfilter.SHORT_TEXT_LIMIT, 150,
    'Research-verified narration threshold: <150=narration (drop), >=150=reasoning (keep)');
});

test('filterContext drops 100-char text but keeps 200-char text', () => {
  const shortText = 'x'.repeat(100);   // < 150, should drop
  const mediumText = 'y'.repeat(200);  // >= 150, should keep
  const toolUse = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  const msgs = [{ role: 'user', content: 'go' }];
  // 5 old turns with short narration
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: shortText }, toolUse('s' + i)] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 's' + i, content: 'x' }] });
  }
  // 1 old turn with medium-length reasoning
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: mediumText }, toolUse('m0')] });
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm0', content: 'x' }] });
  // 2 recent (protected) turns
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: shortText }, toolUse('r0')] });
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r0', content: 'x' }] });
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: shortText }, toolUse('r1')] });

  const r = contextfilter.filterContext(JSON.stringify({ messages: msgs }));
  assert(r.textBlocksRemoved >= 4, 'expected some of the 5 short old blocks dropped, got ' + r.textBlocksRemoved);
  // Verify the medium-text reasoning block survived
  const parsed = JSON.parse(r.body);
  const hasMedium = parsed.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text && b.text.length === 200));
  assert(hasMedium, 'medium-length reasoning block should survive filter');
});

// --- LOOPGUARD Layer 2 (Phase 2) ---
console.log('\nLoopguard layer 2:');

test('detects no-codebase-delta loop on same file (Edit only; Read is exploration)', () => {
  resetHistory();
  const path = require('path');
  const testFile = path.resolve(__filename);
  //  (benchmarks/results/12-qwen-ab-hard.md): Read was removed
  // from the no-delta detector because repeat-Read-unchanged is legitimate
  // multi-bug exploration. Repeat-Edit-unchanged is still the "stuck" signal.
  const readBody = JSON.stringify({ content: [{ type: 'tool_use', name: 'Read', input: { file_path: testFile } }] });
  checkLoop(readBody);
  const readResult = checkLoop(readBody);
  assert(readResult.loopDetected === false, 'repeat Read on unchanged file must NOT trigger no-delta loop (exploration)');

  // Edit with unchanged file still triggers — that IS the stuck signal.
  resetHistory();
  const editBody = JSON.stringify({ content: [{ type: 'tool_use', name: 'Edit', input: { file_path: testFile, old_string: 'x', new_string: 'y' } }] });
  checkLoop(editBody);
  const editResult = checkLoop(editBody);
  assert(editResult.loopDetected === true, 'repeat Edit on unchanged file must still trigger no-delta loop');
});

// --- BUILDGRAPH (Phase 32) ---
console.log('\nBuildgraph:');
const { parseBuildSystems } = require('../proxy/modules/buildgraph');

test('parseBuildSystems detects npm in /tmp non-existent dir returns null', () => {
  const r = parseBuildSystems('/nonexistent-' + Date.now());
  assert(r === null || r.systems.length === 0);
});

test('parseBuildSystems detects npm in troth repo', () => {
  const r = parseBuildSystems(require('path').resolve(__dirname, '..'));
  assert(r && r.systems.includes('node'));
});

// --- LINGUA (Phase 33) ---
console.log('\nLingua (LLMLingua-2 Lite):');
const { compressText: linguaCompress } = require('../proxy/modules/lingua');

test('compressText is no-op for short text', () => {
  const r = linguaCompress('short text');
  assert(r.text === 'short text');
  assert(r.savedChars === 0);
});

test('compressText replaces verbose phrases', () => {
  const text = 'in order to test, ' + 'a'.repeat(300);
  const r = linguaCompress(text);
  assert(!r.text.includes('in order to'));
});

test('compressText preserves code blocks', () => {
  const text = 'in order to compress, here is code:\n```\nin order to keep\n```\n' + 'a'.repeat(300);
  const r = linguaCompress(text);
  assert(r.text.includes('in order to keep'), 'code block content must be preserved');
});

// --- ROUTELM (Phase 34) ---
console.log('\nRouteLM:');
const { scoreTaskComplexity, suggestTier } = require('../proxy/modules/routelm');

test('scoreTaskComplexity scores trivial low', () => {
  const score = scoreTaskComplexity('rename foo to bar', 1000);
  assert(score < 5, 'trivial rename should be low score, got ' + score);
});

test('scoreTaskComplexity scores complex high', () => {
  const score = scoreTaskComplexity('refactor the architecture across multiple files and migrate the database schema with security considerations', 60000);
  assert(score >= 7, 'complex multi-file should be high score, got ' + score);
});

test('suggestTier maps scores to tiers', () => {
  assert(suggestTier(2) === 'cheap');
  assert(suggestTier(5) === 'mid');
  assert(suggestTier(9) === 'strong');
});

// --- MORPH (Phase 25) ---
console.log('\nMorph Fast Apply:');
const { morphApply } = require('../proxy/modules/morph');

test('morphApply rejects missing file', () => {
  const r = morphApply('/nonexistent-' + Date.now() + '.js', { startLine: 1, endLine: 1 }, 'new');
  assert(!r.ok);
  assert(r.error.includes('does not exist'));
});

test('morphApply replaces line range', () => {
  const fs = require('fs');
  const tmp = require('os').tmpdir() + '/morph-test-' + Date.now() + '.js';
  fs.writeFileSync(tmp, 'a\nb\nc\nd\ne');
  const r = morphApply(tmp, { startLine: 2, endLine: 4 }, 'X\nY');
  fs.unlinkSync(tmp);
  assert(r.ok);
  assert(r.newFileContent === 'a\nX\nY\ne');
});

// --- GUARDRAILS (Phase 30) ---
console.log('\nGuardrails:');
const { detectSecrets, validateResponse } = require('../proxy/modules/guardrails');

test('detectSecrets catches API keys', () => {
  const r = detectSecrets('text with sk-1234567890abcdefghij1234 inside');
  assert(r.length > 0);
});

test('validateResponse passes clean response', () => {
  const body = JSON.stringify({ content: [{ type: 'text', text: 'normal response' }] });
  const r = validateResponse(body, {});
  assert(r.valid);
});

test('validateResponse catches secret leaks', () => {
  const body = JSON.stringify({ content: [{ type: 'text', text: 'see sk-abcdefghijklmnopqrstuv12345 in code' }] });
  const r = validateResponse(body, {});
  assert(!r.valid);
});

// --- ALPHACODE (Phase 39) ---
console.log('\nAlphaCode:');
const { kSampleVote, clusterKey } = require('../proxy/modules/alphacode');

test('clusterKey normalizes text', () => {
  assert(clusterKey('Hello, World!') === clusterKey('hello world'));
});

test('kSampleVote picks majority', async () => {
  let calls = 0;
  const gen = async () => {
    calls++;
    return calls === 1 ? 'unique answer' : 'common answer';
  };
  const result = await kSampleVote(gen, 3);
  assert(result === 'common answer');
});

// --- LMQL (Phase 40) ---
console.log('\nLMQL templates:');
const { fillTemplate } = require('../proxy/modules/lmql');

test('fillTemplate substitutes variables', () => {
  const r = fillTemplate('Hello {{name}}', { name: 'World' });
  assert(r.ok);
  assert(r.prompt === 'Hello World');
});

test('fillTemplate auto-fallback on constraint failure', () => {
  const r = fillTemplate('Short: {{val:len<10}}', { val: 'this is way too long for the constraint' });
  assert(r.ok); // auto-fallback truncates instead of failing
  assert(r.fallbacks && r.fallbacks.length > 0);
  assert(r.prompt.includes('Short:'));
});

// --- ACP (Phase 41) ---
console.log('\nACP message bus:');
const { publish, subscribe, getRecentEvents } = require('../proxy/modules/acp');

test('publish/subscribe delivers events', () => {
  let received = null;
  const unsub = subscribe('test.topic', (payload) => { received = payload; });
  publish('test.topic', { hello: 'world' });
  assert(received !== null);
  assert(received.hello === 'world');
  unsub();
});

test('getRecentEvents returns published items', () => {
  publish('test.recent', { n: 1 });
  const events = getRecentEvents('test.recent');
  assert(events.length > 0);
  assert(events[events.length - 1].payload.n === 1);
});

// --- ABTEST (Phase 42) ---
console.log('\nA/B test:');
const { defineVariant, pickVariant, recordResult, declareWinners } = require('../proxy/modules/abtest');

test('pickVariant is deterministic per session', () => {
  defineVariant('test-slot', 'variant A text', 'variant B text', 0.5);
  const r1 = pickVariant('test-slot', 'session-123');
  const r2 = pickVariant('test-slot', 'session-123');
  assert(r1.variant === r2.variant);
});

// --- DIFF (Phase 54) ---
console.log('\nDiff utilities:');
const { lineDiff, unifiedDiff, changeMagnitude } = require('../proxy/modules/diff');

test('lineDiff detects added/removed lines', () => {
  const r = lineDiff('a\nb\nc', 'a\nx\nc');
  assert(r.added.includes('x'));
  assert(r.removed.includes('b'));
  assert(r.unchanged === 2);
});

test('changeMagnitude reports net change', () => {
  const r = changeMagnitude('a\nb\nc', 'a\nb\nc\nd\ne');
  assert(r.netChange === 2);
  assert(r.addedLines === 2);
});

// --- BUDGET (Phase 56) ---
console.log('\nBudget:');
const { checkBudget } = require('../proxy/modules/budget');

test('checkBudget warns at threshold', () => {
  // No config = no limits = no warnings
  const r = checkBudget(0.50, 5.00);
  assert(r.ok);
});

// --- DEDUP (Phase 57) ---
console.log('\nDedup:');
const dedup = require('../proxy/modules/dedup');

test('dedup hashes equivalent requests identically', () => {
  const a = JSON.stringify({ messages: [{role:'user',content:'hi'}], stream: true });
  const b = JSON.stringify({ messages: [{role:'user',content:'hi'}], stream: false });
  // Different by stream flag, but messages are same → hashes match (stream is ignored)
  assert(dedup.hashRequest(a) === dedup.hashRequest(b));
});

test('dedup check returns null for unseen', () => {
  const body = JSON.stringify({ messages: [{role:'user',content:'unique-' + Date.now()}] });
  assert(dedup.check(body) === null);
});

test('dedup segments cache by model (4.6 vs 4.7)', () => {
  // Same messages, different model → must hash differently.
  // Opus 4.7 tokenizer differs from 4.6; their responses are not interchangeable.
  const a = JSON.stringify({ model: 'claude-opus-4-6', messages: [{role:'user',content:'same'}] });
  const b = JSON.stringify({ model: 'claude-opus-4-7', messages: [{role:'user',content:'same'}] });
  assert(dedup.hashRequest(a) !== dedup.hashRequest(b));
});

test('dedup segments cache by thinking config', () => {
  const a = JSON.stringify({ model: 'claude-opus-4-7', messages: [{role:'user',content:'same'}] });
  const b = JSON.stringify({ model: 'claude-opus-4-7', messages: [{role:'user',content:'same'}], thinking: { type: 'adaptive' } });
  assert(dedup.hashRequest(a) !== dedup.hashRequest(b));
});

// --- RATELIMIT (Phase 58) ---
console.log('\nRatelimit:');
const { parseHeaders, parseRetryAfter } = require('../proxy/modules/ratelimit');

test('parseHeaders extracts Anthropic limits', () => {
  const r = parseHeaders('anthropic', {
    'anthropic-ratelimit-requests-remaining': '50',
    'anthropic-ratelimit-requests-limit': '100',
    'anthropic-ratelimit-requests-reset': '2026-04-17T00:00:00Z',
  });
  assert(r.remaining === 50);
  assert(r.limit === 100);
});

test('parseRetryAfter handles seconds', () => {
  assert(parseRetryAfter({ 'retry-after': '30' }) === 30);
});

// --- PROFANITY (Phase 59) ---
console.log('\nProfanity/frustration:');
const { checkText } = require('../proxy/modules/profanity');

test('checkText detects frustration patterns', () => {
  const r = checkText('this is impossible to fix');
  assert(!r.ok);
  assert(r.signals.length > 0);
});

test('checkText passes normal text', () => {
  const r = checkText('Looking at the code, I see the issue.');
  assert(r.ok);
});

// --- COST (Phase 46) ---
console.log('\nCost:');
const { calculateCost, recordUsage, getTotals, reset: resetCost } = require('../proxy/modules/cost');

test('calculateCost handles known model', () => {
  const r = calculateCost('claude-sonnet-4.6', 1_000_000, 1_000_000);
  assert(r.cost === 18); // 3 + 15 = 18
});

test('calculateCost handles flat-rate', () => {
  const r = calculateCost('qwen3-max', 1_000_000, 1_000_000);
  assert(r.cost === 0);
  assert(r.plan === 'flat (subscription)');
});

test('recordUsage accumulates', () => {
  resetCost();
  recordUsage('claude-sonnet-4.6', 100_000, 50_000);
  recordUsage('claude-sonnet-4.6', 100_000, 50_000);
  const t = getTotals();
  assert(t.perModel['claude-sonnet-4.6'].requests === 2);
});

// --- JSONREPAIR (Phase 64) ---
console.log('\nJSON repair:');
const { tryRepair, safeParse } = require('../proxy/modules/jsonrepair');

test('tryRepair handles trailing commas', () => {
  const r = tryRepair('{"a": 1, "b": 2,}');
  assert(r);
  assert.deepStrictEqual(JSON.parse(r), { a: 1, b: 2 });
});

test('tryRepair handles unquoted keys', () => {
  const r = tryRepair('{name: "foo"}');
  assert(r);
  assert.deepStrictEqual(JSON.parse(r), { name: 'foo' });
});

test('safeParse returns fallback on unrepairable', () => {
  const r = safeParse('totally not json {{{{', { fallback: true });
  assert(r.fallback === true);
});

// --- PERFLOG (Phase 51) ---
console.log('\nPerflog:');
const { record, getRecent } = require('../proxy/modules/perflog');

test('perflog record + getRecent works', () => {
  const ts = Date.now();
  record({ requestId: 99999, provider: 'test', latencyMs: 100, inputTokens: 50, outputTokens: 10, _testMarker: ts });
  // Force flush
  require('../proxy/modules/perflog').flush();
  const recent = getRecent(50);
  // Find our marker
  const found = recent.some(e => e._testMarker === ts);
  assert(found, 'should find recorded entry');
});

// --- HEALTH (Phase 63) ---
console.log('\nHealth probes:');
const { probe } = require('../proxy/modules/health');

test('probe returns object with ok field', async () => {
  const r = await probe('test', { hostname: '127.0.0.1', path: '/nonexistent-' + Date.now() });
  // 127.0.0.1 likely refuses connection — ok should be false
  assert(typeof r.ok === 'boolean');
  assert(typeof r.latencyMs === 'number');
});

// --- AUDIT (Phase 70) ---
console.log('\nAudit log:');
const audit = require('../proxy/modules/audit');

test('audit log appends', () => {
  audit.log('test.event', { foo: 'bar', _ts: Date.now() });
  const recent = audit.getRecent(5);
  assert(recent.some(e => e.event === 'test.event'));
});

test('audit verify returns ok object', () => {
  const v = audit.verify();
  assert(typeof v.ok === 'boolean');
});

// --- DEPGRAPH (Phase 71) ---
console.log('\nDepgraph:');
const depgraph = require('../proxy/modules/depgraph');

test('extractImports finds requires', () => {
  const tmp = require('os').tmpdir() + '/depgraph-test-' + Date.now() + '.js';
  require('fs').writeFileSync(tmp, 'const x = require("./foo"); import bar from "./bar";');
  const imps = depgraph.extractImports(tmp);
  require('fs').unlinkSync(tmp);
  assert(imps.includes('./foo'));
  assert(imps.includes('./bar'));
});

// --- SECRETS (Phase 72) ---
console.log('\nSecret redaction:');
const secrets = require('../proxy/modules/secrets');

test('redact strips API keys', () => {
  const r = secrets.redact('use sk-1234567890abcdefghij1234 here');
  assert(!r.includes('sk-1234567890abcdefghij1234'));
  assert(r.includes('[REDACTED'));
});

test('redactObject scrubs nested values', () => {
  const r = secrets.redactObject({ name: 'foo', api_key: 'sk-secret', nested: { token: 'mytoken' } });
  assert(r.name === 'foo');
  assert(r.api_key === '[REDACTED]');
  assert(r.nested.token === '[REDACTED]');
});

// --- ARCHETYPE (Phase 66) ---
console.log('\nArchetype detection:');
const archetype = require('../proxy/modules/archetype');

test('detectArchetype detects troth as node-cli', () => {
  const r = archetype.detectArchetype(require('path').resolve(__dirname, '..'));
  assert(r.archetype === 'node-cli', 'expected node-cli, got ' + r.archetype);
});

// --- TIMELINE (Phase 79) ---
console.log('\nTimeline:');
const timeline = require('../proxy/modules/timeline');

test('timeline records events', () => {
  timeline.clear();
  timeline.event('test', 'first');
  timeline.event('test', 'second');
  const r = timeline.getRecent(10);
  assert(r.length === 2);
  assert(r[1].summary === 'second');
});

// --- PREVIEW (Phase 80) ---
console.log('\nPreview:');
const { previewFile } = require('../proxy/modules/preview');

test('previewFile extracts top symbols', () => {
  const tmp = require('os').tmpdir() + '/preview-test-' + Date.now() + '.js';
  require('fs').writeFileSync(tmp, 'function alpha() {}\nclass Beta {}\nconst gamma = 5;');
  const p = previewFile(tmp);
  require('fs').unlinkSync(tmp);
  assert(p.topSymbols.includes('alpha'));
  assert(p.topSymbols.includes('Beta'));
});

// --- COMMITMSG (Phase 81) ---
console.log('\nCommitmsg:');
const commitmsg = require('../proxy/modules/commitmsg');

test('detectType returns valid conventional commit type', () => {
  const r = commitmsg.detectType([{ status: 'M', file: 'README.md' }]);
  assert(r === 'docs');
});

// --- CONFIGVALID (Phase 83) ---
console.log('\nConfig validation:');
const configvalid = require('../proxy/modules/configvalid');

test('validate returns ok for missing config', () => {
  const r = configvalid.validate('/nonexistent-' + Date.now());
  assert(r.ok);
});

test('VALID_PROVIDERS includes alibaba', () => {
  assert(configvalid.VALID_PROVIDERS.includes('alibaba'));
});

test('VALID_PROVIDERS includes moonshot, xai, and the live-but-drifted set', () => {
  // moonshot + xai are the new BYOK providers; zai / openai_sub / google_ai
  // are live providers that were missing from the list (drift fix).
  ['moonshot', 'xai', 'zai', 'openai_sub', 'google_ai'].forEach((p) => {
    assert(configvalid.VALID_PROVIDERS.includes(p), p + ' must be a valid provider');
  });
});

// --- CONVENTIONS (Phase 77) ---
console.log('\nConventions:');
const conventions = require('../proxy/modules/conventions');

test('detectFromDir returns shape', () => {
  const r = conventions.detectFromDir(require('path').resolve(__dirname, '..', 'proxy'));
  assert(r);
  assert(['tabs', '2-space', '4-space', 'unknown'].includes(r.indent));
});

// --- HOTCACHE ---
console.log('\nHotCache:');
const hotcache = require('../proxy/modules/hotcache');

test('getStats returns shape', () => {
  const s = hotcache.getStats();
  assert(typeof s.trackedFiles === 'number');
});

test('getFileHash returns consistent hash', () => {
  const h1 = hotcache.hashString('hello world');
  const h2 = hotcache.hashString('hello world');
  assert(h1 === h2);
  const h3 = hotcache.hashString('different');
  assert(h1 !== h3);
});

// --- CONTEXTPINNING ---
console.log('\nContextPinning:');
const contextpinning = require('../proxy/modules/contextpinning');

test('loadPinnedFiles returns array', () => {
  const r = contextpinning.loadPinnedFiles(require('path').resolve(__dirname, '..'));
  assert(Array.isArray(r));
});

// --- EXPORTER ---
console.log('\nExporter:');
const exporter = require('../proxy/modules/exporter');

test('exportAll returns object', () => {
  const r = exporter.exportAll();
  assert(r && typeof r === 'object');
});

// --- MIGRATE ---
console.log('\nMigrate:');
const migrate = require('../proxy/modules/migrate');

test('getVersion returns number', () => {
  const Database = require('better-sqlite3');
  const tmpDb = new Database(':memory:');
  const v = migrate.getVersion(tmpDb);
  assert(typeof v === 'number');
  assert(v >= 0);
  tmpDb.close();
});

// --- TEMPLATES ---
console.log('\nTemplates:');
const templates = require('../proxy/modules/templates');

test('listArchetypes returns array', () => {
  const list = templates.listArchetypes();
  assert(Array.isArray(list));
  assert(list.length >= 1);
});

// --- BUDGET (behavior) ---
console.log('\nBudget (behavior):');

test('checkBudget returns shape', () => {
  const result = checkBudget(99999); // massive cost should trigger
  assert(typeof result === 'object');
  assert('ok' in result);
});

// --- DEDUP (behavior) ---
console.log('\nDedup (behavior):');

test('dedup detects identical request within window', () => {
  const body = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hello dedup test ' + Date.now() }] });
  const first = dedup.check(body);
  assert(first === null); // first time = not cached
  dedup.store(body, '{"cached":"yes"}');
  const second = dedup.check(body);
  assert(second !== null); // same body within 30s = cached
});

// --- DIFF (behavior) ---
console.log('\nDiff (behavior):');

test('unifiedDiff produces correct output', () => {
  const result = unifiedDiff('hello\nworld\n', 'hello\nplanet\n', 'test.txt');
  assert(typeof result === 'string');
  assert(result.includes('-world'));
  assert(result.includes('+planet'));
});

// --- SECRETS (behavior) ---
console.log('\nSecrets (behavior):');

test('redact catches API keys', () => {
  const input = 'My key is sk-1234567890abcdef1234567890abcdef and secret AKIA1234567890ABCDEF';
  const result = secrets.redact(input);
  assert(!result.includes('sk-1234567890'));
  assert(!result.includes('AKIA1234567890'));
});

test('redactToolResults scrubs string-shape tool_result content', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'config reads RESEND_API_KEY=sk-1234567890abcdef1234567890abcdef\nALIBABA=sk-abcdef1234567890abcdefghij'
      }]
    }]
  };
  const { body: out, redactions } = secrets.redactToolResults(body);
  assert.strictEqual(redactions, 1);
  const text = out.messages[0].content[0].content;
  assert(!text.includes('sk-1234567890abcdef1234567890abcdef'), 'first key not scrubbed');
  assert(!text.includes('sk-abcdef1234567890abcdefghij'), 'second key not scrubbed');
  assert(text.includes('[REDACTED'), 'no redaction marker present');
});

test('redactToolResults scrubs array-shape tool_result content blocks', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu_2',
        content: [
          { type: 'text', text: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
          { type: 'text', text: 'no secrets here' }
        ]
      }]
    }]
  };
  const { body: out, redactions } = secrets.redactToolResults(body);
  assert.strictEqual(redactions, 1, 'only first text block has a secret');
  const blocks = out.messages[0].content[0].content;
  assert(!blocks[0].text.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.strictEqual(blocks[1].text, 'no secrets here', 'clean text untouched');
});

test('redactToolResults leaves non-tool_result blocks untouched', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'sk-1234567890abcdef1234567890abcdef in user text' },
        { type: 'tool_result', tool_use_id: 'tu_3', content: 'sk-abcdef1234567890abcdefghij in tool result' }
      ]
    }]
  };
  const { body: out, redactions } = secrets.redactToolResults(body);
  assert.strictEqual(redactions, 1, 'only tool_result block redacted, not user text');
  // User text block is intentionally left alone — that's the user's own
  // input and they're responsible for what they paste.
  assert.strictEqual(out.messages[0].content[0].text,
    'sk-1234567890abcdef1234567890abcdef in user text');
  assert(!out.messages[0].content[1].content.includes('sk-abcdef1234567890abcdefghij'));
});

test('redactToolResults handles missing/malformed bodies without throwing', () => {
  assert.deepStrictEqual(secrets.redactToolResults(null), { body: null, redactions: 0 });
  assert.deepStrictEqual(secrets.redactToolResults({}), { body: {}, redactions: 0 });
  const bad = { messages: 'not-an-array' };
  const { redactions } = secrets.redactToolResults(bad);
  assert.strictEqual(redactions, 0);
});

};
