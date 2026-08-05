// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: replay).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { loadConfig, command, passthrough } = ctx;
if (command === "replay") {
  var stateR = require("../shared-core/state.js");
  var cfLib  = require("../shared-core/counterfactual.js");
  var intentArg = null, branchArg = null, useIdx = null;
  var doList = false, doDiff = false, doDiscard = false, doEstimate = false, doMaterialize = false;
  var matBackend = null;
  for (var ri = 0; ri < passthrough.length; ri++) {
    var a = passthrough[ri];
    if (a === '--intent' && ri + 1 < passthrough.length) { intentArg = passthrough[++ri]; }
    else if (a === '--branch' && ri + 1 < passthrough.length) { branchArg = passthrough[++ri]; }
    else if (a === '--use' && ri + 1 < passthrough.length) { useIdx = parseInt(passthrough[++ri], 10); }
    else if (a === '--list') { doList = true; }
    else if (a === '--diff') { doDiff = true; }
    else if (a === '--discard') { doDiscard = true; }
    else if (a === '--estimate') { doEstimate = true; }
    else if (a === '--materialize') { doMaterialize = true; }
    else if (a === '--backend' && ri + 1 < passthrough.length) { matBackend = passthrough[++ri]; }
  }

  if (doList) {
    var rows = stateR.listBranches({ limit: 50 });
    if (!rows.length) { console.log("No counterfactual branches yet."); process.exit(0); }
    console.log("status        cost_est   intent_id    substituted_path");
    console.log("-".repeat(72));
    for (var lr = 0; lr < rows.length; lr++) {
      var b = rows[lr];
      console.log(
        (b.status + "       ").slice(0, 13) + " " +
        (b.cost_estimate != null ? ('$' + b.cost_estimate.toFixed(4)) : '       -').padEnd(10) + " " +
        b.branch_point_id.slice(0, 8) + "     " +
        (b.substituted_path || '').slice(0, 40)
      );
    }
    process.exit(0);
  }

  if (intentArg && useIdx == null && !doEstimate) {
    // List alternatives for the intent.
    var alts = cfLib.proposeAlternatives(stateR, intentArg);
    if (!alts.length) {
      console.log("No alternatives_considered recorded for intent " + intentArg.slice(0, 8) + ".");
      console.log("Tip: capture intents with TROTH_CAPTURE_INTENT=1; the extractor populates");
      console.log("alternatives_considered when the prompt uses 'or' / 'instead of' / 'either'.");
      process.exit(0);
    }
    console.log("Alternatives for intent " + intentArg.slice(0, 8) + ":");
    console.log("Original chosen_path: " + (alts[0].chosen_path_original || '(none)'));
    console.log("");
    for (var ai = 0; ai < alts.length; ai++) {
      console.log("  [" + alts[ai].index + "] " + alts[ai].substituted_path);
    }
    console.log("");
    console.log("Run: troth replay --intent " + intentArg.slice(0, 8) + "... --use <N> [--estimate]");
    process.exit(0);
  }

  if (intentArg && useIdx != null) {
    var altsU = cfLib.proposeAlternatives(stateR, intentArg);
    if (useIdx < 0 || useIdx >= altsU.length) {
      console.error("Index " + useIdx + " out of range (0.." + (altsU.length - 1) + ")");
      process.exit(1);
    }
    var picked = altsU[useIdx];
    var bid = cfLib.createCandidate(stateR, intentArg, picked.substituted_path);
    if (!bid) { console.error("Failed to create branch."); process.exit(1); }
    var branch = stateR.getBranch(bid);
    var baseline = cfLib.originalBaseline(stateR, intentArg);
    console.log("Created candidate branch " + bid.slice(0, 8));
    console.log("  intent:           " + intentArg.slice(0, 8));
    console.log("  original_path:    " + picked.chosen_path_original);
    console.log("  substituted_path: " + picked.substituted_path);
    console.log("  baseline_cost:    $" + (baseline.cost ? baseline.cost.usd.toFixed(4) : '0.0000'));
    console.log("  cost_estimate:    $" + (branch.cost_estimate != null ? branch.cost_estimate.toFixed(4) : '0.0000'));

    if (!doMaterialize) {
      console.log("");
      console.log("Dry-run. Re-run with --materialize to actually evaluate the alternative");
      console.log("(asks the local model what would have happened; uses backendHost/Port from config).");
      process.exit(0);
    }

    // ── Materialize via the configured local backend ──
    // We ask the LLM to imagine it had chosen substituted_path and report
    // its best estimate of {satisfied, cost_usd, verification, edits}. The
    // model must reply with a single JSON object so we can persist it.
    // Direct to backend (not through proxy) so we don't trigger injection
    // or cache writes — replay is a pure thought experiment.
    var cfgRR = loadConfig();
    var bHost = matBackend ? matBackend.split(':')[0] : (cfgRR.backendHost || '127.0.0.1');
    var bPort = matBackend ? parseInt(matBackend.split(':')[1] || '11434', 10) : (cfgRR.backendPort || 11434);
    var bModel = cfgRR.model || 'qwen3.6:35b';
    console.log("");
    console.log("Materializing via " + bHost + ":" + bPort + " (" + bModel + ")...");

    var intentRow = stateR.getAction(intentArg);
    var intentRecObj = require("../shared-core/action-record.js").fromRow(intentRow);
    var goal = (intentRecObj.input && intentRecObj.input.goal) || '(unknown goal)';

    var prompt = [
      "You are evaluating a counterfactual: what would have happened if the agent had chosen a DIFFERENT implementation path for this goal.",
      "",
      "Goal: " + goal,
      "Original path the agent took: " + (picked.chosen_path_original || '(unknown)'),
      "Counterfactual path you should evaluate: " + picked.substituted_path,
      "",
      "Baseline (what the original path actually achieved):",
      "  cost USD:     " + (baseline.cost ? baseline.cost.usd.toFixed(4) : '0.0000'),
      "  verification: " + baseline.verification.pass + " pass / " + baseline.verification.fail + " fail",
      "  subtree size: " + baseline.node_count + " nodes",
      "",
      "Estimate the counterfactual outcome. Reply with ONLY a JSON object on a single line:",
      '{"satisfied": <bool>, "cost_usd": <number>, "verification": {"pass": <int>, "fail": <int>}, "edits": <int>, "notes": "<short reasoning>"}',
      "",
      "Be honest. If the alternative would have been worse, say so."
    ].join("\n");

    var http2 = require('http');
    var oaiBody = JSON.stringify({
      model: bModel, max_tokens: 4096, stream: false,
      messages: [{ role: 'user', content: prompt }]
    });

    // Wrap async work in an IIFE since this whole file is top-level CJS,
    // not an ES module. await isn't allowed at this scope.
    (async function () {
      var matRes = await new Promise(function (resolve) {
        var rqq = http2.request({
          hostname: bHost, port: bPort, path: '/v1/chat/completions',
          method: 'POST', timeout: 120000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(oaiBody) }
        }, function (r) {
          var chunks = [];
          r.on('data', function (c) { chunks.push(c); });
          r.on('end', function () { resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }); });
        });
        rqq.on('error', function (e) { resolve({ error: e.message }); });
        rqq.on('timeout', function () { rqq.destroy(); resolve({ error: 'timeout' }); });
        rqq.write(oaiBody); rqq.end();
      });

      if (matRes.error || matRes.status !== 200) {
        console.error("Backend call failed: " + (matRes.error || ('HTTP ' + matRes.status)));
        console.error("Branch left as candidate; you can retry with --materialize.");
        process.exit(1);
      }

      var modelText = '';
      try {
        var oaiResp = JSON.parse(matRes.body);
        modelText = ((oaiResp.choices || [])[0] || {}).message ? oaiResp.choices[0].message.content : '';
      } catch (_) {}

      // Pull the JSON out of the response (model may wrap in prose / fences).
      var jsonMatch = modelText.match(/\{[\s\S]*\}/);
      var outcome = null;
      if (jsonMatch) {
        try { outcome = JSON.parse(jsonMatch[0]); } catch (_) {}
      }
      if (!outcome || typeof outcome !== 'object') {
        console.error("Model response did not contain valid JSON outcome.");
        console.error("Raw response:\n" + modelText.slice(0, 600));
        process.exit(1);
      }

      var matResult = await cfLib.materializeBranch(stateR, bid, async function () {
        return {
          satisfied: !!outcome.satisfied,
          cost_usd: typeof outcome.cost_usd === 'number' ? outcome.cost_usd : 0,
          verification: outcome.verification || { pass: 0, fail: 0 },
          edits: typeof outcome.edits === 'number' ? new Array(outcome.edits).fill({ file_path: '?', hash_after: '?' }) : [],
          notes: outcome.notes || null
        };
      });
      if (!matResult.ok) {
        console.error("materializeBranch failed: " + matResult.error);
        process.exit(2);
      }

      // Auto-show the diff so you don't have to copy the branch_id.
      var dd = cfLib.diffBranch(stateR, bid);
      console.log("");
      console.log("\x1b[32m✓\x1b[0m materialized — model verdict:");
      console.log("  satisfied:    " + (outcome.satisfied ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'));
      console.log("  cost_usd:     $" + (outcome.cost_usd || 0).toFixed(4));
      console.log("  verification: " + (outcome.verification && outcome.verification.pass) + " pass / " + (outcome.verification && outcome.verification.fail) + " fail");
      console.log("  notes:        " + (outcome.notes || '(none)'));
      console.log("");
      console.log("Diff vs original:");
      console.log("  baseline cost: $" + (dd.cost.original_usd != null ? dd.cost.original_usd.toFixed(4) : '?'));
      console.log("  branch cost:   $" + (dd.cost.branch_usd != null ? dd.cost.branch_usd.toFixed(4) : '?'));
      if (dd.cost.delta_usd != null) {
        var sgn = dd.cost.delta_usd >= 0 ? '+' : '';
        console.log("  delta:         " + sgn + "$" + dd.cost.delta_usd.toFixed(4) +
                    (dd.cost.pct_change != null ? " (" + sgn + dd.cost.pct_change.toFixed(1) + "%)" : ""));
      }
      console.log("");
      console.log("Verdict: " +
        (dd.cheaper === true ? "\x1b[32mcheaper\x1b[0m" : dd.cheaper === false ? "\x1b[31mmore expensive\x1b[0m" : "—") +
        " · " + (dd.safer ? "\x1b[32mno regressions\x1b[0m" : "\x1b[31mpotential regressions\x1b[0m"));
      console.log("");
      console.log("Branch persisted: troth replay --branch " + bid.slice(0, 8) + " --diff");
      process.exit(0);
    })();
    return; // hand control to the async IIFE
  }

  if (branchArg && doDiff) {
    var d = cfLib.diffBranch(stateR, branchArg);
    if (!d) { console.error("Branch not found: " + branchArg); process.exit(1); }
    console.log("Branch:           " + d.branch_id.slice(0, 8) + " (" + d.branch_status + ")");
    console.log("Intent:           " + d.intent_id.slice(0, 8));
    console.log("Original path:    " + (d.chosen_path_original || '(none)'));
    console.log("Substituted path: " + d.substituted_path);
    console.log("");
    console.log("Cost:");
    console.log("  original $" + (d.cost.original_usd != null ? d.cost.original_usd.toFixed(4) : '?'));
    console.log("  branch   $" + (d.cost.branch_usd != null ? d.cost.branch_usd.toFixed(4) : '? (not materialized)'));
    if (d.cost.delta_usd != null) {
      var sign = d.cost.delta_usd >= 0 ? '+' : '';
      console.log("  delta    " + sign + "$" + d.cost.delta_usd.toFixed(4) +
                  " (" + sign + (d.cost.pct_change || 0).toFixed(1) + "%)");
    }
    console.log("");
    console.log("Verification:");
    console.log("  original pass=" + d.verification.original.pass + " fail=" + d.verification.original.fail);
    if (d.verification.branch) {
      console.log("  branch   pass=" + d.verification.branch.pass + " fail=" + d.verification.branch.fail +
                  " satisfied=" + d.verification.satisfied);
    }
    console.log("");
    console.log("Verdict: " +
      (d.cheaper === true ? "\x1b[32mcheaper\x1b[0m" : d.cheaper === false ? "more expensive" : "—") +
      ", " + (d.safer ? "\x1b[32mno regressions\x1b[0m" : "potential regressions"));
    process.exit(0);
  }

  if (branchArg && doDiscard) {
    var ok = cfLib.discardBranch(stateR, branchArg);
    if (!ok) { console.error("Discard failed (branch not found?)"); process.exit(1); }
    console.log("\x1b[32m✓\x1b[0m discarded branch " + branchArg.slice(0, 8));
    process.exit(0);
  }

  console.error("Usage:");
  console.error("  troth replay --intent <id>                  # list alternatives");
  console.error("  troth replay --intent <id> --use <N>        # create candidate branch");
  console.error("  troth replay --intent <id> --use <N> --estimate    # dry-run, no model call");
  console.error("  troth replay --intent <id> --use <N> --materialize  # ask local model + auto-diff");
  console.error("  troth replay --branch <id> --diff           # diff vs baseline");
  console.error("  troth replay --branch <id> --discard        # mark discarded");
  console.error("  troth replay --list                         # list all branches");
  process.exit(1);
}
};
