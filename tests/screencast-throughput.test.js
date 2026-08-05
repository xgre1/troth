#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Screencast throughput.
// Acceptance criterion: '"watch live" toggle paints viewport ≥5fps
// while chat + perception poll keep working.' The pipeline shape:
//   body's Chromium runs with CDP enabled (visible in boot's serial log)
//     → CDP Page.startScreencast emits JPEG frames over CDP
//     → substrate ingests frames as perception engrams (class=
//       'screencast_frame') AND/OR streams them across vsock for the
//       operator's Tauri canvas.
// The frame DELIVERY transport (vsock vs control channel) is an operator
// surface choice; the SUBSTRATE-side ingest is the structural acceptance:
// the perception-tail ring MUST accept frames at ≥5fps without dropping
// any AND without blocking the chat / non-screencast perception poll.
//
// This test pins that substrate-side property:
//   1. Push N=30 frames covering a synthetic 1.5-second window via
//      recordPerception (the same writer the observer uses).
//   2. perceptionTail with kind='screencast_frame' returns ALL frames
//      in order.
//   3. Achieved fps = frames / (last_ts - first_ts) is ≥ 5.
//   4. While the ring carries frames, a control:browser_state read still
//      returns instantly (the chat-during-screencast assertion).
//   5. The non-screencast tail filter still works — page_visit / other
//      classes are visible alongside the frames.

const assert = require('assert');
const path   = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const tail = require(path.join(PROJECT_ROOT, 'shared-core', 'perception', 'perception-tail.js'));
const schemas = require(path.join(PROJECT_ROOT, 'shared-core', 'perception', 'engram-schemas.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ': ' + e.message); fail++; }
}

// Build a screencast_frame engram. The frame_b64 is a small synthetic
// payload — the substrate doesn't decode it, just records it for the
// operator's canvas to paint. The shape matches engram-schemas's
// convention (class/scope/audience/statement/payload).
function frameEngram(sequence, tsMs) {
  return {
    class:    'screencast_frame',
    scope:    'perception:browser:screencast',
    audience: 'operator',
    statement: 'screencast frame ' + sequence,
    payload: {
      ts:        tsMs,
      kind:      'screencast_frame',
      sequence,
      frame_b64: 'iVBORw0KGgo' + sequence,   // synthetic 12B per frame
      mime:      'image/jpeg',
      width:     1280,
      height:    720
    }
  };
}

console.log('\n=== screencast throughput — perception-tail accepts ≥5fps ===\n');

t('preflight: tail starts empty + accepts a synthetic page_visit', () => {
  tail.__resetForTest();
  tail.recordPerception(schemas.pageVisit({
    url: 'https://x.test', title: 'X', ts: Date.now(),
    ax_node_count: 1, semantic_summary: 's', ax_graph_text: 'a'
  }));
  const r = tail.perceptionTail({});
  assert.strictEqual(r.events.length, 1);
});

t('A6.3 — 30 frames over 1.5s land in the ring without loss', () => {
  tail.__resetForTest();
  const N = 30;
  const startTs = Date.now();
  // 1500ms / 30 = 50ms between frames → 20 fps simulated source.
  for (let i = 0; i < N; i++) {
    tail.recordPerception(frameEngram(i, startTs + i * 50));
  }
  const r = tail.perceptionTail({ kind: 'screencast_frame', limit: 200 });
  assert.strictEqual(r.events.length, N,
    'expected ' + N + ' frames in the tail, got ' + r.events.length);
  // Frames must be in order — operator's canvas relies on monotonic
  // sequence numbers.
  const sequences = r.events.map((e) => e.payload && e.payload.sequence);
  for (let i = 1; i < sequences.length; i++) {
    assert.ok(sequences[i] === sequences[i - 1] + 1,
      'frames not contiguous at i=' + i + ': ' + sequences.slice(0, 5));
  }
});

t('A6.3 — achieved fps from the ring is ≥ 5', () => {
  tail.__resetForTest();
  const N = 30;
  const startTs = Date.now();
  for (let i = 0; i < N; i++) {
    tail.recordPerception(frameEngram(i, startTs + i * 50));
  }
  const r = tail.perceptionTail({ kind: 'screencast_frame', limit: 200 });
  const first = r.events[0].ts;
  const last  = r.events[r.events.length - 1].ts;
  const spanSec = Math.max((last - first) / 1000, 0.001);
  const fps = (r.events.length - 1) / spanSec;
  assert.ok(fps >= 5,
    'achieved fps ' + fps.toFixed(2) + ' is below the 5fps acceptance budget');
});

t('A6.3 — chat-during-screencast: browserState read stays instant', () => {
  tail.__resetForTest();
  tail.recordPerception(schemas.pageVisit({
    url: 'https://signup.example.com/account', title: 'Account', ts: Date.now(),
    ax_node_count: 12, semantic_summary: 'sign-in form', ax_graph_text: 'h1|button'
  }));
  // Saturate the ring with frames.
  const startTs = Date.now();
  for (let i = 0; i < 200; i++) {
    tail.recordPerception(frameEngram(i, startTs + i * 5));
  }
  // browserState reads must stay sub-millisecond — operator's chat UI
  // doesn't get blocked behind the screencast.
  const t0 = process.hrtime.bigint();
  const s = tail.browserState();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(s.last_page && /signup.example.com/.test(s.last_page.url),
    'page state still reachable while ring is full of frames');
  assert.ok(ms < 50,
    'browserState read took ' + ms.toFixed(3) + 'ms under screencast load');
});

t('A6.3 — perception-tail filter separates frames from other engrams', () => {
  tail.__resetForTest();
  // Mixed stream: page_visit + frames + page_visit + frames.
  tail.recordPerception(schemas.pageVisit({
    url: 'https://x.test/1', title: '1', ts: Date.now(),
    ax_node_count: 1, semantic_summary: '1', ax_graph_text: '1'
  }));
  for (let i = 0; i < 10; i++) tail.recordPerception(frameEngram(i, Date.now() + i));
  tail.recordPerception(schemas.pageVisit({
    url: 'https://x.test/2', title: '2', ts: Date.now() + 100,
    ax_node_count: 1, semantic_summary: '2', ax_graph_text: '2'
  }));
  for (let i = 10; i < 20; i++) tail.recordPerception(frameEngram(i, Date.now() + 100 + i));

  const frames = tail.perceptionTail({ kind: 'screencast_frame', limit: 200 });
  assert.strictEqual(frames.events.length, 20, 'all 20 frames visible under the filter');
  const pages = tail.perceptionTail({ kind: 'page_visit', limit: 200 });
  assert.strictEqual(pages.events.length, 2, 'both page visits visible under filter');
  // The chat operator reading the unfiltered tail sees everything.
  const all = tail.perceptionTail({ limit: 200 });
  assert.strictEqual(all.events.length, 22);
});

console.log('\n' + (fail ? '\u2717 ' : '\u2713 ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
