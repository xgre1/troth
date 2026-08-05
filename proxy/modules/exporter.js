// SPDX-License-Identifier: AGPL-3.0-only
// Memory exporter — dump troth state for backup/migration.
//
// Exports: reflexions, trajectories, workflow, codelens, decisions, audit.
// Format: single JSON file, restorable via importer.

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const TROTH_DIR = path.join(HOME, '.troth');

function exportAll(outFile) {
  const exportData = {
    version: '8.0.0',
    exportedAt: new Date().toISOString(),
    project: process.env.GF_WATCH_DIR || process.cwd(),
    data: {},
  };

  // Reflexions
  try {
    const reflexion = require('./reflexion');
    exportData.data.reflexions = reflexion.getRelevantReflections(1000);
  } catch (e) { exportData.data.reflexions = null; }

  // Trajectories
  try {
    const trajectory = require('./trajectory');
    exportData.data.trajectoryStats = trajectory.getStats();
  } catch (e) { exportData.data.trajectoryStats = null; }

  // Workflow
  try {
    const workflow = require('./workflow');
    exportData.data.workflow = workflow.getState();
  } catch (e) { exportData.data.workflow = null; }

  // Audit recent
  try {
    const audit = require('./audit');
    exportData.data.auditRecent = audit.getRecent(100);
  } catch (e) { exportData.data.auditRecent = null; }

  // Cost
  try {
    const cost = require('./cost');
    exportData.data.cost = cost.getTotals();
  } catch (e) { exportData.data.cost = null; }

  // Config (with secrets redacted)
  try {
    const cfgPath = path.join(TROTH_DIR, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const secrets = require('./secrets');
      exportData.data.config = secrets.redactObject(cfg);
    }
  } catch (e) {}

  if (outFile) {
    try {
      fs.writeFileSync(outFile, JSON.stringify(exportData, null, 2));
      return { ok: true, path: outFile, sizeBytes: fs.statSync(outFile).size };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return exportData;
}

function importBackup(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Currently only restore workflow — reflexions/trajectories are project-keyed
    // and would need careful merging. Future work.
    let restored = [];
    if (data.data && data.data.workflow) {
      const wfPath = path.join(process.cwd(), '.troth', 'workflow.json');
      const dir = path.dirname(wfPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(wfPath, JSON.stringify(data.data.workflow, null, 2));
      restored.push('workflow');
    }
    return { ok: true, restored };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { exportAll, importBackup };
