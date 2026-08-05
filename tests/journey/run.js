// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Journey runner — `npm run journey [-- --target <t>] [filter]`
//
// The layer the 1353 unit tests cannot reach. Those run in-process, in this
// repo, on the machine that wrote them; every bug an operator has reported
// instead lived in the gap between surfaces — a menu built from one source
// while the thing that works reads another, an address hardcoded while the
// proxy moved, a setting that silently confiscated a switch. None of that is
// visible from inside the process. So a journey test drives the product the
// way a person does: spawn the daemon, speak the wire protocol, run the CLI,
// call the HTTP API, with a FRESH HOME each time so nothing inherits a
// machine that has been set up for months.
//
// Targets — the same scenarios, different environment:
//   local          this checkout, this OS                    (default)
//   dmg[:<path>]   the built/notarised app bundle's core     (what ships)
//   docker:<img>   the PUBLIC export inside Linux            (what a stranger clones)
//
// docker is not separate code: it builds a container from `git archive HEAD`,
// runs npm ci, and executes THIS runner inside with --target local. Whatever
// passes here is the same file that has to pass there.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
const TARGET = opt('target', 'local');
// The filter is the one bare word left once every --flag and ITS value are
// accounted for. Matching only against --target let `--platform linux/arm64`
// be read as a scenario name, and the run silently did nothing.
const FILTER = (() => {
  const consumed = new Set();
  argv.forEach((a, i) => { if (a.startsWith('--')) { consumed.add(i); consumed.add(i + 1); } });
  return argv.find((a, i) => !consumed.has(i)) || null;
})();

const REPO = path.join(__dirname, '..', '..');

// ── docker target: build the public export into Linux and re-enter ──────────
if (TARGET.startsWith('docker')) {
  const image = TARGET.split(':')[1] || 'node:22-bookworm';
  const platform = opt('platform', 'linux/arm64');
  const tar = path.join(require('os').tmpdir(), 'troth-journey-export.tar');
  console.log('[journey] exporting tracked files (what the public repo actually ships)');
  fs.writeFileSync(tar, execFileSync('git', ['-C', REPO, 'archive', 'HEAD'], { maxBuffer: 1 << 28 }));
  const script = [
    'set -e',
    'mkdir -p /app && cd /app && tar -xf /export.tar',
    'npm ci --no-audit --no-fund >/tmp/ci.log 2>&1 || { echo "npm ci FAILED"; tail -20 /tmp/ci.log; exit 1; }',
    'node tests/journey/run.js --target local ' + (FILTER || ''),
  ].join(' && ');
  const args = ['run', '--rm', '--platform', platform, '-v', tar + ':/export.tar:ro',
                '-e', 'TROTH_LLAMA_SERVER_BIN=/nonexistent-no-fetch',
                image, 'sh', '-c', script];
  console.log('[journey] ' + platform + ' · ' + image);
  try {
    execFileSync('docker', args, { stdio: 'inherit' });
    process.exit(0);
  } catch (e) { process.exit(e.status || 1); }
}

// ── local / dmg: resolve where the product's own files live ────────────────
let ROOT = REPO;
let detach = null;
if (TARGET.startsWith('dmg')) {
  const dmg = TARGET.split(':').slice(1).join(':');
  if (!dmg) { console.error('journey: --target dmg:<path-to-.dmg>'); process.exit(2); }
  const before = fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes') : [];
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-quiet', dmg]);
  const mounted = fs.readdirSync('/Volumes').filter((v) => !before.includes(v));
  const vol = '/Volumes/' + (mounted[0] || 'troth');
  ROOT = path.join(vol, 'troth.app', 'Contents', 'Resources', 'core');
  detach = () => { try { execFileSync('hdiutil', ['detach', vol, '-quiet']); } catch (_) {} };
  if (!fs.existsSync(path.join(ROOT, 'bin', 'troth-entity.js'))) {
    console.error('journey: no core in ' + ROOT); detach(); process.exit(2);
  }
}

const ctxLib = require('./lib/ctx.js');

(async () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.journey.js'))
    .filter((f) => !FILTER || f.indexOf(FILTER) !== -1).sort();
  if (!files.length) { console.log('journey: no *.journey.js' + (FILTER ? ' matching ' + FILTER : '')); process.exit(0); }

  console.log('\n=== journey · target=' + TARGET + ' · ' + process.platform + '/' + process.arch +
              ' · node ' + process.version + ' ===');
  const results = [];
  for (const f of files) {
    const name = f.replace('.journey.js', '');
    const mod = require(path.join(dir, f));
    const run = typeof mod === 'function' ? mod : mod.run;
    console.log('\n[' + name + '] ' + (mod.describe || ''));
    const ctx = ctxLib.make({ root: ROOT, target: TARGET });
    const checks = [];
    const check = (label, ok, detail) => {
      checks.push({ label, ok, detail });
      console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (ok || !detail ? '' : ' :: ' + detail));
    };
    try { await run(ctx, check); }
    catch (e) { check('scenario completed', false, String((e && e.stack || e)).split('\n').slice(0, 3).join(' | ')); }
    finally { await ctx.cleanup(); }
    results.push({ name, checks });
  }

  const all = results.flatMap((r) => r.checks);
  const failed = all.filter((c) => !c.ok);
  console.log('\n=== ' + (all.length - failed.length) + ' passed, ' + failed.length + ' failed (target=' + TARGET + ') ===');
  if (failed.length) {
    console.log('failing:');
    for (const c of failed) console.log('  ✗ ' + c.label + (c.detail ? ' :: ' + c.detail : ''));
  }
  if (detach) detach();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('journey runner: ' + (e && e.stack || e)); if (detach) detach(); process.exit(1); });
