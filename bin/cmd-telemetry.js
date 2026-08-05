// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: telemetry).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, fetchProxyJson } = ctx;
if (command === "telemetry") {
  // Detailed Opus 4.7 telemetry dump
  var s = fetchProxyJson('/api/stats');
  if (!s) { console.error('Cannot reach proxy. Is it running?'); process.exit(1); }
  console.log('=== troth Model Telemetry ===');

  console.log('\n[Auth Mode]');
  if (s.authmode) {
    console.log('  API key requests: ' + s.authmode.apiKeyRequests);
    console.log('  OAuth requests:   ' + s.authmode.oauthRequests);
    console.log('  No auth:          ' + s.authmode.noAuthRequests);
    if (s.authmode.firstOauthAt) console.log('  First OAuth seen: ' + new Date(s.authmode.firstOauthAt).toISOString());
  }

  console.log('\n[Cache Ratio (per model)]');
  if (s.cacheratio && s.cacheratio.perModel) {
    Object.keys(s.cacheratio.perModel).forEach(function(k){
      var v = s.cacheratio.perModel[k];
      console.log('  ' + k);
      console.log('    requests: ' + v.requests + ' | hit: ' + (v.hitRatio == null ? 'n/a' : (v.hitRatio*100).toFixed(1) + '%') + ' | write: ' + (v.writeRatio == null ? 'n/a' : (v.writeRatio*100).toFixed(1) + '%'));
      console.log('    reads: ' + v.reads + ' | writes: ' + v.writes + ' | uncached: ' + v.uncached);
    });
  } else { console.log('  (no data yet)'); }

  console.log('\n[Token Drift (per model)]');
  if (s.tokencount && s.tokencount.perModelDrift) {
    var dKeys = Object.keys(s.tokencount.perModelDrift);
    if (dKeys.length === 0) console.log('  (no samples yet — need real Anthropic responses)');
    dKeys.forEach(function(k){
      var d = s.tokencount.perModelDrift[k];
      var sign = d.meanDrift >= 0 ? '+' : '';
      console.log('  ' + k + ': mean drift ' + sign + (d.meanDrift*100).toFixed(2) + '% (stddev ' + (d.stddev*100).toFixed(2) + '%) over ' + d.samples + ' samples');
    });
    if (s.tokencount.calls > 0) {
      console.log('  count_tokens API: ' + s.tokencount.calls + ' calls, ' + s.tokencount.cacheHits + ' cache hits, avg ' + s.tokencount.avgLatencyMs + 'ms');
    }
  }

  console.log('\n[Alibaba Caps]');
  if (s.alibabaCaps) {
    console.log('  Default cap:      ' + s.alibabaCaps.defaultCap);
    console.log('  Rejections:       ' + s.alibabaCaps.rejections);
    console.log('  Runtime updates:  ' + s.alibabaCaps.runtimeUpdates);
    if (s.alibabaCaps.caps) {
      Object.keys(s.alibabaCaps.caps).forEach(function(m){
        console.log('    ' + m + ': ' + s.alibabaCaps.caps[m]);
      });
    }
  }

  console.log('\n[Compression Buffer]');
  if (s.compressionbuffer) {
    console.log('  Threshold:        ' + (s.compressionbuffer.threshold * 100) + '%');
    console.log('  Checks:           ' + s.compressionbuffer.checks);
    console.log('  Triggered:        ' + s.compressionbuffer.triggered + ' (' + (s.compressionbuffer.triggerRate*100).toFixed(1) + '%)');
    if (s.compressionbuffer.lastTriggerModel) console.log('  Last trigger:     ' + s.compressionbuffer.lastTriggerModel + ' at ' + (s.compressionbuffer.lastTriggerPct*100).toFixed(1) + '%');
  }

  console.log('\n[Vision Validator]');
  if (s.visionvalidator) {
    console.log('  Limit (long edge): ' + s.visionvalidator.maxLongEdge + 'px');
    console.log('  Scanned:           ' + s.visionvalidator.scanned);
    console.log('  Oversized:         ' + s.visionvalidator.oversized);
    if (s.visionvalidator.lastOversize) {
      var o = s.visionvalidator.lastOversize;
      console.log('  Last oversize:     ' + o.width + 'x' + o.height + ' (long edge ' + o.longEdge + 'px)');
    }
  }

  console.log('\n[/ultrareview]');
  if (s.ultrareview) console.log('  Triggered: ' + s.ultrareview.triggered + (s.ultrareview.lastTriggerAgo != null ? ' (last ' + s.ultrareview.lastTriggerAgo + 's ago)' : ''));

  console.log('\n[Error Taxonomy]');
  if (s.errortax) {
    console.log('  Total errors: ' + s.errortax.total);
    if (s.errortax.byClass) {
      Object.keys(s.errortax.byClass).forEach(function(c){
        console.log('    ' + c + ': ' + s.errortax.byClass[c]);
      });
    }
    if (s.errortax.byModel) {
      console.log('  By model:');
      Object.keys(s.errortax.byModel).forEach(function(m){
        var byCls = s.errortax.byModel[m];
        var summary = Object.keys(byCls).map(function(c){return c + '=' + byCls[c];}).join(' ');
        console.log('    ' + m + ': ' + summary);
      });
    }
  }
  process.exit(0);
}
};
