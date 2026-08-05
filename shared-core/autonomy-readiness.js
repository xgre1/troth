// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Pre-flight SAFETY gate for autonomous/team mode. Decides, from the user's
// device + available providers, whether autonomy can run and HOW, so we never
// cook a weak device. Pure decision logic (no spawning, no inference).
//   cloud provider available  -> run, distribute to cloud (device cap still applies)
//   local-only + capable box  -> run, capped to the device (small pool / serial)
//   local-only + weak box      -> REFUSE: tell the user to add a provider
const { detectCapabilities } = require('./device-capabilities.js');

function assessAutonomyReadiness(input) {
  input = input || {};
  const caps = input.caps || detectCapabilities();
  const cloud = Array.isArray(input.cloudProviders) ? input.cloudProviders.filter(Boolean) : [];
  const hasCloud = cloud.length > 0;
  const localUp = input.localAvailable === true;

  // 1) Cloud available -> safest: distribute across cloud, device cap bounds locals.
  if (hasCloud) {
    return {
      canRun: true, mode: 'distributed',
      maxWorkers: caps.maxWorkerParallel,
      providers: cloud,
      note: 'Cloud providers available (' + cloud.join(', ') + '). Autonomy distributes across them; local stays within the device cap.'
    };
  }
  // 2) Local-only. The decision is DATA-DRIVEN: caps.localCanRun comes from the
  //    MEASURED fit (available memory vs the actual model size + swap), not a RAM
  //    guess. If the real model does not fit -> REFUSE; else run capped to the
  //    measured slot count.
  if (localUp) {
    if (!caps.localCanRun) {
      return {
        canRun: false, mode: 'refused',
        reason: 'Your machine cannot host the local model for autonomous mode without overloading it (' + (caps.basis || (caps.ramGb || '?') + ' GB') + '). Add a cloud provider (or a machine with more free memory) to run autonomy.'
      };
    }
    const cap = Math.max(1, Math.min(caps.maxLocalParallel, caps.maxWorkerParallel));
    return {
      canRun: true, mode: cap <= 1 ? 'local-serial' : 'local-capped',
      maxWorkers: cap,
      warning: 'Running autonomy LOCAL-ONLY: limited to ' + cap + ' worker(s) at a time (queued, not parallel) to protect the machine [' + (caps.basis || '') + ']. Add a cloud provider for faster, fuller autonomy.'
    };
  }
  // 3) Nothing usable.
  return { canRun: false, mode: 'refused', reason: 'No provider available (no cloud key, no local model up). Enable a provider to run autonomy.' };
}

// Read the live provider picture from ~/.troth/config.json: enabled CLOUD
// providers (BYOK) + whether a local model is configured. Fail-safe: on any
// error, report no-cloud (so a weak box refuses rather than over-spawns).
function gatherProviderState() {
  var cloudProviders = [], localAvailable = false;
  try {
    var os = require('os'), fs = require('fs'), path = require('path');
    var cfg = JSON.parse(fs.readFileSync(path.join((process.env.HOME || os.homedir()), '.troth', 'config.json'), 'utf8'));
    var P = cfg.providers || {};
    var LOCAL = { local: 1, llamacpp: 1, llama: 1, ollama: 1 };
    Object.keys(P).forEach(function (k) {
      var pv = P[k];
      if (!pv || !pv.enabled) return;
      if (LOCAL[k]) localAvailable = true; else cloudProviders.push(k);
    });
    // local model can also be implied by a configured local brain/default model
    if (!localAvailable && (cfg.local_model_path || (cfg.default_brain_model && /local|gguf|llama|gemma|qwen/i.test(String(cfg.default_brain_model))))) localAvailable = true;
  } catch (_) {}
  return { cloudProviders: cloudProviders, localAvailable: localAvailable };
}

// the autonomy design — context sufficiency: has the ask gathered enough to act on, or
// should the partner keep the conversation going first? Deterministic and
// cheap (no LLM call): specificity signals in the goal text + classifier
// confidence. Feeds the job-proposal card ("what I'd still want to know")
// it NEVER hard-blocks; the operator can always force-run the card.
function contextSufficiency(input) {
  input = input || {};
  const text = String(input.goal_text || '').trim();
  const conf = typeof input.confidence === 'number' ? input.confidence : null;
  const missing = [];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 8) {
    missing.push('the ask is one short phrase — say what "done" looks like');
  }
  if (!/[./~]|https?:|\b(file|repo|folder|page|doc|site|email|list|report|draft)\b/i.test(text)) {
    missing.push('no concrete target named (a file, link, doc, site, deliverable)');
  }
  if (conf != null && conf < 0.5) {
    missing.push('goal type unclear (low classification confidence)');
  }
  return { sufficient: missing.length === 0, missing };
}

module.exports = { assessAutonomyReadiness, gatherProviderState, contextSufficiency };
