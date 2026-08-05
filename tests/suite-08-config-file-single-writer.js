// SPDX-License-Identifier: AGPL-3.0-only
// Config single-writer discipline (shared-core/config-file.js),.
// Every ~/.troth/config.json writer routes through updateConfig(): strict
// fresh read (a corrupt file REFUSES the write instead of defaulting to {}),
// atomic temp+rename replace, dir 0700 / file 0600. These checks pin that
// contract, plus the wire-through of the two shared-core writers that used
// to carry their own lenient read-merge-write (transport-config, l4-config).
// Wire-through checks run in child processes because both modules resolve
// CONFIG_PATH from the environment at module load.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

console.log('Config single-writer:');

const configFile = require('../shared-core/config-file.js');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'troth-configfile-'));
}

// Point config-file at a throwaway dir for the duration of one check.
// config-file resolves the path per call, so env flips between checks are safe.
function inDir(fn) {
  const dir = freshDir();
  const prevDir = process.env.TROTH_CONFIG_DIR;
  const prevPath = process.env.TROTH_CONFIG_PATH;
  process.env.TROTH_CONFIG_DIR = dir;
  delete process.env.TROTH_CONFIG_PATH;
  try {
    return fn(dir, path.join(dir, 'config.json'));
  } finally {
    if (prevDir === undefined) delete process.env.TROTH_CONFIG_DIR;
    else process.env.TROTH_CONFIG_DIR = prevDir;
    if (prevPath === undefined) delete process.env.TROTH_CONFIG_PATH;
    else process.env.TROTH_CONFIG_PATH = prevPath;
  }
}

function runChild(code, dir, cfgPath) {
  execFileSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, {
      TROTH_CONFIG_DIR: dir,
      TROTH_CONFIG_PATH: cfgPath,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

test('config-file: first write creates dir 0700 + file 0600', () => {
  inDir((dir) => {
    const nested = path.join(dir, 'sub');
    process.env.TROTH_CONFIG_DIR = nested;
    configFile.patchConfig({ hello: 1 });
    const p = path.join(nested, 'config.json');
    assert(fs.existsSync(p));
    assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).hello, 1);
    assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(nested).mode & 0o777, 0o700);
  });
});

test('config-file: patch preserves every unrelated field', () => {
  inDir((dir, p) => {
    fs.writeFileSync(p, JSON.stringify({ a: 1, nested: { x: 1 }, keep: 'me' }));
    configFile.patchConfig({ b: 2 });
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(p, 'utf8')),
      { a: 1, nested: { x: 1 }, keep: 'me', b: 2 }
    );
  });
});

test('config-file: corrupt file REFUSES the write and stays byte-identical', () => {
  inDir((dir, p) => {
    fs.writeFileSync(p, '{ torn half-write');
    assert.throws(() => configFile.patchConfig({ b: 2 }), /config_corrupt_refusing_write/);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '{ torn half-write');
  });
});

test('config-file: non-object top level refuses the write', () => {
  inDir((dir, p) => {
    fs.writeFileSync(p, '[1,2,3]');
    assert.throws(() => configFile.patchConfig({ b: 2 }), /config_corrupt_refusing_write/);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '[1,2,3]');
  });
});

test('config-file: atomic replace leaves no temp residue', () => {
  inDir((dir, p) => {
    configFile.patchConfig({ a: 1 });
    configFile.patchConfig({ b: 2 });
    const residue = fs.readdirSync(path.dirname(p)).filter((n) => n.includes('.tmp-'));
    assert.deepStrictEqual(residue, []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1, b: 2 });
  });
});

test('config-file: in-place mutator (undefined return) persists', () => {
  inDir((dir, p) => {
    fs.writeFileSync(p, JSON.stringify({ n: 1 }));
    configFile.updateConfig((cfg) => { cfg.n = cfg.n + 1; });
    assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).n, 2);
  });
});

test('config-file: mutator producing a non-object refuses', () => {
  inDir(() => {
    assert.throws(() => configFile.updateConfig(() => 'nope'), /config_update_invalid/);
  });
});

const TRANSPORT = path.join(__dirname, '..', 'shared-core', 'transport-config.js');
const L4CONFIG = path.join(__dirname, '..', 'shared-core', 'l4-config.js');

test('transport-config.writePatch: corrupt config refused, file untouched (wire-through)', () => {
  const dir = freshDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{ torn');
  runChild(
    'const t = require(' + JSON.stringify(TRANSPORT) + ');' +
    'process.exit(t.writePatch({ llamacpp_host: "http://127.0.0.1:9999" }) === false ? 0 : 1);',
    dir, p
  );
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '{ torn');
});

test('transport-config.writePatch: healthy config keeps unrelated fields (wire-through)', () => {
  const dir = freshDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ other_field: true, providers: { x: { enabled: true } } }));
  runChild(
    'const t = require(' + JSON.stringify(TRANSPORT) + ');' +
    'process.exit(t.writePatch({ llamacpp_host: "http://127.0.0.1:9999" }) === true ? 0 : 1);',
    dir, p
  );
  const got = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(got.llamacpp_host, 'http://127.0.0.1:9999');
  assert.strictEqual(got.other_field, true);
  assert.strictEqual(got.providers.x.enabled, true);
});

test('l4-config.setL4Config: keeps unrelated fields (wire-through)', () => {
  if (!fs.existsSync(L4CONFIG)) skip('l4-config is a closed overlay; the wire-through is covered where that module lives');
  const dir = freshDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ fidelity_model: 'x', providers: { a: { enabled: true } } }));
  runChild(
    'const l4 = require(' + JSON.stringify(L4CONFIG) + ');' +
    'l4.setL4Config({ idle_tick_ms: 6000 });',
    dir, p
  );
  const got = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(got.l4.idle_tick_ms, 6000);
  assert.strictEqual(got.fidelity_model, 'x');
  assert.strictEqual(got.providers.a.enabled, true);
});

test('l4-config.setL4Config: corrupt config throws, file untouched (wire-through)', () => {
  if (!fs.existsSync(L4CONFIG)) skip('l4-config is a closed overlay; the wire-through is covered where that module lives');
  const dir = freshDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{ torn');
  runChild(
    'const l4 = require(' + JSON.stringify(L4CONFIG) + ');' +
    'try { l4.setL4Config({ idle_tick_ms: 6000 }); process.exit(1); }' +
    'catch (e) { process.exit(/config_corrupt_refusing_write/.test(e.message) ? 0 : 2); }',
    dir, p
  );
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '{ torn');
});
};
