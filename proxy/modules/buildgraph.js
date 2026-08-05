// SPDX-License-Identifier: AGPL-3.0-only
// RIG/SPADE — Build-system grounding.
//
// Research [Predict]: +12.2% accuracy, -53.9% completion time when agents
// have explicit build context. We parse the project's build files at startup
// and inject a structured summary into hydration.
//
// Detects: package.json (Node), Cargo.toml (Rust), pyproject.toml/requirements.txt
// (Python), go.mod (Go), pom.xml (Java/Maven), Gemfile (Ruby), composer.json (PHP).

const fs = require('fs');
const path = require('path');

let cache = null;
let projectDir = null;

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return null;
    if (fs.statSync(p).size > 200000) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (e) { return null; }
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function parseBuildSystems(dir) {
  const result = { systems: [], commands: {}, deps: {}, entryPoints: [] };

  // Node.js
  const pkgJson = safeJson(safeRead(path.join(dir, 'package.json')));
  if (pkgJson) {
    result.systems.push('node');
    result.commands.test = pkgJson.scripts?.test;
    result.commands.build = pkgJson.scripts?.build;
    result.commands.start = pkgJson.scripts?.start;
    result.commands.dev = pkgJson.scripts?.dev;
    result.deps.runtime = Object.keys(pkgJson.dependencies || {}).slice(0, 20);
    result.deps.dev = Object.keys(pkgJson.devDependencies || {}).slice(0, 15);
    if (pkgJson.main) result.entryPoints.push(pkgJson.main);
    if (pkgJson.bin) result.entryPoints.push(...Object.values(pkgJson.bin || {}).slice(0, 5));
    result.nodeType = pkgJson.type || 'commonjs';
  }

  // Rust
  const cargoToml = safeRead(path.join(dir, 'Cargo.toml'));
  if (cargoToml) {
    result.systems.push('rust');
    const depsMatch = cargoToml.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/);
    if (depsMatch) {
      const lines = depsMatch[1].split('\n').filter(l => /^\w+\s*=/.test(l)).map(l => l.split('=')[0].trim());
      result.deps.rust = lines.slice(0, 20);
    }
    result.commands.test = 'cargo test';
    result.commands.build = 'cargo build --release';
  }

  // Python
  const pyproject = safeRead(path.join(dir, 'pyproject.toml'));
  const requirements = safeRead(path.join(dir, 'requirements.txt'));
  if (pyproject || requirements) {
    result.systems.push('python');
    if (pyproject) {
      const depsMatch = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (depsMatch) {
        const deps = depsMatch[1].match(/"([^"]+)"/g) || [];
        result.deps.python = deps.map(d => d.replace(/[<>=!"~^].*/, '').replace(/"/g, '')).slice(0, 20);
      }
    }
    if (requirements && !result.deps.python) {
      result.deps.python = requirements.split('\n').map(l => l.trim().split(/[<>=!~^]/)[0]).filter(l => l && !l.startsWith('#')).slice(0, 20);
    }
    if (fs.existsSync(path.join(dir, 'pytest.ini')) || (pyproject && pyproject.includes('pytest'))) {
      result.commands.test = 'pytest';
    }
  }

  // Go
  const goMod = safeRead(path.join(dir, 'go.mod'));
  if (goMod) {
    result.systems.push('go');
    const requireMatch = goMod.match(/require\s*\(([\s\S]*?)\)/);
    if (requireMatch) {
      const deps = requireMatch[1].split('\n').map(l => l.trim().split(/\s+/)[0]).filter(l => l && !l.startsWith('//'));
      result.deps.go = deps.slice(0, 20);
    }
    result.commands.test = 'go test ./...';
    result.commands.build = 'go build ./...';
  }

  // Java/Maven
  const pomXml = safeRead(path.join(dir, 'pom.xml'));
  if (pomXml) {
    result.systems.push('maven');
    const deps = pomXml.match(/<artifactId>([^<]+)<\/artifactId>/g) || [];
    result.deps.maven = deps.map(d => d.replace(/<\/?artifactId>/g, '')).slice(0, 20);
    result.commands.test = 'mvn test';
    result.commands.build = 'mvn package';
  }

  // Ruby
  const gemfile = safeRead(path.join(dir, 'Gemfile'));
  if (gemfile) {
    result.systems.push('ruby');
    const gems = gemfile.match(/gem\s+['"]([^'"]+)['"]/g) || [];
    result.deps.ruby = gems.map(g => g.match(/['"]([^'"]+)['"]/)[1]).slice(0, 20);
    result.commands.test = 'bundle exec rspec';
  }

  // PHP
  const composer = safeJson(safeRead(path.join(dir, 'composer.json')));
  if (composer) {
    result.systems.push('php');
    result.deps.php = Object.keys(composer.require || {}).slice(0, 20);
    if (composer.scripts?.test) result.commands.test = 'composer test';
  }

  // Test files heuristic — if no test command but tests exist
  if (!result.commands.test) {
    const testDirs = ['tests', 'test', '__tests__', 'spec'];
    for (const td of testDirs) {
      if (fs.existsSync(path.join(dir, td))) {
        result.commands.test = '(test directory found at ' + td + ' but no test command configured)';
        break;
      }
    }
  }

  return result.systems.length ? result : null;
}

function init(dir) {
  projectDir = dir;
  cache = parseBuildSystems(dir);
  if (cache) console.log('[buildgraph] Detected: ' + cache.systems.join(', ') + ' (' + (cache.deps.runtime?.length || cache.deps.python?.length || cache.deps.rust?.length || cache.deps.go?.length || 0) + ' deps)');
}

function getContext() {
  if (!cache) return null;
  const parts = ['## Build System (from project files)'];
  parts.push('Systems: ' + cache.systems.join(', '));
  if (cache.commands.test) parts.push('Test command: `' + cache.commands.test + '`');
  if (cache.commands.build) parts.push('Build command: `' + cache.commands.build + '`');
  if (cache.commands.start) parts.push('Start command: `' + cache.commands.start + '`');
  if (cache.commands.dev) parts.push('Dev command: `' + cache.commands.dev + '`');
  if (cache.entryPoints?.length) parts.push('Entry points: ' + cache.entryPoints.join(', '));
  const allDeps = [].concat(cache.deps.runtime || [], cache.deps.python || [], cache.deps.rust || [], cache.deps.go || [], cache.deps.maven || [], cache.deps.ruby || [], cache.deps.php || []);
  if (allDeps.length) parts.push('Key dependencies: ' + allDeps.slice(0, 15).join(', '));
  parts.push('Use the verified test/build commands above instead of guessing.');
  return parts.join('\n');
}

function getStats() { return cache ? { systems: cache.systems, depCount: Object.values(cache.deps).reduce((a, b) => a + (b?.length || 0), 0) } : null; }

module.exports = { init, getContext, getStats, parseBuildSystems };
