import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { keptRecord, verifyHostFiles } from '../lib.mjs';
import { seal, unseal } from '../commands/backup.mjs';
import { RUNNING_ID, SECRETISH, SENTINEL, hostBytes, initialized, setup } from './helpers.mjs';

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
    assert.equal(await t.cli('restore'), 2, '--dry-run or --apply');
    assert.equal(await t.cli('restore', '--dry-run', '--apply', dir), 2);
    assert.equal(await t.cli('restore', '--apply'), 2, '--apply needs the backup directory');
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

describe('restore --apply', () => {
  // A deployment with a custom brand pack and a backup of it; the private key is moved off the server.
  async function backedUp() {
    const t = await initialized('crz');
    mkdirSync(join(t.root, 'brand', 'firm', 'fonts'), { recursive: true });
    writeFileSync(join(t.root, 'brand', 'firm', 'brand.json'), '{"assets":{}}\n');
    writeFileSync(join(t.root, 'brand', 'firm', 'fonts', 'a.woff2'), 'wOF2');
    t.state.handler = backupWrites;
    assert.equal(await t.cli('backup', 'init-key'), 0);
    assert.equal(await t.cli('backup'), 0, t.err.join('\n'));
    const [dir] = t.out;
    const away = mkdtempSync(join(tmpdir(), 'lawoss-key-away-'));
    after(() => rmSync(away, { recursive: true, force: true }));
    const key = join(away, 'backup-private.pem');
    renameSync(join(t.root, 'keys', 'backup-private.pem'), key);
    return { t, dir, key };
  }
  const read = path => readFileSync(path, 'utf8');

  it('the host part also holds brand/ and releases/ with the kept host files', async () => {
    const { dir, key } = await backedUp();
    const content = unseal(JSON.parse(read(join(dir, 'host.enc.json'))), readFileSync(key));
    const names = Object.keys(content.files);
    for (const name of ['.env', 'Caddyfile', 'hub-data.tar', 'host/brand/firm/brand.json', 'host/brand/firm/fonts/a.woff2',
      'host/releases/0.0.0.json', 'host/releases/0.0.0/compose.yaml', 'host/releases/0.0.0/bin/lib.mjs'])
      assert.ok(names.includes(name), name);
    assert.ok(names.every(name => !name.includes('/.')), 'no staging or hidden file');
  });

  it('restores a backup onto a fresh server: host files, brand, releases, .env, both volumes, then doctor', async () => {
    const { t: source, dir, key } = await backedUp();
    const t = setup();
    // The fresh server has only the CLI and whatever release files were installed; restore puts the backup's in place.
    writeFileSync(join(t.root, 'compose.yaml'), '# another release\n');
    let restoredEnv;
    t.state.handler = argv => {
      if (argv[1] === 'volume' && argv[2] === 'inspect') return { code: 1, stdout: '', stderr: '' };
      if (argv[1] === 'run' && argv.includes('sh') && String(argv.at(-1)).includes('hub-data')) {
        const archive = argv.find(arg => arg.endsWith(':/archive/hub-data.tar:ro')).split(':')[0];
        assert.equal(read(archive), `archive ${SENTINEL}\n`, 'the hub-data archive from the backup');
        assert.equal(statSync(archive).mode & 0o777, 0o600);
      }
      if (argv.includes('--check-introspection')) restoredEnv = read(join(t.root, '.env'));
      return undefined;
    };
    assert.equal(await t.cli('restore', '--apply', '--private-key', key, dir), 0, t.err.join('\n'));
    assert.deepEqual(readFileSync(join(t.root, '.env')), readFileSync(join(source.root, '.env')));
    assert.equal(statSync(join(t.root, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(join(t.root, 'Caddyfile')), readFileSync(join(source.root, 'Caddyfile')));
    assert.deepEqual(hostBytes(t.root), hostBytes(source.root));
    verifyHostFiles(t.root, keptRecord(t.root, '0.0.0'));
    verifyHostFiles(join(t.root, 'releases', '0.0.0'), keptRecord(t.root, '0.0.0'));
    assert.equal(read(join(t.root, 'brand', 'firm', 'fonts', 'a.woff2')), 'wOF2');
    assert.ok(restoredEnv, 'doctor ran after the restore');

    const image = `lawoss-auth@sha256:${'0'.repeat(64)}`;
    const authCheck = t.calls.find(argv => argv[1] === 'run' && argv.includes('/tmp/restore-check'));
    assert.ok(authCheck && authCheck.includes('node'), 'the auth part is checked first, in a throwaway container');
    const authRun = t.calls.find(argv => argv[1] === 'run' && argv.includes('sh') && argv.some(arg => arg.endsWith(':/keys/private.pem:ro')));
    assert.ok(authRun, 'auth\'s own restore runs in a one-off container');
    assert.ok(authRun.includes(image));
    assert.ok(authRun.includes(`${key}:/keys/private.pem:ro`) && authRun.includes(`${join(dir, 'auth.enc.json')}:/backup/auth.enc.json:ro`));
    assert.ok(authRun.includes('lawoss_auth-data:/data'));
    assert.deepEqual(authRun.slice(authRun.indexOf('--network'), authRun.indexOf('--network') + 2), ['--network', 'none']);
    assert.match(authRun.at(-1), /scripts\/backup\.mjs restore .*--destination \/tmp\/restore/);
    assert.match(authRun.at(-1), /rm -f \/data\/auth\.sqlite-wal \/data\/auth\.sqlite-shm/);
    const kinds = t.calls.map(argv => argv[1] === 'ps' || argv[1] === 'stop' ? argv[1] : argv[1] === 'volume' ? `volume ${argv[2]}`
      : argv === authCheck ? 'check' : argv === authRun ? 'auth' : argv[1] === 'run' && argv.includes('sh') ? 'hub-data'
        : argv.includes('up') ? 'up' : 'doctor');
    assert.deepEqual(kinds.slice(0, 10),
      ['check', 'ps', 'stop', 'volume inspect', 'volume create', 'auth', 'volume inspect', 'volume create', 'hub-data', 'up'], kinds.join(' '));
    assert.deepEqual(t.calls[2], ['docker', 'stop', RUNNING_ID]);
    assert.equal(t.out.at(-1), `PASS restore ${dir}`);
    assert.ok(t.out.slice(0, -1).every(line => line.startsWith("PASS ")), "doctor lines before it");
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
    assert.doesNotMatch([...t.out, ...t.err].join('\n'), SECRETISH);
    assert.deepEqual(readdirSync(join(t.root, 'backups')).filter(name => name.startsWith('.')), [], 'the clear archive is removed');
  });

  it('refuses an envelope that names a path outside brand/ and releases/, before anything changes', async () => {
    const { t, dir, key } = await backedUp();
    const content = unseal(JSON.parse(read(join(dir, 'host.enc.json'))), readFileSync(key));
    const evil = Buffer.from('owned\n');
    content.files['host/../compose.yaml'] = evil.toString('base64');
    content.manifest['host/../compose.yaml'] = (await import('node:crypto')).createHash('sha256').update(evil).digest('hex');
    // Anyone holding the public key can seal an envelope.
    writeFileSync(join(dir, 'host.enc.json'), JSON.stringify(seal(content, readFileSync(join(t.root, 'keys', 'backup-public.pem')))));
    const fresh = setup();
    assert.equal(await fresh.cli('restore', '--apply', '--private-key', key, dir), 1);
    assert.match(fresh.err.join('\n'), /outside/);
    assert.equal(fresh.calls.length, 0);
    assert.equal(existsSync(join(fresh.root, '.env')), false);
  });

  it('refuses a backup whose auth part does not pass auth\'s check, before stopping anything', async () => {
    const { dir, key } = await backedUp();
    const fresh = setup();
    writeFileSync(join(fresh.root, '.env'), 'EXISTING=1\n', { mode: 0o600 });
    const before = hostBytes(fresh.root);
    fresh.state.handler = argv => argv.includes('/tmp/restore-check') ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await fresh.cli('restore', '--apply', '--private-key', key, dir), 1);
    assert.match(fresh.err.join('\n'), /auth part .* did not pass/);
    assert.equal(fresh.calls.length, 1, 'only the check ran: no stop, no restore');
    assert.equal(read(join(fresh.root, '.env')), 'EXISTING=1\n');
    assert.deepEqual(hostBytes(fresh.root), before);
    assert.equal(existsSync(join(fresh.root, 'releases')), false);
  });

  it('refuses a backup whose kept host files do not match its release record', async () => {
    const { t, dir, key } = await backedUp();
    const content = unseal(JSON.parse(read(join(dir, 'host.enc.json'))), readFileSync(key));
    const changed = Buffer.from('# changed\n');
    content.files['host/releases/0.0.0/compose.yaml'] = changed.toString('base64');
    content.manifest['host/releases/0.0.0/compose.yaml'] = (await import('node:crypto')).createHash('sha256').update(changed).digest('hex');
    writeFileSync(join(dir, 'host.enc.json'), JSON.stringify(seal(content, readFileSync(join(t.root, 'keys', 'backup-public.pem')))));
    const fresh = setup();
    assert.equal(await fresh.cli('restore', '--apply', '--private-key', key, dir), 1);
    assert.match(fresh.err.join('\n'), /compose\.yaml/);
    assert.equal(fresh.calls.length, 0);
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
