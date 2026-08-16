// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: mind).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { command, passthrough } = ctx;
if (command === "mind") {
  var stateM      = require("../shared-core/state.js");
  var actionRecM  = require("../shared-core/action-record.js");
  var mindStateM  = require("../shared-core/mind-state.js");
  var subM        = passthrough[0];

  function parseMindArgs(start) {
    var out = { cwd: null, limit: 10, id: null };
    for (var i = start; i < passthrough.length; i++) {
      if (passthrough[i] === '--cwd' && i + 1 < passthrough.length)   { out.cwd = passthrough[++i]; }
      else if (passthrough[i] === '--limit' && i + 1 < passthrough.length) { out.limit = parseInt(passthrough[++i], 10); }
      else if (passthrough[i] === '--id' && i + 1 < passthrough.length) { out.id = passthrough[++i]; }
    }
    return out;
  }

  if (subM === "list") {
    var argsL = parseMindArgs(1);
    var rowsL = stateM.queryActions({
      type: 'mind_snapshot',
      cwd: argsL.cwd,
      limit: argsL.limit,
      order: 'desc'
    }) || [];
    if (rowsL.length === 0) {
      console.log("No mind snapshots yet" + (argsL.cwd ? " for cwd=" + argsL.cwd : "") + ".");
      process.exit(0);
    }
    console.log("snapshot_id".padEnd(38) + " " + "trigger".padEnd(13) + " " + "snapshot_at".padEnd(26) + " cwd");
    console.log("-".repeat(38) + " " + "-".repeat(13) + " " + "-".repeat(26) + " " + "-".repeat(40));
    for (var li = 0; li < rowsL.length; li++) {
      var recL = actionRecM.fromRow(rowsL[li]);
      var ms = recL && recL.output && recL.output.mind_state;
      var trigger = (recL && recL.input && recL.input.trigger) || '-';
      var snapAt  = (ms && ms.snapshot_at) || '(unknown)';
      console.log(recL.id + " " + trigger.padEnd(13).slice(0, 13) + " " + String(snapAt).padEnd(26).slice(0, 26) + " " + (recL.cwd || '-'));
    }
    process.exit(0);
  }

  if (subM === "show") {
    var argsS = parseMindArgs(1);
    var rowS = null;
    if (argsS.id) {
      rowS = stateM.getAction(argsS.id);
    } else {
      var rs = stateM.queryActions({
        type: 'mind_snapshot',
        cwd: argsS.cwd,
        limit: 1,
        order: 'desc'
      }) || [];
      rowS = rs[0] || null;
    }
    if (!rowS) {
      console.error("No matching snapshot.");
      process.exit(1);
    }
    var recS = actionRecM.fromRow(rowS);
    console.log(JSON.stringify({
      snapshot_id: recS.id,
      timestamp:   recS.timestamp,
      cwd:         recS.cwd,
      agent_id:    recS.agent_id,
      trigger:     recS.input && recS.input.trigger,
      summary:     recS.output && recS.output.summary,
      mind_state:  recS.output && recS.output.mind_state
    }, null, 2));
    process.exit(0);
  }

  if (subM === "focus") {
    var argsF = parseMindArgs(1);
    var rowsF = stateM.queryActions({
      type: 'mind_snapshot',
      cwd: argsF.cwd,
      limit: 1,
      order: 'desc'
    }) || [];
    if (rowsF.length === 0) {
      console.log("(no snapshot yet" + (argsF.cwd ? " for " + argsF.cwd : "") + ")");
      process.exit(0);
    }
    var recF = actionRecM.fromRow(rowsF[0]);
    var msF = recF && recF.output && recF.output.mind_state;
    var text = msF ? mindStateM.formatOrientation(msF) : '';
    process.stdout.write((text || '(empty mind state)') + '\n');
    process.exit(0);
  }

  // Helper: load latest mind_state for cwd, or fresh empty if none.
  // Returns { mind_state, prev_snapshot_id }. Used by mutation commands
  // to apply edits on top of existing state without re-typing JSON.
  function loadOrEmpty(cwd, user_id) {
    var rs = stateM.queryActions({
      type: 'mind_snapshot', cwd, limit: 1, order: 'desc'
    }) || [];
    if (rs.length === 0) {
      return { mind_state: mindStateM.emptyMindState(user_id || 'default'), prev_snapshot_id: null };
    }
    var rec = actionRecM.fromRow(rs[0]);
    var ms = rec && rec.output && rec.output.mind_state;
    return {
      mind_state: ms ? JSON.parse(JSON.stringify(ms)) : mindStateM.emptyMindState(user_id || 'default'),
      prev_snapshot_id: rec ? rec.id : null
    };
  }

  function persistMutated(cwd, mindStateObj, prevSnapshotId, trigger) {
    mindStateObj.snapshot_at = new Date().toISOString();
    var built = mindStateM.buildSnapshotRecord({
      id: require('crypto').randomUUID(),
      timestamp: Date.now(),
      agent_id: 'cli',
      cwd,
      mind_state: mindStateObj,
      trigger: trigger || 'cli',
      prev_snapshot_id: prevSnapshotId
    });
    if (!built.ok) {
      console.error("Refused: " + JSON.stringify(built.errors, null, 2));
      process.exit(2);
    }
    var v = actionRecM.validate(built.record);
    if (!v.ok) {
      console.error("ActionRecord invalid: " + JSON.stringify(v.errors, null, 2));
      process.exit(2);
    }
    var id = stateM.recordAction(built.record, actionRecM.toSearchText(built.record));
    if (!id) {
      console.error("Substrate write failed.");
      process.exit(2);
    }
    return id;
  }

  if (subM === "set-project") {
    // troth mind set-project --id <id> --name "<name>" [--stage S]
    //                          [--focus "<text>"] [--audience "<text>"]
    //                          [--cwd path]
    var sp = { id: null, name: null, stage: null, focus: null, audience: null, cwd: null };
    for (var spi = 1; spi < passthrough.length; spi++) {
      var pa = passthrough[spi], pv = passthrough[spi + 1];
      if      (pa === '--id'       && pv) { sp.id = pv; spi++; }
      else if (pa === '--name'     && pv) { sp.name = pv; spi++; }
      else if (pa === '--stage'    && pv) { sp.stage = pv; spi++; }
      else if (pa === '--focus'    && pv) { sp.focus = pv; spi++; }
      else if (pa === '--audience' && pv) { sp.audience = pv; spi++; }
      else if (pa === '--cwd'      && pv) { sp.cwd = pv; spi++; }
    }
    if (!sp.id || !sp.name) {
      console.error("Usage: troth mind set-project --id <id> --name \"<name>\" [--stage S] [--focus T] [--audience A] [--cwd P]");
      process.exit(1);
    }
    var lp = loadOrEmpty(sp.cwd, null);
    var existing = lp.mind_state.active_projects.find(function (p) { return p && p.id === sp.id; });
    if (existing) {
      existing.name = sp.name;
      if (sp.stage    !== null) existing.stage = sp.stage;
      if (sp.focus    !== null) existing.current_focus = sp.focus;
      if (sp.audience !== null) existing.audience = sp.audience;
    } else {
      lp.mind_state.active_projects.push({
        id: sp.id,
        name: sp.name,
        stage: sp.stage || null,
        current_focus: sp.focus || null,
        audience: sp.audience || null,
        key_decisions: [],
        open_questions: [],
        constraints: [],
        collaborators: []
      });
    }
    var newId = persistMutated(sp.cwd, lp.mind_state, lp.prev_snapshot_id, 'cli_set_project');
    console.log("\x1b[32m✓\x1b[0m project " + (existing ? "updated" : "added") + ": " + sp.id + " (" + sp.name + ")");
    console.log("  snapshot: " + newId);
    process.exit(0);
  }

  if (subM === "decision") {
    // troth mind decision --project <id> --summary "..." [--rationale "..."] [--cwd P]
    var dc = { project: null, summary: null, rationale: '', cwd: null };
    for (var di = 1; di < passthrough.length; di++) {
      var da = passthrough[di], dv = passthrough[di + 1];
      if      (da === '--project'   && dv) { dc.project = dv; di++; }
      else if (da === '--summary'   && dv) { dc.summary = dv; di++; }
      else if (da === '--rationale' && dv) { dc.rationale = dv; di++; }
      else if (da === '--cwd'       && dv) { dc.cwd = dv; di++; }
    }
    if (!dc.project || !dc.summary) {
      console.error("Usage: troth mind decision --project <id> --summary \"...\" [--rationale \"...\"] [--cwd P]");
      process.exit(1);
    }
    var rec = {
      id: require('crypto').randomUUID(),
      timestamp: Date.now(),
      type: 'decision',
      agent_id: 'cli',
      cwd: dc.cwd,
      input: {
        kind: 'mind_decision',
        signals: {
          project_id: dc.project,
          summary: String(dc.summary).slice(0, 400),
          rationale: String(dc.rationale).slice(0, 800)
        }
      },
      output: { decision: 'recorded', reason: 'manual_capture' },
      verification: {},
      outcome: {}
    };
    var v = actionRecM.validate(rec);
    if (!v.ok) {
      console.error("Refused: " + JSON.stringify(v.errors, null, 2));
      process.exit(2);
    }
    var dId = stateM.recordAction(rec, actionRecM.toSearchText(rec));
    if (!dId) {
      console.error("Substrate write failed.");
      process.exit(2);
    }
    console.log("\x1b[32m✓\x1b[0m decision recorded for project " + dc.project);
    console.log("  decision_id: " + dId);
    console.log("  summary:     " + dc.summary);
    console.log("  (folded into key_decisions on next persist / Stop / pre-compact)");
    process.exit(0);
  }

  if (subM === "compact") {
    // troth mind compact [--cwd P] [--keep-last N] [--older-than-days D]
    var cm = { cwd: null, keepLast: 5, olderThanDays: 30 };
    for (var cmi = 1; cmi < passthrough.length; cmi++) {
      var cma = passthrough[cmi], cmv = passthrough[cmi + 1];
      if      (cma === '--cwd' && cmv) { cm.cwd = cmv; cmi++; }
      else if (cma === '--keep-last' && cmv) { cm.keepLast = parseInt(cmv, 10); cmi++; }
      else if (cma === '--older-than-days' && cmv) { cm.olderThanDays = parseInt(cmv, 10); cmi++; }
    }
    var cmRows = stateM.queryActions({
      type: 'mind_snapshot',
      cwd: cm.cwd,
      limit: 1000,
      order: 'desc'
    }) || [];
    if (cmRows.length === 0) {
      console.log("No snapshots to compact.");
      process.exit(0);
    }
    var alreadyArchived = mindStateM.getArchivedSnapshotIds(stateM, cm.cwd);
    var keepThreshold = Date.now() - cm.olderThanDays * 24 * 60 * 60 * 1000;
    // Live snapshots only (exclude already-archived). Keep the
    // most-recent N, archive everything older AND past the day threshold.
    var live = cmRows.filter(function (r) { return !alreadyArchived.has(r.id); });
    var keepers = new Set(live.slice(0, cm.keepLast).map(function (r) { return r.id; }));
    var toArchive = live.filter(function (r) {
      return !keepers.has(r.id) && (r.timestamp || 0) < keepThreshold;
    });
    if (toArchive.length === 0) {
      console.log("Nothing to archive (kept " + Math.min(live.length, cm.keepLast) + " recent, " + alreadyArchived.size + " already archived).");
      process.exit(0);
    }
    var written = 0;
    for (var ai = 0; ai < toArchive.length; ai++) {
      var built = mindStateM.buildArchiveEventRecord({
        id: require('crypto').randomUUID(),
        timestamp: Date.now(),
        agent_id: 'cli',
        cwd: cm.cwd,
        archived_snapshot_id: toArchive[ai].id,
        reason: 'cli_compact'
      });
      if (!built.ok) continue;
      var v = actionRecM.validate(built.record);
      if (!v.ok) continue;
      var aId = stateM.recordAction(built.record, actionRecM.toSearchText(built.record));
      if (aId) written++;
    }
    console.log("\x1b[32m✓\x1b[0m archived " + written + " snapshot(s) older than " + cm.olderThanDays + " days; kept " + Math.min(live.length, cm.keepLast) + " most recent.");
    process.exit(0);
  }

  if (subM === "distill") {
    // troth mind distill --project <id> [--cwd P]
    var dl = { project: null, cwd: null };
    for (var dli = 1; dli < passthrough.length; dli++) {
      var dla = passthrough[dli], dlv = passthrough[dli + 1];
      if      (dla === '--project' && dlv) { dl.project = dlv; dli++; }
      else if (dla === '--cwd'     && dlv) { dl.cwd = dlv; dli++; }
    }
    if (!dl.project) {
      console.error("Usage: troth mind distill --project <id> [--cwd P]");
      process.exit(1);
    }
    var driver = mindStateM.makeHttpDistillDriverFromEnv(process.env);
    if (!driver) {
      console.error("\x1b[33m!\x1b[0m no LLM endpoint configured.");
      console.error("    set TROTH_MIND_DISTILL_ENDPOINT (OpenAI-compatible base URL) to enable.");
      console.error("    e.g. TROTH_MIND_DISTILL_ENDPOINT=http://localhost:11434 TROTH_MIND_DISTILL_MODEL=qwen2.5:7b");
      process.exit(2);
    }

    // Find the project.
    var snapDl = stateM.queryActions({ type: 'mind_snapshot', cwd: dl.cwd, limit: 1, order: 'desc' }) || [];
    if (snapDl.length === 0) {
      console.error("No mind snapshot found" + (dl.cwd ? " for " + dl.cwd : "") + ".");
      process.exit(1);
    }
    var snapDlRec = actionRecM.fromRow(snapDl[0]);
    var msDl = snapDlRec && snapDlRec.output && snapDlRec.output.mind_state;
    var projDl = msDl && Array.isArray(msDl.active_projects)
      ? msDl.active_projects.find(function (p) { return p && p.id === dl.project; })
      : null;
    if (!projDl) {
      console.error("Project not found in latest snapshot: " + dl.project);
      process.exit(1);
    }

    // Pull decisions + intents.
    var dlSince = Date.now() - 30 * 24 * 60 * 60 * 1000;
    var decRowsDl = stateM.queryActions({ type: 'decision', cwd: dl.cwd, since: dlSince, limit: 200, order: 'asc' }) || [];
    var decisionsDl = decRowsDl.map(function (r) { return actionRecM.fromRow(r); })
      .filter(function (rec) {
        return rec && rec.input && rec.input.kind === 'mind_decision'
            && rec.input.signals && rec.input.signals.project_id === dl.project;
      });
    var intentRowsDl = stateM.queryActions({ type: 'intent', cwd: dl.cwd, since: dlSince, limit: 100, order: 'asc' }) || [];
    var intentsDl = intentRowsDl.map(function (r) { return actionRecM.fromRow(r); }).filter(Boolean);

    console.log("Distilling \x1b[1m" + projDl.name + "\x1b[0m (" + decisionsDl.length + " decisions, " + intentsDl.length + " intents)...");

    mindStateM.distillProject({
      project: projDl,
      decisions: decisionsDl.map(function (rec) {
        return {
          decision_id: rec.id,
          summary: rec.input.signals && rec.input.signals.summary,
          rationale: rec.input.signals && rec.input.signals.rationale
        };
      }),
      intents: intentsDl.map(function (rec) { return { goal: rec.input && rec.input.goal }; }),
      driver: driver
    }).then(function (result) {
      if (!result.ok) {
        console.error("Skipped: " + result.reason + (result.detail ? " (" + result.detail + ")" : ""));
        process.exit(2);
      }
      var built = mindStateM.buildDistillationEventRecord({
        id: require('crypto').randomUUID(),
        timestamp: Date.now(),
        agent_id: 'cli',
        cwd: dl.cwd,
        project_id: dl.project,
        summary: result.summary,
        used_decision_ids: result.used_decision_ids
      });
      if (!built.ok) {
        console.error("Refused: " + JSON.stringify(built.errors));
        process.exit(2);
      }
      var v = actionRecM.validate(built.record);
      if (!v.ok) {
        console.error("ActionRecord invalid: " + JSON.stringify(v.errors));
        process.exit(2);
      }
      var did = stateM.recordAction(built.record, actionRecM.toSearchText(built.record));
      console.log("\x1b[32m✓\x1b[0m distilled. distillation_id: " + did);
      console.log();
      console.log(result.summary);
      process.exit(0);
    }).catch(function (e) {
      console.error("Driver error: " + (e && e.message || e));
      process.exit(2);
    });
    return; // promise-driven; no synchronous fall-through
  }

  if (subM === "export") {
    // troth mind export [dest] — the whole mind as one carryable bundle:
    // state.db + manifest, stamped with the journal position it was cut at.
    // AirDrop it, copy it, keep it — the same bundle shape the app's Move
    // flow shares and the weekly background backup writes.
    var backupX = require("../shared-core/substrate-backup.js");
    var destX = passthrough[1];
    if (!destX) {
      var stampX = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      destX = require("path").join(require("../shared-core/troth-home.js").trothDir(), "backups", "substrate-" + stampX);
    }
    var rX = backupX.exportArchive({ out_path: destX });
    if (!rX.ok) { console.error("export failed: " + rX.error); process.exit(2); }
    console.log("\x1b[32m✓\x1b[0m mind exported: " + rX.bundle_path);
    console.log("  engrams: " + (rX.manifest.engram_count == null ? "?" : rX.manifest.engram_count) +
      (rX.manifest.sync_latest_gseq != null ? "   journal position: " + rX.manifest.sync_latest_gseq : ""));
    console.log("  restore on a machine: troth mind import " + rX.bundle_path + " --replace");
    process.exit(0);
  }

  if (subM === "import") {
    // troth mind import <bundle-dir> [--replace] — refuses while the proxy
    // answers /health: replacing the file under a live writer tears the
    // mind. The entity daemon and the app hold the same file — the message
    // says to stop them too, because a port probe cannot see them all.
    var inX = passthrough[1];
    var wantReplaceX = passthrough.indexOf("--replace") >= 0;
    if (!inX) { console.error("Usage: troth mind import <bundle-dir> [--replace]"); process.exit(1); }
    var cfgI = ctx.loadConfig();
    var httpI = require("http");
    var doImportX = function () {
      var backupI = require("../shared-core/substrate-backup.js");
      var rI = backupI.importArchive({ in_path: inX, replace: wantReplaceX });
      if (!rI.ok) { console.error("import failed: " + rI.error); process.exit(2); }
      console.log("\x1b[32m✓\x1b[0m mind imported from " + inX);
      console.log("  start troth and it wakes up as that mind.");
      process.exit(0);
    };
    var reqI = httpI.request({ host: "127.0.0.1", port: cfgI.port || 8000, path: "/health", timeout: 1500 }, function (resI) {
      resI.resume();
      if (resI.statusCode === 200) {
        console.error("the proxy is answering on :" + (cfgI.port || 8000) + " — a mind cannot be replaced under a live writer.");
        console.error("quit the troth app and stop the proxy (and the entity daemon), then rerun.");
        process.exit(2);
      }
      doImportX();
    });
    reqI.on("error", doImportX);
    reqI.on("timeout", function () { reqI.destroy(); doImportX(); });
    reqI.end();
    return; // probe-driven; no synchronous fall-through
  }

  console.error("Usage:");
  console.error("  troth mind list        [--cwd <path>] [--limit N]");
  console.error("  troth mind show        [--cwd <path>] [--id <snapshot-uuid>]");
  console.error("  troth mind focus       [--cwd <path>]");
  console.error("  troth mind set-project --id <id> --name \"<name>\" [--stage S] [--focus T] [--audience A] [--cwd P]");
  console.error("  troth mind decision    --project <id> --summary \"...\" [--rationale \"...\"] [--cwd P]");
  console.error("  troth mind distill     --project <id> [--cwd P]   (requires TROTH_MIND_DISTILL_ENDPOINT)");
  console.error("  troth mind compact     [--cwd P] [--keep-last N=5] [--older-than-days D=30]");
  console.error("  troth mind export      [dest]                     (the mind as one carryable bundle)");
  console.error("  troth mind import      <bundle-dir> [--replace]   (refuses under a running proxy)");
  process.exit(1);
}
};
