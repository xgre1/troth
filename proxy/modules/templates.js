// SPDX-License-Identifier: AGPL-3.0-only
// Project templates — quick scaffolds for common project types.
//
// Used by `troth init <archetype>` to bootstrap. Doesn't replace
// create-next-app etc — just provides a sensible default if user wants
// it minimal.

const TEMPLATES = {
  'node-cli': {
    files: {
      'package.json': JSON.stringify({
        name: '%name%', version: '0.1.0', type: 'module',
        bin: { '%name%': './bin/%name%.js' },
        scripts: { test: 'node --test', start: 'node bin/%name%.js' },
      }, null, 2),
      'bin/%name%.js': '#!/usr/bin/env node\nconsole.log("Hello from %name%");\n',
      '.gitignore': 'node_modules\n*.log\n',
      'README.md': '# %name%\n\nA Node.js CLI tool.\n',
    },
  },
  'express-api': {
    files: {
      'package.json': JSON.stringify({
        name: '%name%', version: '0.1.0',
        scripts: { start: 'node server.js', test: 'node --test' },
        dependencies: { express: '^4.0.0' },
      }, null, 2),
      'server.js':
        "const express = require('express');\n" +
        "const app = express();\n" +
        "app.use(express.json());\n" +
        "app.get('/health', (req, res) => res.json({ status: 'ok' }));\n" +
        "const PORT = process.env.PORT || 3000;\n" +
        "if (require.main === module) app.listen(PORT, () => console.log('Listening on ' + PORT));\n" +
        "module.exports = app;\n",
      '.gitignore': 'node_modules\n*.log\n',
      'README.md': '# %name%\n\nAn Express REST API.\n',
    },
  },
  'python-pkg': {
    files: {
      'pyproject.toml':
        '[project]\nname = "%name%"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n',
      '%name%/__init__.py': '"""%name% package."""\n__version__ = "0.1.0"\n',
      'tests/test_smoke.py': 'def test_smoke(): assert True\n',
      '.gitignore': '__pycache__\n*.pyc\n.venv\n',
      'README.md': '# %name%\n\nA Python package.\n',
    },
  },
};

const fs = require('fs');
const path = require('path');

function generate(archetype, targetDir, projectName) {
  const tmpl = TEMPLATES[archetype];
  if (!tmpl) return { ok: false, error: 'unknown archetype: ' + archetype + '. Available: ' + Object.keys(TEMPLATES).join(', ') };
  if (!projectName || !/^[a-zA-Z][\w-]*$/.test(projectName)) return { ok: false, error: 'projectName must match /^[a-zA-Z][\\w-]*$/' };

  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const created = [];
    for (const [pathTpl, contentTpl] of Object.entries(tmpl.files)) {
      const filePath = path.join(targetDir, pathTpl.replace(/%name%/g, projectName));
      const content = contentTpl.replace(/%name%/g, projectName);
      const parent = path.dirname(filePath);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      if (fs.existsSync(filePath)) continue; // never overwrite
      fs.writeFileSync(filePath, content);
      created.push(filePath);
    }
    return { ok: true, created };
  } catch (e) { return { ok: false, error: e.message }; }
}

function listArchetypes() { return Object.keys(TEMPLATES); }

module.exports = { generate, listArchetypes, TEMPLATES };
