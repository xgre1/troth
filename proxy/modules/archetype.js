// SPDX-License-Identifier: AGPL-3.0-only
// Project archetype detector — figure out what KIND of project this is.
//
// More granular than "node" / "python". We detect: Express API, Next.js app,
// React SPA, CLI tool, library, monorepo, etc. The archetype informs which
// routine + rules + conventions to inject.

const fs = require('fs');
const path = require('path');

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function detectArchetype(dir) {
  if (!dir) return { archetype: 'unknown', confidence: 0, signals: [] };
  const signals = [];
  let archetype = 'unknown';
  let confidence = 0;

  // Node.js project
  const pkg = safeJson(safeRead(path.join(dir, 'package.json')));
  if (pkg) {
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    // Next.js
    if (allDeps.next) { archetype = 'nextjs'; confidence = 0.95; signals.push('next in deps'); }
    // SvelteKit
    else if (allDeps['@sveltejs/kit']) { archetype = 'sveltekit'; confidence = 0.95; signals.push('@sveltejs/kit in deps'); }
    // Remix
    else if (allDeps['@remix-run/node'] || allDeps['@remix-run/react']) { archetype = 'remix'; confidence = 0.95; signals.push('@remix-run in deps'); }
    // Astro
    else if (allDeps.astro) { archetype = 'astro'; confidence = 0.95; signals.push('astro in deps'); }
    // Vite + React (SPA)
    else if (allDeps.vite && allDeps.react) { archetype = 'vite-react-spa'; confidence = 0.85; signals.push('vite + react'); }
    // Vite + Vue
    else if (allDeps.vite && allDeps.vue) { archetype = 'vite-vue-spa'; confidence = 0.85; signals.push('vite + vue'); }
    // Express API
    else if (allDeps.express || allDeps.fastify || allDeps.koa || allDeps['@hapi/hapi']) {
      archetype = 'node-api';
      confidence = 0.85;
      signals.push('express/fastify/koa in deps');
    }
    // NestJS
    else if (allDeps['@nestjs/core']) { archetype = 'nestjs'; confidence = 0.95; signals.push('@nestjs/core in deps'); }
    // CLI tool
    else if (pkg.bin) { archetype = 'node-cli'; confidence = 0.85; signals.push('package.json has bin'); }
    // Library (no bin, has main, no framework)
    else if (pkg.main && !pkg.bin) { archetype = 'node-library'; confidence = 0.7; signals.push('main but no bin'); }
    // React Native
    else if (allDeps['react-native']) { archetype = 'react-native'; confidence = 0.95; signals.push('react-native in deps'); }
    // Electron
    else if (allDeps.electron) { archetype = 'electron'; confidence = 0.95; signals.push('electron in deps'); }
    else { archetype = 'node-generic'; confidence = 0.5; }
  }

  // Python project
  if (archetype === 'unknown') {
    const pyproject = safeRead(path.join(dir, 'pyproject.toml'));
    const requirements = safeRead(path.join(dir, 'requirements.txt'));
    if (pyproject || requirements) {
      const allText = (pyproject || '') + (requirements || '');
      if (/django/i.test(allText)) { archetype = 'django'; confidence = 0.95; signals.push('django'); }
      else if (/fastapi/i.test(allText)) { archetype = 'fastapi'; confidence = 0.95; signals.push('fastapi'); }
      else if (/flask/i.test(allText)) { archetype = 'flask'; confidence = 0.9; signals.push('flask'); }
      else if (/streamlit/i.test(allText)) { archetype = 'streamlit'; confidence = 0.9; signals.push('streamlit'); }
      else if (/jupyter|notebook/i.test(allText)) { archetype = 'jupyter'; confidence = 0.85; signals.push('jupyter'); }
      else { archetype = 'python-generic'; confidence = 0.5; }
    }
  }

  // Rust
  if (archetype === 'unknown' && safeRead(path.join(dir, 'Cargo.toml'))) {
    const cargo = safeRead(path.join(dir, 'Cargo.toml'));
    if (/axum|actix|warp|rocket/i.test(cargo)) { archetype = 'rust-api'; confidence = 0.9; signals.push('rust web framework'); }
    else if (/\[\[bin\]\]/i.test(cargo)) { archetype = 'rust-cli'; confidence = 0.85; signals.push('rust [[bin]]'); }
    else { archetype = 'rust-generic'; confidence = 0.6; }
  }

  // Go
  if (archetype === 'unknown' && safeRead(path.join(dir, 'go.mod'))) {
    const goMod = safeRead(path.join(dir, 'go.mod'));
    if (/gin-gonic|fiber|echo/i.test(goMod)) { archetype = 'go-api'; confidence = 0.9; signals.push('go web framework'); }
    else if (fs.existsSync(path.join(dir, 'cmd'))) { archetype = 'go-cli'; confidence = 0.8; signals.push('cmd/ directory'); }
    else { archetype = 'go-generic'; confidence = 0.6; }
  }

  // Monorepo detection
  if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) ||
      fs.existsSync(path.join(dir, 'lerna.json')) ||
      (pkg && pkg.workspaces)) {
    archetype = 'monorepo-' + archetype;
    signals.push('monorepo workspace detected');
  }

  return { archetype, confidence, signals };
}

let cache = null;
function init(dir) {
  cache = detectArchetype(dir);
  if (cache.archetype !== 'unknown') {
    console.log('[archetype] Detected: ' + cache.archetype + ' (confidence ' + Math.round(cache.confidence * 100) + '%)');
  }
}

function get() { return cache; }

module.exports = { detectArchetype, init, get };
