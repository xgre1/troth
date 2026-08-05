// SPDX-License-Identifier: AGPL-3.0-only
const path = require('path');

// Research sweet spot: 10-20K tokens for Q&A, ~32K for features.
// Default 12000 (research-backed) — configurable via codeLensTokenBudget.
var MAX_TOKENS = 12000;
try {
  var _cfg = JSON.parse(require('fs').readFileSync(
    require('path').join(process.env.HOME || require('os').homedir(), '.troth', 'config.json'), 'utf8'
  ));
  if (_cfg.codeLensTokenBudget) MAX_TOKENS = _cfg.codeLensTokenBudget;
} catch (e) {}

function estimateTokens(text) {
  return Math.ceil(text.length * 0.75 / 4);
}

// AttnRoute HOT/WARM/COLD working memory (research [Proxy]: 200K → 2K, 99% reduction).
//   HOT  — recently touched files: full entity list with signatures + caller/callee inline
//   WARM — files reachable in graph from HOT but not touched: top entities only
//   COLD — everything else: SKIPPED
//
// Allocate token budget: 60% HOT, 35% WARM, 5% header/markers.
function buildRepoMap(rankedEntities, baseDir, hotFilePaths, store) {
  const hotSet = new Set((hotFilePaths || []).map(p => path.normalize(p)));

  // Group entities by file, classify each file as HOT/WARM/COLD
  const fileGroups = new Map();
  for (const entity of rankedEntities) {
    if (entity.type === 'import') continue;
    const relPath = baseDir ? path.relative(baseDir, entity.file_path) : entity.file_path;
    if (!fileGroups.has(relPath)) {
      const isHot = hotSet.has(path.normalize(entity.file_path));
      fileGroups.set(relPath, { entities: [], isHot, totalRank: 0 });
    }
    const group = fileGroups.get(relPath);
    group.entities.push(entity);
    group.totalRank += entity.rank || 0;
  }

  // Sort: HOT first, then WARM by rank
  const orderedFiles = Array.from(fileGroups.entries()).sort(function(a, b) {
    if (a[1].isHot !== b[1].isHot) return a[1].isHot ? -1 : 1;
    return b[1].totalRank - a[1].totalRank;
  });

  const hotBudget = Math.floor(MAX_TOKENS * 0.60);
  const warmBudget = Math.floor(MAX_TOKENS * 0.35);

  const lines = ['## Relevant Codebase Context (HOT=touched, WARM=related)'];
  let hotTokens = estimateTokens(lines[0]);
  let warmTokens = 0;
  let hotFiles = 0, warmFiles = 0;

  for (const [filePath, group] of orderedFiles) {
    const imports = group.entities
      .filter(e => e.type === 'import')
      .map(e => e.name)
      .join(', ');

    const tier = group.isHot ? 'HOT' : 'WARM';
    const header = `\n// [${tier}] ${filePath}${imports ? ' (imports: ' + imports + ')' : ''}`;
    const headerTokens = estimateTokens(header);

    // Budget check per tier
    const currentBudget = group.isHot ? hotBudget : warmBudget;
    const currentSpent = group.isHot ? hotTokens : warmTokens;
    if (currentSpent + headerTokens > currentBudget) continue;

    lines.push(header);
    if (group.isHot) { hotTokens += headerTokens; hotFiles++; }
    else { warmTokens += headerTokens; warmFiles++; }

    // For HOT: emit ALL meaningful signatures
    // For WARM: emit only top-3 entities (signature only)
    const entitiesToEmit = group.isHot ? group.entities : group.entities.slice(0, 3);

    for (const entity of entitiesToEmit) {
      if (!entity.signature) continue;
      if (entity.type === 'export') continue;

      let sigLine;
      if (entity.type === 'class') {
        sigLine = entity.signature + ' { ... }';
      } else if (entity.type === 'function') {
        sigLine = '  ' + entity.signature;
      } else {
        sigLine = '  ' + entity.signature;
      }

      const sigTokens = estimateTokens(sigLine);
      const newSpent = (group.isHot ? hotTokens : warmTokens) + sigTokens;
      const limit = group.isHot ? hotBudget : warmBudget;
      if (newSpent > limit) break;

      lines.push(sigLine);
      if (group.isHot) hotTokens += sigTokens;
      else warmTokens += sigTokens;

      // Inlining: for HOT functions/classes, show top callers + callees
      if (group.isHot && store && entity.type === 'function' && entity.id) {
        try {
          const callers = store.getCallers(entity.id).slice(0, 3);
          const callees = store.getCallees(entity.id).slice(0, 3);
          if (callers.length) {
            const callerLine = '    // called by: ' + callers.map(c => c.source_name + '@' + path.basename(c.source_file || '')).join(', ');
            const t = estimateTokens(callerLine);
            if (hotTokens + t <= hotBudget) { lines.push(callerLine); hotTokens += t; }
          }
          if (callees.length) {
            const calleeLine = '    // calls: ' + callees.map(c => c.target_name + '@' + path.basename(c.target_file || '')).join(', ');
            const t = estimateTokens(calleeLine);
            if (hotTokens + t <= hotBudget) { lines.push(calleeLine); hotTokens += t; }
          }
        } catch (e) {}
      }
    }
  }

  return {
    map: lines.join('\n'),
    tokens: hotTokens + warmTokens,
    filesIncluded: hotFiles + warmFiles,
    hotFiles,
    warmFiles,
    entitiesIncluded: rankedEntities.filter(e => e.type !== 'import').length,
  };
}

module.exports = { buildRepoMap, estimateTokens };
