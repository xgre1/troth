// SPDX-License-Identifier: AGPL-3.0-only
// Budget enforcement — hard cost limits per session/day to prevent runaway spend.
//
// Configurable via ~/.troth/config.json:
//   { "budget": { "perSessionUSD": 5.00, "perDayUSD": 20.00, "warnAt": 0.80 } }
//
// When threshold reached, returns a routing recommendation to switch to
// cheaper providers or block. Critic surfaces warning to agent.

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const CONFIG_FILE = path.join(HOME, '.troth', 'config.json');

function loadBudget() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.budget || {};
  } catch (e) { return {}; }
}

function checkBudget(sessionCostUSD, dailyCostUSD) {
  const b = loadBudget();
  const result = { ok: true, warnings: [], blocked: false, suggestion: null };

  const perSession = b.perSessionUSD || Infinity;
  const perDay = b.perDayUSD || Infinity;
  const warnAt = b.warnAt || 0.80;

  if (sessionCostUSD >= perSession) {
    result.ok = false;
    result.blocked = true;
    result.suggestion = 'session-budget-exceeded';
    result.warnings.push('Session budget $' + perSession + ' EXCEEDED ($' + sessionCostUSD + '). Switch to free tier or stop.');
  } else if (sessionCostUSD >= perSession * warnAt) {
    result.warnings.push('Session budget warning: $' + sessionCostUSD + ' / $' + perSession + ' (' + Math.round(100 * sessionCostUSD / perSession) + '%)');
    result.suggestion = 'consider-cheap-tier';
  }

  if (dailyCostUSD >= perDay) {
    result.ok = false;
    result.blocked = true;
    result.suggestion = 'daily-budget-exceeded';
    result.warnings.push('Daily budget $' + perDay + ' EXCEEDED ($' + dailyCostUSD + '). Stop until tomorrow or raise limit.');
  } else if (dailyCostUSD >= perDay * warnAt) {
    result.warnings.push('Daily budget warning: $' + dailyCostUSD + ' / $' + perDay + ' (' + Math.round(100 * dailyCostUSD / perDay) + '%)');
  }

  return result;
}

function getStats() {
  const b = loadBudget();
  return { perSessionUSD: b.perSessionUSD || null, perDayUSD: b.perDayUSD || null, warnAt: b.warnAt || 0.80 };
}

module.exports = { checkBudget, loadBudget, getStats };
