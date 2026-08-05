// SPDX-License-Identifier: Apache-2.0
// Heuristic output compressor for shell command results.
//
// Inspired by `squeez` (Rust) and `caveman` (prompt-level), but running
// inline on MCP tool output so the agent never sees the raw firehose.
// Two-tier strategy:
//
//   1. Command-aware: well-known verbose commands (git log, grep, diff,
//      find, ls -la, cat on big files) get tailored reducers that keep
//      the informative bits (commit headers, changed file list) and
//      drop the noise (blobs of hunk context, repeated patterns).
//
//   2. Generic cap: if no rule matches, fall back to a head/tail slice
//      with an explicit "[N lines trimmed]" marker so the agent knows
//      compression happened and can re-run with narrower filters.
//
// Returns { summary, originalBytes, compressedBytes, ratio }.
// summary is always a string; the raw content is archived upstream.

const MAX_BYTES_PASSTHROUGH = 4000;       // below this, return raw
const GENERIC_HEAD_LINES    = 80;
const GENERIC_TAIL_LINES    = 40;

function lines(s) { return s.split('\n'); }

function genericSqueeze(text) {
  const ls = lines(text);
  if (ls.length <= GENERIC_HEAD_LINES + GENERIC_TAIL_LINES + 10) return text;
  const head = ls.slice(0, GENERIC_HEAD_LINES).join('\n');
  const tail = ls.slice(-GENERIC_TAIL_LINES).join('\n');
  const trimmed = ls.length - GENERIC_HEAD_LINES - GENERIC_TAIL_LINES;
  return head + '\n[... ' + trimmed + ' lines trimmed by troth-bash ...]\n' + tail;
}

function squeezeGitLog(text) {
  // One-line log: keep as is up to 100 lines.
  const ls = lines(text);
  if (ls.length <= 100) return text;
  const head = ls.slice(0, 50).join('\n');
  const tail = ls.slice(-20).join('\n');
  return head + '\n[... ' + (ls.length - 70) + ' commits trimmed by troth-bash ...]\n' + tail;
}

function squeezeGitDiff(text) {
  // Heavy diff: keep the file-summary header and the first hunk of each
  // changed file, drop subsequent hunks with a count.
  const ls = lines(text);
  const out = [];
  let seenFileHunks = 0;
  let trimmedHunks = 0;
  let currentFile = null;
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (line.startsWith('diff --git')) {
      if (currentFile && seenFileHunks > 1) {
        out.push('[... ' + (seenFileHunks - 1) + ' additional hunks in ' + currentFile + ' trimmed ...]');
        trimmedHunks += seenFileHunks - 1;
      }
      currentFile = line.split(' ').pop();
      seenFileHunks = 0;
      out.push(line);
    } else if (line.startsWith('@@')) {
      seenFileHunks += 1;
      if (seenFileHunks === 1) out.push(line);
    } else {
      if (seenFileHunks <= 1) out.push(line);
    }
  }
  if (currentFile && seenFileHunks > 1) {
    out.push('[... ' + (seenFileHunks - 1) + ' additional hunks in ' + currentFile + ' trimmed ...]');
  }
  return out.join('\n');
}

function squeezeGrep(text) {
  // grep -r against a codebase easily yields 10K+ lines. Cap at 200 with a
  // "saw N matches in M files" summary footer.
  const ls = lines(text).filter(Boolean);
  if (ls.length <= 200) return text;
  const head = ls.slice(0, 180).join('\n');
  const filesSeen = new Set();
  for (const l of ls) {
    const m = /^([^:]+):/.exec(l);
    if (m) filesSeen.add(m[1]);
  }
  return head + '\n[... ' + (ls.length - 180) + ' additional matches across ' + filesSeen.size + ' files trimmed by troth-bash ...]';
}

function squeezeFind(text) {
  const ls = lines(text).filter(Boolean);
  if (ls.length <= 150) return text;
  const head = ls.slice(0, 120).join('\n');
  return head + '\n[... ' + (ls.length - 120) + ' additional paths trimmed by troth-bash ...]';
}

function pickRule(command) {
  if (!command) return null;
  const trimmed = command.trim();
  if (/\bgit\s+log\b/.test(trimmed)) return squeezeGitLog;
  if (/\bgit\s+diff\b/.test(trimmed)) return squeezeGitDiff;
  if (/\bgit\s+show\b/.test(trimmed)) return squeezeGitDiff;
  if (/\bgrep\b/.test(trimmed) || /\brg\b/.test(trimmed)) return squeezeGrep;
  if (/\bfind\b/.test(trimmed)) return squeezeFind;
  return null;
}

export function compressCommandOutput(command, output) {
  const raw = output || '';
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  if (originalBytes <= MAX_BYTES_PASSTHROUGH) {
    return { summary: raw, originalBytes, compressedBytes: originalBytes, ratio: 1 };
  }
  const rule = pickRule(command);
  const squeezed = rule ? rule(raw) : genericSqueeze(raw);
  const compressedBytes = Buffer.byteLength(squeezed, 'utf8');
  const ratio = compressedBytes / originalBytes;
  return { summary: squeezed, originalBytes, compressedBytes, ratio };
}
