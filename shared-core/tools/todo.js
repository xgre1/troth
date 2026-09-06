// SPDX-License-Identifier: AGPL-3.0-only
// todo_write — the turn's own step list.
//
// A multi-step turn names its steps once and keeps them current: pending,
// doing, done. The list lives with the conversation for the life of the
// daemon (not in the substrate: it is working state, not memory) and the
// surface shows it under the trail. The runtime injects ctx.todo_set; a
// surface without it gets an honest 'unavailable'.
'use strict';

const STATUSES = ['pending', 'doing', 'done'];
const MAX_ITEMS = 20;
const MAX_TEXT = 120;

const schema = { type: 'function', function: {
  name: 'todo_write',
  description: 'Replace this conversation\'s step list. Use it on a multi-step task: name the steps first, then mark each doing and done as you go. Keep one step doing at a time.',
  parameters: { type: 'object', properties: {
    items: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'object', properties: {
      text:   { type: 'string', description: 'The step, a short verb phrase' },
      status: { type: 'string', enum: STATUSES }
    }, required: ['text', 'status'] } }
  }, required: ['items'] }
} };

function normalise(items) {
  if (!Array.isArray(items)) return { error: 'items_not_array', hint: 'items is an array of { text, status }' };
  if (items.length > MAX_ITEMS) return { error: 'too_many_items', hint: 'at most ' + MAX_ITEMS + ' steps; fold the small ones' };
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const text = typeof it.text === 'string' ? it.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return { error: 'empty_step', hint: 'step ' + (i + 1) + ' has no text' };
    const status = STATUSES.indexOf(it.status) >= 0 ? it.status : 'pending';
    out.push({ text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text, status });
  }
  return { items: out };
}

function summary(items) {
  const done = items.filter((i) => i.status === 'done').length;
  const doing = items.find((i) => i.status === 'doing') || null;
  const next = items.find((i) => i.status === 'pending') || null;
  return { total: items.length, done, current: doing ? doing.text : (next ? next.text : null), all_done: items.length > 0 && done === items.length };
}

async function run(args, ctx) {
  const c = ctx || {};
  if (typeof c.todo_set !== 'function') return { error: 'unavailable', hint: 'this surface keeps no step list' };
  const n = normalise((args || {}).items);
  if (n.error) return n;
  const s = summary(n.items);
  try { await c.todo_set(n.items, s); } catch (e) { return { error: 'todo_failed', detail: e && e.message || String(e) }; }
  return Object.assign({ ok: true }, s);
}

module.exports = { schema, run, normalise, summary, STATUSES, MAX_ITEMS, MAX_TEXT };
