// SPDX-License-Identifier: AGPL-3.0-only
// The write-only door for dotenv files.
//
// The read wall keeps dotenv contents away from the model on every road;
// these tests pin the one sanctioned way through: keys move by NAME, secrets
// come from the vault by NAME, no reply ever carries a value, and the roads
// around the door (substrate ground, collisions the model cannot see,
// half-applied batches, credential literals) are refused. Everything runs
// against a throwaway substrate directory and a throwaway vault.
module.exports = function run({ test, skip }) {
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const door     = require(path.join(__dirname, '..', 'shared-core', 'tools', 'env-door.js'));
const vault    = require(path.join(__dirname, '..', 'shared-core', 'vault.js'));
const redactor = require(path.join(__dirname, '..', 'shared-core', 'secret-redactor.js'));

console.log('\nEnv door (ED-1..13):');

const PASS = 'correct horse battery staple';

// A throwaway machine: substrate dir, a vault of its own, and projects made
// recognizable (a repository marker) so the ground classifier names their
// root deterministically.
function world(fn) {
  const savedTroth = process.env.TROTH_CONFIG_DIR;
  const root  = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ed-')));
  const troth = path.join(root, '.troth');
  fs.mkdirSync(path.join(troth, 'workspace', 'wsproj'), { recursive: true });
  process.env.TROTH_CONFIG_DIR = troth;
  const mkproj = (name) => {
    const p = path.join(root, name);
    fs.mkdirSync(path.join(p, '.git'), { recursive: true });
    return p;
  };
  try {
    vault.lock();
    vault.unlock(PASS, { vault_path: path.join(root, 'vault.bin'), scrypt_n: 16384 });
    return fn({ root, troth, mkproj });
  } finally {
    vault.lock();
    redactor._resetForTests();
    if (savedTroth === undefined) delete process.env.TROTH_CONFIG_DIR;
    else process.env.TROTH_CONFIG_DIR = savedTroth;
  }
}

const scopeFor = (proj) => 'capability:env:write:' + fs.realpathSync(proj);

test('ED-1: a literal lands on disk owner-only, and the reply carries names, not values', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p1');
    const file = path.join(proj, '.env');
    const r = door.envSet({ file, entries: [
      { key: 'PORT', value: '3000' },
      { key: 'GREETING', value: 'hello there # not a comment' }
    ] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(/^PORT=3000$/m.test(text), 'bare value must land bare: ' + text);
    assert.ok(text.indexOf('GREETING="hello there # not a comment"') !== -1,
      'a value carrying spaces and # must be quoted: ' + text);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'a dotenv file is owner-only');
    assert.deepStrictEqual(r.written, ['PORT', 'GREETING']);
  });
});

test('ED-2: a vault-named secret reaches the file but never the reply, and later surfacings leave masked', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p2');
    const secret = 'vlt+VALUE/abcdef123456==';
    assert.strictEqual(vault.writeEntry({
      key: 'stripe-key', value: secret, capability_scope_glob: scopeFor(proj)
    }).ok, true);
    const file = path.join(proj, '.env');
    const r = door.envSet({ file, entries: [{ key: 'STRIPE_KEY', from_vault: 'stripe-key' }] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(fs.readFileSync(file, 'utf8').indexOf(secret) !== -1, 'the secret must actually land');
    assert.strictEqual(JSON.stringify(r).indexOf(secret), -1, 'the reply must not carry the value');
    assert.deepStrictEqual(r.from_vault, ['STRIPE_KEY']);
    assert.ok(redactor.redact('oops: ' + secret).indexOf(secret) === -1,
      'a resolved value must be registered for masking');
  });
});

test('ED-3: a locked vault refuses cleanly and writes nothing', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p3');
    vault.lock();
    const file = path.join(proj, '.env');
    const r = door.envSet({ file, entries: [{ key: 'K', from_vault: 'anything' }] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'vault_locked');
    assert.ok(/unlock/.test(r.detail), 'the refusal must name the way through: ' + r.detail);
    assert.ok(!fs.existsSync(file), 'nothing may land on a refusal');
  });
});

test('ED-4: an entry scoped to another project refuses exactly like one that does not exist', () => {
  world(({ mkproj }) => {
    const projA = mkproj('pA');
    const projB = mkproj('pB');
    assert.strictEqual(vault.writeEntry({
      key: 'a-only', value: 'sekret-value-123456', capability_scope_glob: scopeFor(projA)
    }).ok, true);
    const file = path.join(projB, '.env');
    const misScoped = door.envSet({ file, entries: [{ key: 'K', from_vault: 'a-only' }] });
    const missing   = door.envSet({ file, entries: [{ key: 'K', from_vault: 'no-such' }] });
    assert.strictEqual(misScoped.ok, false);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(misScoped.error, missing.error, 'one refusal shape for both');
    assert.strictEqual(
      misScoped.detail.replace('a-only', 'X'), missing.detail.replace('no-such', 'X'),
      'the wording must not betray whether the entry exists');
    assert.ok(!fs.existsSync(file));
  });
});

test('ED-5: the merge rewrites only the named keys and keeps everything else byte for byte', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p5');
    const file = path.join(proj, '.env');
    fs.writeFileSync(file, '# db settings\nexport DB_HOST=old.example\n\nKEEP=untouched\nDB_HOST=dup.example\n');
    const r = door.envSet({ file, overwrite: true, entries: [
      { key: 'DB_HOST', value: 'new.example' },
      { key: 'ADDED', value: 'yes' }
    ] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(file, 'utf8'),
      '# db settings\nexport DB_HOST=new.example\n\nKEEP=untouched\nDB_HOST=new.example\nADDED=yes\n',
      'comments, blanks, order and the export prefix survive; every duplicate line agrees on the new value');
  });
});

test('ED-6: replacing a key the model cannot read takes an explicit overwrite', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p6');
    const file = path.join(proj, '.env');
    fs.writeFileSync(file, 'DB_URL=live-value\n');
    const before = fs.readFileSync(file, 'utf8');
    const r = door.envSet({ file, entries: [{ key: 'DB_URL', value: 'localhost' }] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'key_exists');
    assert.deepStrictEqual(r.exists, ['DB_URL'], 'the refusal names what collided');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'a refusal moves nothing');
    const r2 = door.envSet({ file, overwrite: true, entries: [{ key: 'DB_URL', value: 'localhost' }] });
    assert.strictEqual(r2.ok, true);
    assert.ok(/^DB_URL=localhost$/m.test(fs.readFileSync(file, 'utf8')));
  });
});

test('ED-7: a credential-shaped literal is refused toward the vault; plain configuration passes', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p7');
    const file = path.join(proj, '.env');
    const prefixed = door.envSet({ file, entries: [{ key: 'ANYTHING', value: 'sk-' + 'a'.repeat(24) }] });
    assert.strictEqual(prefixed.error, 'secret_literal', 'a known token shape is a secret under any name');
    const named = door.envSet({ file, entries: [{ key: 'DB_PASSWORD', value: 'hunter2hunter2' }] });
    assert.strictEqual(named.error, 'secret_literal', 'a credential-worded key marks its literal');
    assert.ok(/vault/.test(named.detail), 'the refusal names the sanctioned road');
    const placeholder = door.envSet({ file, entries: [{ key: 'DB_PASSWORD', value: 'changeme' }] });
    assert.strictEqual(placeholder.ok, true, 'placeholders stay allowed: ' + JSON.stringify(placeholder));
    const plain = door.envSet({ file, overwrite: true, entries: [{ key: 'PORT', value: '3000' }] });
    assert.strictEqual(plain.ok, true, JSON.stringify(plain));
  });
});

test('ED-8: the substrate directory is refused, a workspace project inside it is not', () => {
  world(({ troth }) => {
    const own = door.envSet({ file: path.join(troth, '.env'), entries: [{ key: 'K', value: 'v-1234567' }] });
    assert.strictEqual(own.error, 'substrate_ground', 'the substrate’s own dotenv is nobody’s target');
    assert.strictEqual(door.envKeys({ file: path.join(troth, '.env') }).error, 'substrate_ground');
    const wsRoot = door.envSet({ file: path.join(troth, 'workspace', '.env'), entries: [{ key: 'K', value: 'v-1234567' }] });
    assert.strictEqual(wsRoot.error, 'substrate_ground', 'the workspace root is not a project');
    // A case-flipped spelling names the same directory on the platform's
    // default volumes; on a case-sensitive volume it is a different path and
    // the fold only over-refuses. Either way it must not slip through.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const flipped = path.join(path.dirname(troth), path.basename(troth).toUpperCase(), '.env');
      assert.strictEqual(door.envSet({ file: flipped, entries: [{ key: 'K', value: 'v-1234567' }] }).error,
        'substrate_ground', 'a case-flipped spelling reached the substrate');
    }
    const wsProj = door.envSet({ file: path.join(troth, 'workspace', 'wsproj', '.env'),
      entries: [{ key: 'K', value: 'v-1234567' }] });
    assert.strictEqual(wsProj.ok, true, 'a partner project’s own dotenv is the door’s ordinary customer: ' + JSON.stringify(wsProj));
  });
});

test('ED-9: only dotenv names go through, and a key is an env-var name or nothing', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p9');
    assert.strictEqual(door.envSet({ file: path.join(proj, 'settings.json'),
      entries: [{ key: 'K', value: 'v' }] }).error, 'not_a_dotenv_file');
    const file = path.join(proj, '.env');
    for (const bad of ['A B', 'X=Y', 'EVIL\nINJECTED', '1LEADING', '']) {
      const r = door.envSet({ file, entries: [{ key: bad, value: 'v' }] });
      assert.strictEqual(r.error, 'bad_key', 'accepted a key that is not an env-var name: ' + JSON.stringify(bad));
    }
    assert.ok(!fs.existsSync(file));
  });
});

test('ED-10: env_keys reports names and vault coverage, never values', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p10');
    const file = path.join(proj, '.env');
    fs.writeFileSync(file, 'STRIPE_KEY=abc123secret\nPORT=3000\n');
    assert.strictEqual(vault.writeEntry({
      key: 'STRIPE_KEY', value: 'whatever-123456', capability_scope_glob: scopeFor(proj)
    }).ok, true);
    const r = door.envKeys({ file });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.keys, [
      { name: 'STRIPE_KEY', vault_usable: true },
      { name: 'PORT', vault_usable: false }
    ]);
    assert.strictEqual(JSON.stringify(r).indexOf('abc123secret'), -1, 'values never ride along');
    vault.lock();
    const locked = door.envKeys({ file });
    assert.strictEqual(locked.ok, true);
    assert.strictEqual(locked.vault, 'locked');
    assert.ok(locked.keys.every((k) => k.vault_usable === false));
  });
});

test('ED-11: a malformed batch is refused whole', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p11');
    const file = path.join(proj, '.env');
    assert.strictEqual(door.envSet({ file, entries: [] }).error, 'entries_required');
    assert.strictEqual(door.envSet({ file, entries: [
      { key: 'A', value: 'x' }, { key: 'A', value: 'y' }
    ] }).error, 'duplicate_key');
    assert.strictEqual(door.envSet({ file, entries: [
      { key: 'A', value: 'x', from_vault: 'both' }
    ] }).error, 'bad_entry');
    assert.strictEqual(door.envSet({ file, entries: [{ key: 'A' }] }).error, 'bad_entry');
    assert.ok(!fs.existsSync(file));
  });
});

test('ED-12: a link cannot carry the door somewhere the spelled path hides', () => {
  world(({ root, troth, mkproj }) => {
    const proj = mkproj('p12');
    // Innocent link: writing through it lands at the real target and works.
    const realDir = path.join(root, 'realcfg');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, path.join(proj, 'cfg'));
    const viaLink = door.envSet({ file: path.join(proj, 'cfg', '.env'),
      entries: [{ key: 'K', value: 'v-1234567' }] });
    assert.strictEqual(viaLink.ok, true, JSON.stringify(viaLink));
    assert.ok(fs.existsSync(path.join(realDir, '.env')), 'the write lands at the real target');
    // Hostile link: a project path that lands in the substrate is refused.
    fs.symlinkSync(troth, path.join(proj, 'sneaky'));
    const r = door.envSet({ file: path.join(proj, 'sneaky', '.env'),
      entries: [{ key: 'K', value: 'v-1234567' }] });
    assert.strictEqual(r.error, 'substrate_ground', 'the resolved target decides, not the spelling');
  });
});

test('ED-13: the batch is all-or-nothing — one unresolvable entry moves zero bytes', () => {
  world(({ mkproj }) => {
    const proj = mkproj('p13');
    const file = path.join(proj, '.env');
    const r = door.envSet({ file, entries: [
      { key: 'GOOD', value: 'fine-value' },
      { key: 'BAD', from_vault: 'ghost' }
    ] });
    assert.strictEqual(r.ok, false);
    assert.ok(!fs.existsSync(file), 'a half-applied batch is a state nobody can inspect');
  });
});
};
