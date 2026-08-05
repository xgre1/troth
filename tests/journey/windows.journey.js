// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Windows, as honestly as this machine allows.
//
// No Windows runs here and none can be emulated, so this does NOT claim the
// product works there. It checks the assumptions that break there, in the code
// a Windows user actually reaches on the way in: install, setup, the CLI, and
// wherever the product decides where its own files live. A static check that
// says what it is beats a green tick that means nothing.
//
// Source-tree only — the shipped bundle is minified and has no comments to
// exempt.
const fs = require('fs');
const path = require('path');

module.exports.describe = 'the way in does not assume a unix machine';

// The paths a newcomer traverses before anything else can matter.
const ENTRY = ['bin/troth.js', 'bin/cmd-init-2.js', 'shared-core/config-file.js',
               'shared-core/env-file.js', 'shared-core/dashboard-url.js',
               'scripts/preflight.js', 'scripts/postinstall-note.js'];

function lines(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8').split('\n'); }
  catch (_) { return null; }
}
const isProse = (l) => { const t = l.trim(); return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); };

module.exports.run = async (ctx, check) => {
  if (ctx.target !== 'local') { check('source tree available to inspect', true); return; }

  const found = { home: [], shell: [], sep: [] };
  for (const rel of ENTRY) {
    const ls = lines(ctx.root, rel);
    if (!ls) continue;
    ls.forEach((l, i) => {
      if (isProse(l)) return;
      const at = rel + ':' + (i + 1);
      // HOME is not set on Windows; os.homedir() is. Reading the env var with
      // no fallback puts every file the product owns in an undefined place.
      // Only when HOME is used to BUILD A PATH. Comparing it against another
      // process's environment (a ps-based check, unix-only by nature) is not a
      // portability defect, and flagging it made the check cry wolf on its
      // first run.
      if (/process\.env\.HOME\b/.test(l) && !/homedir|USERPROFILE/.test(l) &&
          /path\.join|\+\s*['"`]\/|\bresolve\(/.test(l)) found.home.push(at);
      // A shell that is not there.
      if (/\b(sh|bash|zsh)\s+-c\b/.test(l) || /\.sh['"]\s*\)/.test(l)) found.shell.push(at);
      // A path built by gluing strings with a forward slash.
      if (/['"`]\/[A-Za-z._-]+['"`]\s*\+|\+\s*['"`]\/[A-Za-z._-]+['"`]/.test(l) &&
          !/https?:|\/api\/|\/ui|^\s*\/\//.test(l)) found.sep.push(at);
    });
  }

  check('HOME is never read without a fallback on the way in', found.home.length === 0,
    found.home.slice(0, 4).join(' | '));
  check('nothing on the way in shells out to sh/bash', found.shell.length === 0,
    found.shell.slice(0, 4).join(' | '));
  check('filesystem paths are joined, not concatenated', found.sep.length === 0,
    found.sep.slice(0, 4).join(' | '));

  // The installer must refuse a Node it cannot work with rather than fail
  // halfway — the same on every platform.
  const pre = lines(ctx.root, 'scripts/preflight.js');
  check('install refuses an unsupported Node before doing anything',
    !!pre && pre.some((l) => /process\.exit\(1\)/.test(l)) && pre.some((l) => /version/i.test(l)),
    'preflight does not gate on the runtime version');

  // Say plainly what this did and did not do, in the run output, so a green
  // line here is never read as "Windows works".
  console.log('        (static check only — no Windows was executed)');
};
