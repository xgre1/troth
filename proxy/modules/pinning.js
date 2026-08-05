// SPDX-License-Identifier: AGPL-3.0-only
const path = require('path');
const fs = require('fs');

let config = null;
let stats = { blocked: 0, allowed: 0 };

// Load pinning config from .troth.json or env
function loadConfig() {
  // Try env var first
  if (process.env.GF_PIN_FILES) {
    try {
      config = JSON.parse(process.env.GF_PIN_FILES);
      return;
    } catch (e) {}
  }

  // Try .troth.json in cwd
  const configPath = path.join(process.cwd(), '.troth.json');
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw.writable) config = raw;
    } catch (e) {}
  }
}

// Simple glob matching (supports * and **)
function matchGlob(pattern, filepath) {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  return new RegExp('^' + regex + '$').test(filepath);
}

// Check if a file path is writable
function isWritable(filepath) {
  if (!config || !config.writable) return true; // No pinning = everything writable

  for (const pattern of config.writable) {
    if (matchGlob(pattern, filepath)) return true;
  }
  return false;
}

// Extract file path from tool_use blocks
function extractWritePath(toolUse) {
  if (!toolUse || !toolUse.input) return null;

  const input = typeof toolUse.input === 'string' ? toolUse.input : JSON.stringify(toolUse.input);

  // Claude Code tool names for file modification
  if (['Write', 'Edit', 'write', 'edit'].includes(toolUse.name)) {
    // Try to extract file_path from input
    try {
      const parsed = typeof toolUse.input === 'object' ? toolUse.input : JSON.parse(toolUse.input);
      return parsed.file_path || parsed.path || parsed.filename || null;
    } catch (e) {
      // Regex fallback
      const match = input.match(/file_path["\s:]+["']?([^"'\s,}]+)/);
      return match ? match[1] : null;
    }
  }

  return null;
}

// Check response for pinning violations
function checkPinning(responseBody) {
  if (!config) return { body: responseBody, blocked: false };

  try {
    const data = JSON.parse(responseBody);

    if (data.content && Array.isArray(data.content)) {
      for (let i = 0; i < data.content.length; i++) {
        const block = data.content[i];
        if (block.type !== 'tool_use') continue;

        const writePath = extractWritePath(block);
        if (!writePath) continue;

        if (!isWritable(writePath)) {
          stats.blocked++;

          // Replace tool_use with error message
          data.content[i] = {
            type: 'text',
            text: `PINNING GUARD: Cannot modify "${writePath}". This file is read-only. ` +
              `Writable files: ${config.writable.join(', ')}. ` +
              `Adjust your approach to only modify allowed files.`
          };
          data.stop_reason = 'end_turn';

          return { body: JSON.stringify(data), blocked: true, path: writePath };
        }
        stats.allowed++;
      }
    }
  } catch (e) {}

  return { body: responseBody, blocked: false };
}

function getStats() { return stats; }

// Initialize on load
loadConfig();

module.exports = { checkPinning, isWritable, loadConfig, getStats };
