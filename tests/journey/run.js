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
  // Chromium is installed and started here so the dashboard is looked at on
  // Linux too, not only on the machine that wrote the test. Best-effort: if the
  // image has no package for it, the browser scenario says so and the rest of
  // the run is unaffected.
  const script = [
    'set -e',
    'mkdir -p /app && cd /app && tar -xf /export.tar',
    'npm ci --no-audit --no-fund >/tmp/ci.log 2>&1 || { echo "npm ci FAILED"; tail -20 /tmp/ci.log; exit 1; }',
    '(apt-get update -qq && apt-get install -y -qq chromium >/dev/null 2>&1) || true',
    'if command -v chromium >/dev/null 2>&1; then ' +
      'chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage ' +
      '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 about:blank ' +
      '>/tmp/chromium.log 2>&1 & sleep 4; fi',
    // --no-unix-tools: hide ps, pgrep, lsof, open, killall. Windows cannot be
    // emulated here, but the specific thing it does to this product CAN be:
    // every unix process tool the CLI shells out to is simply absent. Each of
    // those calls sits in a try/catch, so this is the difference between
    // believing they degrade and watching them do it.
    ...(argv.includes('--no-unix-tools')
      ? ['for t in ps pgrep pkill lsof open killall; do ' +
         'p=$(command -v $t 2>/dev/null) && mv "$p" "$p.hidden" || true; done',
         'echo "[journey] unix process tools hidden: $(command -v ps || echo none)"']
      : []),
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
// path:<dir> — any core directory: the staged bundle before it is packaged, an
// installed /Applications copy, a colleague's checkout. Catches a regression
// while the build is still running instead of after it ships.
if (TARGET.startsWith('path:')) {
  ROOT = TARGET.slice('path:'.length);
  if (!fs.existsSync(path.join(ROOT, 'bin', 'troth-entity.js'))) {
    console.error('journey: no core at ' + ROOT); process.exit(2);
  }
}
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

// Leftovers from a killed run: anything listening in the journey port range
// (8700-8899 — allocated only by this harness) is an orphan. Reap before
// starting; one such orphan span a core for hours behind a dead runner.
(function sweepOrphanProxies(){
  try {
    const out = require('child_process').execSync(
      "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '$9 ~ /:87[0-8][0-9]$/ {print $2}' | sort -u",
      { encoding: 'utf8' });
    for (const pid of out.split('\n').map(function(x){return x.trim()}).filter(Boolean)) {
      if (parseInt(pid, 10) === process.pid) continue;
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); console.log('  reaped orphan journey proxy pid=' + pid); } catch (_) {}
    }
  } catch (_) { /* no lsof (windows) — the exit-with-parent guard covers it */ }
})();

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
