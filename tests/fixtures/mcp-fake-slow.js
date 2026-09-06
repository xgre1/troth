// A stdio MCP server whose one tool takes as long as it is told. It writes
// every cancellation it receives to the file named by MCP_FAKE_LOG, so a test
// can see the notice reach the wire.
const fs = require('fs');
process.stdin.setEncoding('utf8');
let buf = '';
function note(line) {
  if (process.env.MCP_FAKE_LOG) { try { fs.appendFileSync(process.env.MCP_FAKE_LOG, line + '\n'); } catch (_) {} }
}
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-slow', version: '0' } } }) + '\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'wait', description: 'waits ms then answers', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } } }] } }) + '\n');
    } else if (msg.method === 'tools/call') {
      const ms = (msg.params && msg.params.arguments && msg.params.arguments.ms) || 20000;
      note('call:' + msg.id);
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'waited ' + ms }] } }) + '\n');
      }, ms);
    } else if (msg.method === 'notifications/cancelled') {
      note('cancelled:' + (msg.params && msg.params.requestId) + ':' + (msg.params && msg.params.reason));
    } else if (msg.id != null) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
    }
  }
});
