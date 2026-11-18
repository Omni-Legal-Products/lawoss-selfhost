import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SECRETISH, SENTINEL, initialized, setup } from './helpers.mjs';

// Answers the backup containers: the auth snapshot and the hub-data archive land in the mounted directory.
function backupWrites(argv) {
  if (argv[0] !== 'docker' || argv[1] !== 'run') return undefined;
  const out = argv.find(arg => arg.endsWith(':/backup'))?.split(':')[0];
  if (argv.includes('scripts/backup.mjs') && argv.includes('snapshot')) {
    writeFileSync(join(out, 'auth.enc.json'), '{"placeholder":"auth backup"}\n', { mode: 0o600 });
    return { code: 0, stdout: JSON.stringify({ output: '/backup/auth.enc.json', sha256: SENTINEL }), stderr: '' };
  }
  if (argv.includes('tar')) {
    writeFileSync(join(out, 'hub-data.tar'), `archive ${SENTINEL}\n`, { mode: 0o600 });
    return { code: 0, stdout: '', stderr: '' };
  }
  return undefined;
}

describe('backup', () => {
  it('backs up both volumes and the configuration read-only, encrypted, and prints only 0600 paths', async () => {
    const t = await initialized('crz');
    t.state.handler = backupWrites;
    assert.equal(await t.cli('backup', 'init-key'), 0, t.err.join('\n'));
    assert.equal(await t.cli('backup'), 0, t.err.join('\n'));
    const runs = t.calls.filter(argv => argv[1] === 'run');
    assert.equal(runs.length, 2);
    for (const argv of runs) {
      assert.ok(argv.includes('--read-only'));
      assert.deepEqual(argv.slice(argv.indexOf('--network'), argv.indexOf('--network') + 2), ['--network', 'none']);
      const volume = argv.find(arg => /^lawoss_(auth|hub)-data:/.test(arg));
      assert.match(volume, /:ro$/, 'volumes are mounted read-only');
      assert.ok(!argv.join(' ').includes('AUTH_CONFIG_JSON='), 'no secret in the argument vector');
    }
    assert.equal(t.out.length, 1, 'backup prints only the backup directory');
    const [dir] = t.out;
    for (const name of ['auth.enc.json', 'host.enc.json']) {
      const file = join(dir, name);
      assert.equal(statSync(file).mode & 0o777, 0o600, name);
      assert.ok(t.chowns.some(([path, uid]) => path === file && uid === 0));
    }
    assert.equal(existsSync(join(dir, 'hub-data.tar')), false, 'the clear archive is removed');
    assert.equal(existsSync(join(dir, 'auth-config.json')), false, 'the clear config is removed');
    const host = readFileSync(join(dir, 'host.enc.json'), 'utf8');
    assert.ok(!host.includes(SENTINEL) && !host.includes('HUB_CONFIG_JSON'), 'the host part is encrypted');
    const printed = [...t.out, ...t.err].join('\n');
    assert.ok(!printed.includes(SENTINEL));
    assert.doesNotMatch(printed, SECRETISH);
  });

  it('restore --dry-run decrypts and checks the latest backup without writing anything', async () => {
    const t = await initialized('crz');
    t.state.handler = backupWrites;
    assert.equal(await t.cli('backup', 'init-key'), 0);
    assert.equal(await t.cli('backup'), 0);
    const [dir] = t.out;
    t.state.handler = argv => argv.includes('restore') ? { code: 0, stdout: SENTINEL, stderr: '' } : undefined;
    assert.equal(await t.cli('restore', '--dry-run'), 0, t.err.join('\n'));
    assert.equal(t.calls.length, 1);
    const [argv] = t.calls;
    assert.ok(argv.includes('--read-only') && argv.includes(`${join(dir, 'auth.enc.json')}:/backup/auth.enc.json:ro`));
    assert.deepEqual(t.out, [`PASS backup ${dir}`]);
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
    assert.equal(await t.cli('restore'), 2, 'only --dry-run in version 1');
  });

  it('restore --dry-run fails on a tampered host part', async () => {
    const t = await initialized('crz');
    t.state.handler = backupWrites;
    assert.equal(await t.cli('backup', 'init-key'), 0);
    assert.equal(await t.cli('backup'), 0);
    const [dir] = t.out;
    const file = join(dir, 'host.enc.json');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    envelope.ciphertext = Buffer.from('tampered').toString('base64');
    writeFileSync(file, JSON.stringify(envelope));
    t.state.handler = undefined;
    assert.equal(await t.cli('restore', '--dry-run'), 1);
    assert.deepEqual(t.out, [`FAIL backup ${dir}`]);
  });
});

describe('backup key', () => {
  it('backup refuses without a key pair and never creates one itself', async () => {
    const t = await initialized('crz');
    t.state.handler = backupWrites;
    assert.equal(await t.cli('backup'), 1);
    assert.match(t.err.join('\n'), /backup init-key/);
    assert.equal(existsSync(join(t.root, 'keys', 'backup-private.pem')), false);
    assert.equal(existsSync(join(t.root, 'keys', 'backup-public.pem')), false);
    assert.equal(t.calls.length, 0);
  });

  it('backup init-key creates the pair once, prints only paths, and refuses to replace it', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('backup', 'init-key'), 0, t.err.join('\n'));
    const privateKey = join(t.root, 'keys', 'backup-private.pem');
    const publicKey = join(t.root, 'keys', 'backup-public.pem');
    assert.deepEqual(t.out, [privateKey, publicKey]);
    assert.match(t.err.join('\n'), /Copy the backup private key/);
    assert.equal(statSync(privateKey).mode & 0o777, 0o600);
    assert.equal(statSync(publicKey).mode & 0o777, 0o644);
    assert.equal(statSync(join(t.root, 'keys')).mode & 0o777, 0o700);
    assert.equal(createPrivateKey(readFileSync(privateKey)).asymmetricKeyDetails.modulusLength, 3072);
    const before = readFileSync(publicKey);
    assert.equal(await t.cli('backup', 'init-key'), 1);
    assert.match(t.err.join('\n'), /already exists/);
    assert.deepEqual(readFileSync(publicKey), before);
    assert.doesNotMatch([...t.out, ...t.err].join('\n'), SECRETISH);
  });

  it('after the private key is moved off the server, backups keep using the same public key', async () => {
    const t = await initialized('crz');
    t.state.handler = backupWrites;
    assert.equal(await t.cli('backup', 'init-key'), 0);
    const publicKey = join(t.root, 'keys', 'backup-public.pem');
    const before = readFileSync(publicKey);
    const away = mkdtempSync(join(tmpdir(), 'lawoss-key-away-'));
    after(() => rmSync(away, { recursive: true, force: true }));
    const moved = join(away, 'backup-private.pem');
    renameSync(join(t.root, 'keys', 'backup-private.pem'), moved);
    assert.equal(await t.cli('backup'), 0, t.err.join('\n'));
    const [dir] = t.out;
    assert.deepEqual(readFileSync(publicKey), before, 'the public key is not regenerated');
    assert.equal(existsSync(join(t.root, 'keys', 'backup-private.pem')), false, 'no new private key appears');
    // The host part is sealed to the moved key.
    t.state.handler = argv => argv.includes('restore') ? { code: 0, stdout: '', stderr: '' } : undefined;
    assert.equal(await t.cli('restore', '--dry-run', '--private-key', moved, dir), 0, t.err.join('\n'));
  });

  it('backup refuses a public key that is not RSA 3072 or larger', async () => {
    const t = await initialized('crz');
    const { generateKeyPairSync } = await import('node:crypto');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(t.root, 'keys'), { mode: 0o700 });
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(join(t.root, 'keys', 'backup-public.pem'), weak);
    t.state.handler = backupWrites;
    assert.equal(await t.cli('backup'), 1);
    assert.match(t.err.join('\n'), /RSA/);
    assert.equal(t.calls.length, 0);
  });
});

describe('command line', () => {
  it('exits 2 on usage errors and prints the usage without touching anything', async () => {
    const t = setup();
    assert.equal(await t.cli(), 2);
    assert.equal(await t.cli('frobnicate'), 2);
    assert.equal(await t.cli('update', '--to', '1.0.0'), 2);
    assert.equal(t.calls.length, 0);
  });

  it('commands that need .env fail clearly before init', async () => {
    const t = setup();
    assert.equal(await t.cli('doctor'), 1);
    assert.match(t.err.join('\n'), /run init first/);
  });
});
