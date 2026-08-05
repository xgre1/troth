// SPDX-License-Identifier: AGPL-3.0-only
// Guardian — blocks dangerous Bash commands before they reach Claude Code.
//
// Previously also did "shadow verify" of Write tool content via subprocess.
// That was removed (April 16, 2026) because it mutated the assistant message
// (broken pattern called out in validator.js docstring) and the validator now
// handles Write syntax checking properly via tree-sitter pre-flight.

let stats = { blocked: 0 };

const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+[\/~]/,
  /rm\s+-rf?\s+\./,
  /DROP\s+(TABLE|DATABASE)/i,
  />\s*\/dev\/sd/,
  /mkfs\./,
  /dd\s+if=/,
  /:\(\)\s*\{[^}]*:\|:&[^}]*\};:/,
  /chmod\s+-R\s+777\s+\//,
  /curl[^|]*\|\s*sh/,
  /wget[^|]*\|\s*sh/,
  /eval\s+\$\(curl/,
];

function isDangerous(command) {
  if (!command) return false;
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

function guard(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    if (!data.content || !Array.isArray(data.content)) return { body: responseBody };

    for (let i = 0; i < data.content.length; i++) {
      const block = data.content[i];
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'Bash' && block.name !== 'bash') continue;

      const cmd = typeof block.input === 'object' ? (block.input.command || '') : String(block.input);
      if (isDangerous(cmd)) {
        stats.blocked++;
        data.content[i] = {
          type: 'text',
          text: `GUARDIAN BLOCKED: Dangerous command detected: "${cmd.slice(0, 80)}". Use a safer alternative.`
        };
        data.stop_reason = 'end_turn';
        return { body: JSON.stringify(data), blocked: true };
      }
    }

    return { body: responseBody };
  } catch (e) {
    return { body: responseBody };
  }
}

function getStats() { return stats; }

module.exports = { guard, isDangerous, getStats };
