// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: stats).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, fetchProxyJson } = ctx;
if (command === "stats") {
  var s = fetchProxyJson('/api/stats');
  if (!s) { console.error('Cannot reach proxy. Is it running?'); process.exit(1); }
  console.log('=== troth v' + (s.version || '?') + ' Stats ===');
  console.log('Requests:    ' + (s.requests || 0));
  console.log('Errors:      ' + (s.errors || 0));
  if (s.router) {
    console.log('\nRouter:');
    console.log('  Anthropic API: ' + (s.router.anthropicCalls || 0));
    console.log('  Alibaba:       ' + (s.router.alibabaCalls || 0));
    console.log('  DeepInfra:     ' + (s.router.deepinfraCalls || 0));
    console.log('  OpenRouter:    ' + (s.router.openrouterCalls || 0));
    console.log('  Fallbacks:     ' + (s.router.fallbacks || 0));
    console.log('  Flash calls:   ' + (s.router.flashCalls || 0));
  }
  if (s.codelens) console.log('\nCodeLens: ' + s.codelens.entities + ' entities, ' + s.codelens.queries + ' queries');
  if (s.critic) {
    console.log('\nCritic: ' + s.critic.issuesFound + ' issues found');
    console.log('  Reviews: write=' + (s.critic.reviews.write || 0) + ' edit=' + (s.critic.reviews.edit || 0) + ' bash=' + (s.critic.reviews.bash || 0));
    if (s.critic.qualityScoreAvg !== null) console.log('  Avg quality: ' + s.critic.qualityScoreAvg + '/10');
  }
  if (s.reflexion) console.log('\nReflexion: ' + (s.reflexion.totalStored || 0) + ' lessons stored, ' + (s.reflexion.reflectionsInjected || 0) + ' injected');
  if (s.trajectory) console.log('Trajectory: ' + (s.trajectory.totalStored || 0) + ' patterns, ' + (s.trajectory.retrieved || 0) + ' retrieved');
  if (s.workflow) console.log('Workflow: ' + (s.workflow.task ? '"' + s.workflow.task.slice(0, 60) + '" (' + s.workflow.phase + ')' : 'idle'));
  if (s.cochange) console.log('CoChange: ' + (s.cochange.trackedFiles || 0) + ' files tracked');
  if (s.checkpoint) console.log('Checkpoints: ' + (s.checkpoint.checkpointed || 0) + ' created, ' + (s.checkpoint.rollbacks || 0) + ' rollbacks');
  // Opus 4.7 / April 2026 telemetry summary
  if (s.authmode || s.cacheratio || s.errortax) {
    console.log('\n--- model telemetry ---');
    if (s.authmode) console.log('Auth: api-key=' + (s.authmode.apiKeyRequests||0) + ' oauth=' + (s.authmode.oauthRequests||0));
    if (s.cacheratio && s.cacheratio.perModel) {
      var crKeys = Object.keys(s.cacheratio.perModel);
      crKeys.forEach(function(k){
        var v = s.cacheratio.perModel[k];
        var ratio = v.hitRatio == null ? 'n/a' : (v.hitRatio*100).toFixed(1) + '%';
        console.log('  Cache hit (' + k + '): ' + ratio + ' over ' + v.requests + ' reqs');
      });
    }
    if (s.errortax && s.errortax.total > 0) {
      console.log('Errors: ' + s.errortax.total + ' total');
      Object.keys(s.errortax.byClass).forEach(function(c){
        console.log('  ' + c + ': ' + s.errortax.byClass[c]);
      });
    }
    if (s.compressionbuffer && s.compressionbuffer.triggered > 0) {
      console.log('Compression buffer: ' + s.compressionbuffer.triggered + ' triggers / ' + s.compressionbuffer.checks + ' checks');
    }
    if (s.ultrareview && s.ultrareview.triggered > 0) {
      console.log('/ultrareview: ' + s.ultrareview.triggered + ' triggers');
    }
  }
  process.exit(0);
}
};
