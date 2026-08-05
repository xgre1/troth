// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A stand-in for the model vendor, not for the product.
//
// Every scenario so far ran on the `echo` faculty, which answers before the
// router, the transport, the streaming parser or the token accounting are
// reached — so "a turn works" was never actually tested, only "the daemon
// replies". This is an Anthropic-compatible endpoint that speaks real SSE, so a
// turn goes through the real chain and only the vendor's network is missing.
// No key, no bill, no internet: it runs the same on a laptop, in a container,
// and on a machine that has never been configured.
//
// It also RECORDS what it was asked, which is the only honest way to check what
// the product puts in front of a model — memory, identity, another
// conversation's words.
const http = require('http');

/**
 * start({ reply }) → { base, requests, close }
 *   base      pass as TROTH_KIMI_SUB_BASE (or ANTHROPIC_BASE_URL)
 *   requests  every parsed request body, in order
 *   reply     (body, n) => string  — what the model "says"; default echoes a marker
 */
async function start(opts) {
  opts = opts || {};
  const requests = [];
  const reply = opts.reply || function () { return 'ACK from the stand-in model.'; };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (_) { body = { _unparsed: raw }; }
      requests.push({ path: req.url, headers: req.headers, body });

      let text;
      try { text = String(reply(body, requests.length - 1)); }
      catch (e) { text = 'stand-in reply failed: ' + (e && e.message); }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event, data) => {
        res.write('event: ' + event + '\n');
        res.write('data: ' + JSON.stringify(data) + '\n\n');
      };
      send('message_start', { type: 'message_start', message: { model: (body && body.model) || 'stand-in', usage: { input_tokens: 1 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      // Two chunks, because a single chunk hides every off-by-one in a stream
      // assembler.
      const half = Math.ceil(text.length / 2);
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    base: 'http://127.0.0.1:' + port + '/',
    port,
    requests,
    /** Everything the model was shown, as one searchable string. */
    seen() { return JSON.stringify(requests); },
    close() { return new Promise((r) => { try { server.close(r); } catch (_) { r(); } }); },
  };
}

module.exports = { start };
