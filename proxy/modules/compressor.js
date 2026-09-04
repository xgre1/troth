// SPDX-License-Identifier: AGPL-3.0-only
// Compressor — actual token reduction via tool_result deduplication.
//
// Two passes:
//   1. compressRequest(bodyStr) — operates on conversation history sent TO model
//      - Detects duplicate Read tool_results for unchanged files → elides old ones
//      - Drops empty Bash success outputs
//      - Truncates massive tool_results in turns older than KEEP_RECENT_TURNS
//   2. compressResponse(bodyStr) — strips boilerplate from response text
//      (legacy minor cleanup, kept for backward compat)
//
// The REAL win is compressRequest. Research [Proxy] paper shows tool_result
// dedup alone yields 30-50% token savings on agentic sessions.

const { getFileHash, hashString, recordElision } = require('./hotcache');

const KEEP_RECENT_TURNS = 6;          // last N user/assistant pairs kept verbatim
const ELIDE_THRESHOLD_CHARS = 500;    // tool_results smaller than this not worth eliding
const TRUNCATE_OLD_TO_CHARS = 200;    // very old tool_results compressed to summary

// Extract text from a tool_result content block (string or array form)
function toolResultText(block) {
  if (!block || block.type !== 'tool_result') return null;
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
  }
  return null;
}

function setToolResultText(block, newText) {
  if (typeof block.content === 'string') {
    block.content = newText;
  } else if (Array.isArray(block.content)) {
    block.content = [{ type: 'text', text: newText }];
  }
}

// Map tool_use_id → { toolName, input, msgIdx, blockIdx } for the tool_use block
function indexToolUses(messages) {
  const map = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (let j = 0; j < content.length; j++) {
      const b = content[j];
      if (b && b.type === 'tool_use' && b.id) {
        map.set(b.id, { toolName: b.name, input: b.input || {}, msgIdx: i, blockIdx: j });
      }
    }
  }
  return map;
}

// Main: compress conversation history before sending to backend
function compressRequest(bodyStr) {
  let stats = { elided: 0, truncated: 0, droppedEmptyBash: 0, savedBytes: 0,
                linguaBlocks: 0, linguaSavedBytes: 0 };
  // lingua extractive pass on the system prompt before the tool_result-dedup
  // pass below. lingua collapses filler phrases + verbose joiners in long
  // instruction blocks (>200 chars) without touching code fences.
  try {
    const lingua = require('./lingua');
    const r = lingua.compressLite(bodyStr, { aggressive: false });
    if (r && r.body && r.stats && r.stats.savedBytes > 0) {
      bodyStr = r.body;
      stats.linguaBlocks = r.stats.blocksCompressed | 0;
      stats.linguaSavedBytes = r.stats.savedBytes | 0;
    }
  } catch (e) {}
  try {
    const data = JSON.parse(bodyStr);
    if (!Array.isArray(data.messages) || data.messages.length < 4) {
      return { body: bodyStr, stats };
    }

    const beforeBytes = bodyStr.length;
    const toolUseIndex = indexToolUses(data.messages);
    // The boundary must not move every turn. A boundary at
    // (length - KEEP_RECENT_TURNS) directly advances by one on every
    // request: each turn ONE more block crosses it, that block's bytes
    // change, and every provider prompt-cache entry from that point onward
    // is re-billed — ~50K uncached tokens per turn on a near-window
    // session. Quantized to
    // steps of 20 MESSAGES (a turn adds ~3: user text, tool_use, tool_result,
    // so 20 ≈ six-seven turns), the boundary holds still between batches:
    // blocks truncate in groups, the prefix stays byte-stable in the gap, and
    // the up-to-20 messages carried untruncated meanwhile are cache READS,
    // which the caching lanes price at or near zero.
    const rawCutoff = Math.max(0, data.messages.length - KEEP_RECENT_TURNS);
    const cutoffIdx = Math.floor(rawCutoff / 20) * 20;

    // Track which (file_path, content_hash) pairs we've already seen for Read
    // tool_results. The FIRST occurrence stays full; later ones referring to
    // the same unchanged file get elided.
    const seenReads = new Map(); // filepath → { hash, firstTurnIdx }

    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      if (msg.role !== 'user') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];

      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (!block || block.type !== 'tool_result') continue;
        const tu = toolUseIndex.get(block.tool_use_id);
        if (!tu) continue;

        const text = toolResultText(block);
        if (!text || text.length < ELIDE_THRESHOLD_CHARS) continue;

        // Drop empty Bash success outputs (just a trailing newline or whitespace)
        if ((tu.toolName === 'Bash' || tu.toolName === 'bash') && /^\s*$/.test(text)) {
          setToolResultText(block, '[empty output]');
          stats.droppedEmptyBash++;
          continue;
        }

        // Read deduplication
        if (tu.toolName === 'Read' || tu.toolName === 'read') {
          const filepath = tu.input.file_path || tu.input.path;
          if (!filepath) continue;

          const currentHash = getFileHash(filepath);
          const seen = seenReads.get(filepath);

          if (seen && currentHash && seen.hash === currentHash && i < cutoffIdx) {
            // Same file, unchanged since first read, AND in older history → elide
            setToolResultText(block,
              `[unchanged since turn ${seen.firstTurnIdx} — content elided to save tokens. ${text.length} chars]`);
            stats.elided++;
            recordElision();
            continue;
          }

          // First occurrence (or file changed) → record and keep
          if (currentHash) {
            seenReads.set(filepath, { hash: currentHash, firstTurnIdx: i });
          } else {
            // No hash available — fall back to content hash to dedup identical reads
            const ch = hashString(text);
            const seenByContent = seenReads.get('__content:' + ch);
            if (seenByContent && i < cutoffIdx) {
              setToolResultText(block,
                `[duplicate of read at turn ${seenByContent.firstTurnIdx} — content elided. ${text.length} chars]`);
              stats.elided++;
              recordElision();
              continue;
            }
            seenReads.set('__content:' + ch, { hash: ch, firstTurnIdx: i });
          }
        }

        // Aggressive truncation for very old tool_results (any tool, not just Read)
        if (i < cutoffIdx && text.length > TRUNCATE_OLD_TO_CHARS * 4) {
          const head = text.slice(0, TRUNCATE_OLD_TO_CHARS);
          const tail = text.slice(-TRUNCATE_OLD_TO_CHARS);
          // That denominator grows by one every turn, so every truncated block in the
          // ENTIRE history was rewritten on every request — one changed byte early in
          // messages, and every provider prompt-cache entry from that point on missed.
          // Kimi bills exactly those misses (its coding endpoint charges input_tokens on
          // the uncached remainder only), so the counter meant to describe savings was
          // quietly buying full-price turns. The index alone is stable in an append-only
          // transcript.
          setToolResultText(block,
            `${head}\n[...${text.length - TRUNCATE_OLD_TO_CHARS * 2} chars elided — old turn ${i}...]\n${tail}`);
          stats.truncated++;
        }
      }
    }

    const newBody = JSON.stringify(data);
    stats.savedBytes = beforeBytes - newBody.length;
    return { body: newBody, stats };
  } catch (e) {
    return { body: bodyStr, stats };
  }
}

// Legacy response-side compression — strips a few boilerplate phrases.
// Kept for backward compat but the real win is compressRequest above.
function compressText(text) {
  if (!text || text.length < 500) return { text, compressed: false };
  let result = text;
  const before = result;
  const preambles = [
    /Here(?:'s| is) (?:what I|the|a) (?:did|summary|breakdown|overview)[^.]*\./gi,
    /Let me (?:explain|walk you through|break down)[^.]*\./gi,
    /I (?:will|'ll) now (?:create|write|build|implement|add)[^.]*\./gi,
    /Next,? I (?:will|'ll|need to)[^.]*\./gi,
    /Now (?:let's|I'll|I will|let me)[^.]*\./gi,
    /First,? (?:let's|I'll|I will|let me)[^.]*\./gi,
  ];
  for (const p of preambles) result = result.replace(p, '');
  result = result.replace(/\n{4,}/g, '\n\n\n');
  result = result.replace(/[ \t]+\n/g, '\n');
  return { text: result, compressed: result !== before };
}

function compressResponse(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    let totalCompressed = 0;
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          const { text, compressed } = compressText(block.text);
          block.text = text;
          if (compressed) totalCompressed++;
        }
      }
    }
    if (data.choices && Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (choice.message?.content) {
          const { text, compressed } = compressText(choice.message.content);
          choice.message.content = text;
          if (compressed) totalCompressed++;
        }
      }
    }
    return { body: JSON.stringify(data), compressed: totalCompressed };
  } catch (e) {
    return { body: bodyStr, compressed: 0 };
  }
}

module.exports = { compressRequest, compressResponse };
