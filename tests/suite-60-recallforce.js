// SPDX-License-Identifier: AGPL-3.0-only
// Advice becomes protocol on the proxy lane.
//
// Foreign agents have no hooks, so a memory question reaches the model with
// recall as a suggestion at best. recallforce turns the protocol's own
// mechanism on it: tool_choice {type:"tool"} pinned to the request's recall
// tool. What this suite pins is not the happy path so much as the guard set,
// because every guard is an API constraint or a loop-breaker: manual
// thinking 400s upstream if forced, an explicit client choice is not ours
// to override, a mid-loop request is how the force LIFTS after the recall
// result returns, and a prompt the hook lane already answered must not pay
// a second round-trip. Precision of the classifier is pinned from both
// sides — the shapes that must force, and ordinary prose that must not.
module.exports = function run({ test }) {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rf = require(path.join(ROOT, 'proxy', 'modules', 'recallforce.js'));

console.log('\nRecall forcing on the proxy lane (RCF):');

const RECALL = { name: 'troth_recall', description: 'recall', input_schema: { type: 'object' } };
const PREFIXED = { name: 'mcp__plugin_troth_troth-router__troth_recall', description: 'recall', input_schema: { type: 'object' } };
const OTHER = { name: 'get_weather', description: 'w', input_schema: { type: 'object' } };

function body(overrides) {
  return JSON.stringify(Object.assign({
    model: 'claude-opus-5', max_tokens: 1024,
    tools: [OTHER, RECALL],
    messages: [{ role: 'user', content: 'do you remember what we decided about the schema?' }]
  }, overrides));
}

test('RCF-1: a fresh memory-shaped prompt with a recall tool gets tool_choice forced to it', () => {
  const r = rf.apply(body({}));
  assert.strictEqual(r.forced, true, r.reason);
  const b = JSON.parse(r.body);
  assert.deepStrictEqual(b.tool_choice, { type: 'tool', name: 'troth_recall' });
  assert.strictEqual(b.model, 'claude-opus-5', 'the rest of the request is untouched');
});

test('RCF-2: the tool is found by suffix, whatever the host prefix — and near-misses are not', () => {
  assert.strictEqual(rf.findRecallTool([PREFIXED]), PREFIXED.name, 'gateway-prefixed name matches');
  assert.strictEqual(rf.findRecallTool([{ name: 'mytroth_recall' }]), null, 'an embedded suffix is not identity');
  assert.strictEqual(rf.findRecallTool([{ name: 'troth_recall_v2' }]), null, 'nor a prefix of another name');
  const r = rf.apply(body({ tools: [OTHER] }));
  assert.strictEqual(r.forced, false);
  assert.strictEqual(r.reason, 'no-recall-tool', 'no target, no force');
});

test('RCF-3: manual thinking and an explicit client choice both stand down; adaptive passes', () => {
  const manual = rf.apply(body({ thinking: { type: 'enabled', budget_tokens: 4096 } }));
  assert.strictEqual(manual.forced, false);
  assert.strictEqual(manual.reason, 'manual-thinking', 'forcing there is an upstream 400');
  const chosen = rf.apply(body({ tool_choice: { type: 'none' } }));
  assert.strictEqual(chosen.forced, false);
  assert.strictEqual(chosen.reason, 'client-choice', 'the client\'s own choice is never overridden');
  const adaptive = rf.apply(body({ thinking: { type: 'adaptive' } }));
  assert.strictEqual(adaptive.forced, true, 'adaptive thinking supports forced tool use');
  // The live pipeline strips `thinking` from the body before this stage runs,
  // so the call site hands the original type over as an opt — the guard must
  // honor it even when the body itself no longer carries the field.
  const stripped = rf.apply(body({}), { thinkingType: 'enabled' });
  assert.strictEqual(stripped.forced, false);
  assert.strictEqual(stripped.reason, 'manual-thinking', 'the original intent survives the strip');
  const strippedAdaptive = rf.apply(body({}), { thinkingType: 'adaptive' });
  assert.strictEqual(strippedAdaptive.forced, true);
});

test('RCF-4: mid-loop requests are exempt — which is exactly how the force lifts', () => {
  const withResult = rf.apply(body({
    messages: [
      { role: 'user', content: 'do you remember what we decided about the schema?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'troth_recall', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the decision' }] }
    ]
  }));
  assert.strictEqual(withResult.forced, false);
  assert.strictEqual(withResult.reason, 'mid-loop', 'the recall result came back; the model may now answer');
  const prefill = rf.apply(body({
    messages: [
      { role: 'user', content: 'do you remember?' },
      { role: 'assistant', content: 'Let me check' }
    ]
  }));
  assert.strictEqual(prefill.forced, false, 'an assistant tail is not a fresh turn');
});

test('RCF-5: where the hook lane already spoke, the proxy stays silent', () => {
  const r = rf.apply(body({
    messages: [{ role: 'user', content: 'do you remember the schema decision?\n[troth/recall] Your substrate already knows...' }]
  }));
  assert.strictEqual(r.forced, false);
  assert.strictEqual(r.reason, 'hook-already-spoke', 'one recall per question, not two');
});

test('RCF-6: ordinary prose does not force — the classifier pays for precision, not recall', () => {
  for (const text of [
    'Refactor this and remember to update the tests',
    'The parser should remember its previous state between calls',
    'φτιάξε το bug στο login και τρέξε τα tests',
    'add a memory cache to the request handler'
  ]) {
    assert.strictEqual(rf.isMemoryShaped(text), false, 'must not match: ' + text);
  }
});

test('RCF-7: the memory shapes force in all three writing systems', () => {
  for (const text of [
    'What did we decide about the auth flow?',
    'where did we leave off yesterday',
    'τι είχαμε πει για το schema;',
    'πού είχαμε μείνει;',
    'thimase ti eixame pei gia to proxy?'
  ]) {
    assert.strictEqual(rf.isMemoryShaped(text), true, 'must match: ' + text);
  }
});

test('RCF-8: wired before the lane split, toggleable, and the stripped thinking type rides along (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'server.js'), 'utf8');
  assert.ok(/routeTarget !== 'local' && isModuleEnabled\('recallforce'\)/.test(src),
    'guarded like its sibling stages, skipped in explicit-local mode');
  const idx = src.indexOf("isModuleEnabled('recallforce')");
  const anthro = src.indexOf("if (routeTarget === 'anthropic')");
  assert.ok(idx !== -1 && anthro !== -1 && idx < anthro,
    'applied before the anthropic/fallback split so the lanes that can carry it inherit it');
  // preprocessAnthropicBody deletes `thinking` long before this stage; the
  // wiring must hand the original type over or the manual-thinking guard
  // inspects a field that is always gone (review finding, 2026-08).
  assert.ok(/thinkingType: preprocessed\.thinkingConfig && preprocessed\.thinkingConfig\.thinkingType/.test(src),
    'the original thinking type is passed in from the preprocess stage');
  const dash = fs.readFileSync(path.join(ROOT, 'proxy', 'ui', 'dashboard.html'), 'utf8');
  assert.ok(/k: 'recallforce'/.test(dash), 'and the dashboard can switch it off');
});

test('RCF-9: the force is carried where MCP tools go, and cannot dangle where they are stripped', () => {
  // The two fallback translators disagree about MCP tools by design, and a
  // forced tool_choice must stay consistent with each: the Responses lane
  // passes every tool through, so it must also carry the force; the
  // OpenAI-compat chat lane strips MCP/troth tools, so it must emit no
  // tool_choice at all — a forced choice naming an absent function is an
  // upstream 400. If either half fails, the converter changed and the
  // lane-coverage statement in recallforce.js needs re-tracing.
  const translate = require(path.join(ROOT, 'proxy', 'modules', 'openai-translate.js'));
  const forcedBody = JSON.parse(rf.apply(body({ tools: [OTHER, PREFIXED] })).body);
  const resp = translate.anthropicToResponses(forcedBody, { defaultModel: 'gpt-test' });
  assert.ok(resp.tools.some(t => t.name === PREFIXED.name), 'the recall tool survives the Responses translation');
  assert.deepStrictEqual(resp.tool_choice, { type: 'function', name: PREFIXED.name },
    'and the force survives with it');
  const converter = require(path.join(ROOT, 'proxy', 'modules', 'converter.js'));
  const chat = converter.anthropicToOpenAI(JSON.stringify(forcedBody), {});
  const chatTools = (chat.tools || []).map(t => t.function && t.function.name);
  assert.ok(!chatTools.some(n => /troth_recall$/.test(n)), 'the chat lane strips the MCP tool');
  assert.strictEqual(chat.tool_choice, undefined,
    'so no tool_choice may point at it — the force evaporates whole, never dangles');
});

test('RCF-10: the Kimi lane deforces instead of dying — found live, pinned here (source pin)', () => {
  // Anthropic-SHAPED lane, but the endpoint runs thinking server-side and
  // 400s on forced tool use ("tool_choice 'specified' is incompatible with
  // thinking enabled" — the first field test of this module hit it). The
  // transport must drop a forced choice whole: degraded to advice beats a
  // dead turn.
  const src = fs.readFileSync(path.join(ROOT, 'proxy', 'modules', 'router.js'), 'utf8');
  const fn = src.slice(src.indexOf('function callKimiSub'), src.indexOf('function callKimiSub') + 3000);
  assert.ok(/tool_choice\.type === "tool" \|\| pb\.tool_choice\.type === "any"/.test(fn),
    'the kimi transport recognizes a forced choice');
  assert.ok(/delete pb\.tool_choice/.test(fn), 'and drops it whole before the wire');
});
};
