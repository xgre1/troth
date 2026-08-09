// SPDX-License-Identifier: AGPL-3.0-only
// Where the jail decision is made for the agent's own shell.
//
// troth-bash is the tool agents actually drive in the open repo, and until
// now it spawned bare bash regardless of ground. The rule under test is a
// directory convention, deliberately not a command classifier: cwd under
// ~/.troth/workspace/ = partner project ground = jailed to the project's
// first path segment; anywhere else = the operator's own shell, untouched.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawnSync } = require('child_process');

console.log('\nWorkspace jail routing (WSJAIL-1..9):');

const modPath = path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'workspace-jail.mjs');
const modHref = url.pathToFileURL(modPath).href;

test('WSJAIL-1: ground is classified three ways, and the jail is the project', async () => {
  const wj = await import(modHref);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-'));
  const deep = path.join(root, 'app', 'src', 'lib');
  fs.mkdirSync(deep, { recursive: true });
  // A deep cwd scopes to its PROJECT, never to the subdirectory: a build
  // script cannot narrow its own walls and then reach back out.
  assert.strictEqual(wj.classify(deep, root).ground, 'project');
  assert.strictEqual(wj.classify(deep, root).project, path.join(root, 'app'));
  // The root is scaffolding ground, named distinctly BECAUSE a command run
  // there can see every sibling — the caller says so out loud.
  assert.strictEqual(wj.classify(root, root).ground, 'workspace');
  assert.strictEqual(wj.classify(os.homedir(), root).ground, 'operator');
  // Boundary, not prefix: /ws-abc must not capture /ws-abc-evil.
  const evil = root + '-evil';
  fs.mkdirSync(evil, { recursive: true });
  assert.strictEqual(wj.classify(evil, root).ground, 'operator', 'prefix sibling is not workspace ground');
});

test('WSJAIL-4: a path that claims the workspace but resolves outside is REFUSED, never run bare', async () => {
  // The fail-open an adversarial pass found: jailed code can plant a symlink
  // in its own project, and a cwd that resolved out of the workspace was
  // being treated as the operator's own ground — i.e. no sandbox at all.
  const wj = await import(modHref);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wsesc-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outside-'));
  fs.symlinkSync(outside, path.join(root, 'sneaky'));
  const c = wj.classify(path.join(root, 'sneaky'), root);
  assert.strictEqual(c.ground, 'escape', 'symlink out of the workspace must be an escape, got: ' + c.ground);
  const j = wj.jailFor(path.join(root, 'sneaky'), root);
  assert.ok(j && j.refuse, 'jailFor must refuse, not return null (null means run bare)');
  // A workspace path that does not exist at all is refused for the same
  // reason rather than silently falling through to the operator's shell.
  assert.strictEqual(wj.classify(path.join(root, 'nope', 'deeper'), root).ground, 'escape');
});

test('WSJAIL-5: a jailed command cannot leave a process behind', async () => {
  // Seatbelt scopes signals to one sandbox-exec invocation, so a background
  // server started in a jail is unreachable from any later call. The command
  // owns its process group and the group is retired with it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'mcp-servers', 'troth-bash', 'server.mjs'), 'utf8');
  assert.ok(/detached: true/.test(src), 'the command runs as its own process group leader');
  assert.ok(/process\.kill\(-proc\.pid/.test(src), 'kills the group, not just the leader');
  assert.ok(/proc\.on\('exit'[\s\S]{0,200}endTree\('SIGKILL'\)/.test(src), 'sweeps the group when the leader exits');
});

const sb = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js'));
const avail = sb.isAvailable();
if (!avail.available) {
  // See suite-25: a top-level skip() throws past the harness and kills the run.
  test('WSJAIL-2: live cross-project wall (darwin-only)',
       () => skip('sandbox-exec unavailable: ' + (avail.error || '?')));
} else {
  test('WSJAIL-2: project A works inside its walls and cannot read project B', async () => {
    const wj = await import(modHref);
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-live-'));
    const aSrc = path.join(root, 'a', 'src');
    const bDir = path.join(root, 'b');
    fs.mkdirSync(aSrc, { recursive: true });
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'secret.txt'), 'project-b-only');

    const jail = wj.jailFor(aSrc, root);
    assert.ok(jail, 'workspace cwd got a jail');
    assert.strictEqual(jail.project, path.join(root, 'a'), 'jailed to the project root');

    // Work inside the project succeeds — from a SUBDIR, proving the jail is
    // the project, not the cwd.
    let r = spawnSync(jail.exec, jail.args.concat(['/bin/bash', '-lc', 'echo made > out.txt && cat out.txt']),
                      { cwd: aSrc, env: jail.env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, 'write+read inside the project works: ' + (r.stderr || ''));
    assert.ok(fs.existsSync(path.join(aSrc, 'out.txt')), 'file landed in the subdir');

    // A sibling project's file is another world.
    r = spawnSync(jail.exec, jail.args.concat(['/bin/bash', '-lc', 'cat ' + JSON.stringify(path.join(bDir, 'secret.txt'))]),
                  { cwd: aSrc, env: jail.env, encoding: 'utf8', timeout: 30000 });
    assert.notStrictEqual(r.status, 0, 'cross-project read must refuse');
    assert.ok((r.stdout || '').indexOf('project-b-only') === -1, 'nothing leaked');
  });
}

test('WSJAIL-3: a host with no jail runtime degrades to bare instead of refusing', () => {
  // Pinned by faking the platform in a child, same technique as SANDBOX-9.
  // On Linux the command must still RUN — the convention organizes the
  // ground and the selector picks up the day a runtime exists — so the one
  // thing that must never happen is a refusal. It reports itself as
  // unavailable rather than returning bare silently; WSJAIL-8 pins that
  // half, this one pins that the work is not blocked.
  const probe = [
    'Object.defineProperty(process, "platform", { value: "linux" });',
    'const fs = require("fs"), os = require("os"), path = require("path");',
    'const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "wsl-"));',
    'const proj = path.join(root, "app"); fs.mkdirSync(proj, { recursive: true });',
    'import(process.argv[1]).then(wj => {',
    '  console.log(JSON.stringify({ jail: wj.jailFor(proj, root) }));',
    '});'
  ].join('');
  const r = spawnSync(process.execPath, ['-e', probe, modHref], { encoding: 'utf8', timeout: 15000 });
  const out = JSON.parse(String(r.stdout).trim());
  assert.ok(!out.jail || !out.jail.refuse, 'no runtime → bare, never a refusal');
  assert.ok(!out.jail || !out.jail.exec, 'nothing to wrap with when there is no runtime');
});

test('WSJAIL-6: the operator switch turns the jail off, and says so on every command', () => {
  // l4.sandbox.runtime=bare is a real grant, and it is safe to offer only
  // because config.json is itself a protected destination — the switch that
  // opens the walls sits behind them. Run in a child on a throwaway HOME so
  // the operator's own config is never read or written.
  const probe = [
    'const fs = require("fs"), os = require("os"), path = require("path");',
    'const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "wsopt-")));',
    'process.env.HOME = home;',
    'const proj = path.join(home, ".troth", "workspace", "demo");',
    'fs.mkdirSync(proj, { recursive: true });',
    'fs.writeFileSync(path.join(home, ".troth", "config.json"),',
    '  JSON.stringify({ l4: { sandbox: { runtime: "bare" } } }));',
    'import(process.argv[1]).then(wj => {',
    '  const off = wj.jailFor(proj);',
    '  const lie = path.join(home, ".troth", "workspace", "lying");',
    '  fs.mkdirSync(path.join(home, "elsewhere"), { recursive: true });',
    '  fs.symlinkSync(path.join(home, "elsewhere"), lie);',
    '  console.log(JSON.stringify({ off, esc: wj.jailFor(lie) }));',
    '});'
  ].join('');
  const r = spawnSync(process.execPath, ['-e', probe, modHref], { encoding: 'utf8', timeout: 20000 });
  const out = JSON.parse(String(r.stdout).trim());
  assert.strictEqual(out.off && out.off.off, 'operator', 'switch not honored: ' + JSON.stringify(out.off));
  assert.ok(!out.off.exec, 'an off jail must carry no argv to wrap with');
  assert.ok(out.off.project, 'the project is still named so the note can report it');
  // Turning the jail off does not license a path that lies about where it
  // lands: "the jail is off" and "this cwd is not where it claims" are
  // different facts, and the second one still gets said.
  assert.ok(out.esc && out.esc.refuse, 'a lying path ran anyway once the jail was off');
});

test('WSJAIL-7: one setting governs every jailed surface', () => {
  // The workspace jail reads the same key as the sandbox selector rather
  // than growing its own, so an operator who turns sandboxing off does not
  // have to discover a second switch.
  const runtime = require(path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-runtime.js'));
  assert.strictEqual(typeof runtime._readOperatorOverride, 'function',
    'workspace-jail depends on this export; removing it silently disables the switch');
  assert.ok(runtime.ADAPTER_PRIORITY.indexOf('bare') !== -1,
    "'bare' must stay a valid runtime value for the opt-out to mean anything");
});

test('WSJAIL-8: a host with no jail SAYS so instead of running workspace ground in silence', () => {
  // "bare" had been one value carrying two meanings: the operator's own
  // ground, and a host that has no jail to give. They printed the same
  // nothing, so on Linux the containment directory ran unsandboxed with no
  // sign. Degrading is fine; degrading quietly is the failure.
  const probe = [
    'const fs = require("fs"), os = require("os"), path = require("path");',
    'const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "wsna-")));',
    'process.env.HOME = home;',
    'const proj = path.join(home, ".troth", "workspace", "demo");',
    'fs.mkdirSync(proj, { recursive: true });',
    'const sb = require(process.argv[2]);',
    'sb.jailSpawnSpec = () => ({ ok: false, error: "no runtime on this host" });',
    'import(process.argv[1]).then(wj => {',
    '  console.log(JSON.stringify({ ws: wj.jailFor(proj), op: wj.jailFor(home) }));',
    '});'
  ].join('');
  const sbPath = path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-seatbelt.js');
  const r = spawnSync(process.execPath, ['-e', probe, modHref, sbPath], { encoding: 'utf8', timeout: 20000 });
  const out = JSON.parse(String(r.stdout).trim());
  assert.strictEqual(out.ws && out.ws.off, 'unavailable',
    'workspace ground with no runtime must report itself, got: ' + JSON.stringify(out.ws));
  assert.ok(out.ws.why, 'the reason is what makes the note useful');
  assert.ok(out.ws.project, 'the project is still named so the note can report it');
  assert.ok(!out.ws.exec, 'an unavailable jail must carry no argv to wrap with');
  // The operator's own ground is NOT a degraded jail and must stay silent,
  // or every command outside the workspace grows a warning that means nothing.
  assert.strictEqual(out.op, null, 'operator ground must remain plain bare');
});

test('WSJAIL-9: the operator switch works in the SHIPPED tree, not only with the closed overlay', () => {
  // The switch read l4.sandbox.runtime through shared-core/l4-config.js,
  // which belongs to the closed overlay and is absent from the tree that
  // ships. There the require throws, the catch swallows it, and the setting
  // silently does nothing — while reading as working on a machine that has
  // the overlay. Running the suite on Linux from a git-only checkout is what
  // exposed it. Pinned by hiding the overlay module from the resolver.
  const probe = [
    'const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");',
    'const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "wsship-")));',
    'process.env.HOME = home;',
    'fs.mkdirSync(path.join(home, ".troth"), { recursive: true });',
    'fs.writeFileSync(path.join(home, ".troth", "config.json"),',
    '  JSON.stringify({ l4: { sandbox: { runtime: "bare" } } }));',
    // Make the closed module unresolvable, exactly as it is in the shipped tree.
    'const realResolve = Module._resolveFilename;',
    'Module._resolveFilename = function (req, ...rest) {',
    '  if (String(req).indexOf("l4-config") !== -1) { const e = new Error("MODULE_NOT_FOUND"); e.code = "MODULE_NOT_FOUND"; throw e; }',
    '  return realResolve.call(this, req, ...rest);',
    '};',
    'const rt = require(process.argv[1]);',
    'console.log(JSON.stringify({ override: rt._readOperatorOverride() }));'
  ].join('');
  const rtPath = path.join(__dirname, '..', 'shared-core', 'tools', 'sandbox-runtime.js');
  const r = spawnSync(process.execPath, ['-e', probe, rtPath], { encoding: 'utf8', timeout: 20000 });
  const out = JSON.parse(String(r.stdout).trim());
  assert.strictEqual(out.override, 'bare',
    'the switch is invisible without the closed overlay, got: ' + JSON.stringify(out.override));
});
};
