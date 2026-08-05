// SPDX-License-Identifier: AGPL-3.0-only
// Commit message generator — Conventional Commits format from git diff.
//
// Used by: troth run autonomous workers, manual `troth commit-msg`,
// MCP tool. Avoids LLM hallucination by structuring on actual diff.

const { execFileSync } = require('child_process');
const { gitOk } = require('../../shared-core/git-ok.js');

function getStagedDiff(dir) {
  // Popup-free CLT gate (see shared-core/git-ok.js).
  if (!gitOk()) return '';
  try {
    return execFileSync('git', ['-C', dir, 'diff', '--cached', '--stat'], { stdio: 'pipe', timeout: 3000 }).toString();
  } catch (e) { return null; }
}

function getStagedFiles(dir) {
  if (!gitOk()) return [];
  try {
    const out = execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-status'], { stdio: 'pipe', timeout: 3000 }).toString();
    return out.trim().split('\n').filter(Boolean).map(l => {
      const [status, ...rest] = l.split(/\s+/);
      return { status, file: rest.join(' ') };
    });
  } catch (e) { return []; }
}

function detectScope(files) {
  if (!files.length) return null;
  // Find common directory prefix among first 3 files (heuristic)
  const paths = files.slice(0, 3).map(f => f.file);
  const first = paths[0].split('/');
  let common = '';
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (paths.every(p => p.split('/')[i] === seg)) common = common ? common + '/' + seg : seg;
    else break;
  }
  // Just use top dir as scope (eg "proxy/modules" → "modules")
  if (!common) return null;
  const segs = common.split('/');
  return segs[segs.length - 1] || segs[segs.length - 2] || null;
}

function detectType(files) {
  // Conventional commits: feat, fix, docs, style, refactor, test, chore, perf, build, ci
  const filenames = files.map(f => f.file.toLowerCase());
  if (filenames.some(f => /\.test\.|\.spec\.|\/tests?\//.test(f))) return 'test';
  if (filenames.some(f => /readme|\.md$|docs?\//.test(f))) return 'docs';
  if (filenames.some(f => /package\.json|cargo\.toml|requirements\.txt|go\.mod|pom\.xml/.test(f))) return 'build';
  if (filenames.some(f => /\.github\/|\.gitlab-ci|\.circleci|jenkinsfile/.test(f))) return 'ci';
  if (filenames.every(f => /^docs?\//.test(f))) return 'docs';
  // Adds vs modifications heuristic
  const adds = files.filter(f => f.status === 'A').length;
  if (adds > files.length / 2) return 'feat';
  return 'fix';
}

function generate(dir) {
  const files = getStagedFiles(dir || '.');
  if (!files.length) return null;
  const type = detectType(files);
  const scope = detectScope(files);
  const subject = files.length === 1
    ? type + (scope ? '(' + scope + ')' : '') + ': update ' + files[0].file
    : type + (scope ? '(' + scope + ')' : '') + ': update ' + files.length + ' files';

  const body = files.slice(0, 8).map(f => '- ' + f.status + ' ' + f.file).join('\n');
  const more = files.length > 8 ? '\n- ...and ' + (files.length - 8) + ' more' : '';
  return subject + '\n\n' + body + more;
}

module.exports = { generate, getStagedFiles, detectType, detectScope };
