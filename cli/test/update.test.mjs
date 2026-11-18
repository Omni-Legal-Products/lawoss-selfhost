import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { keptRecord, readEnvFile, validateRecord, verifyHostFiles } from '../lib.mjs';
import {
  RECORD, RUNNING_ID, SECRETISH, composeBase, healthyProbes, hostBytes, initialized, installNextRelease, sha256, writeRecord,
} from './helpers.mjs';

const digest = hex => hex.repeat(64);
// A second release for the host files installed under root; its image digests are obvious placeholders.
function nextRecord(root, mutate = record => record) {
  const base = writeRecord(root, {
    version: '0.0.1',
    commit: '1'.repeat(40),
    images: {
      auth: `lawoss-auth@sha256:${digest('1')}`,
      hub: `lawoss-hub@sha256:${digest('1')}`,
      proxy: `caddy@sha256:${digest('1')}`,
    },
  });
  const record = mutate(base.record);
  writeFileSync(base.path, `${JSON.stringify(record, null, 2)}\n`);
  return { path: base.path, sha: sha256(readFileSync(base.path)) };
}

const isSnapshot = argv => argv[0] === 'docker' && argv[1] === 'run' && argv.includes('tar');
const isUp = argv => argv.includes('up');
// One label per runner call, for the order assertions.
const kindOf = argv => isSnapshot(argv) ? 'snapshot' : isUp(argv) ? 'up'
  : argv[1] === 'ps' ? 'ps' : argv[1] === 'stop' ? 'stop' : argv[1] === 'start' ? 'start'
  : argv.includes('--list-tools') ? 'tools' : argv.includes('--check-introspection') ? 'introspection'
    : argv.includes('--manifest-sha256') ? 'manifest' : 'other';

describe('release records', () => {
  it('the example release record matches the schema', () => {
    const record = JSON.parse(readFileSync(RECORD, 'utf8'));
    assert.deepEqual(validateRecord(record, '0.0.0'), record);
    assert.throws(() => validateRecord(record, '0.0.1'), /version/);
    assert.throws(() => validateRecord({ ...record, images: { ...record.images, hub: 'lawoss-hub:latest' } }, '0.0.0'), /digest/);
    assert.throws(() => validateRecord({ ...record, commit: 'main' }, '0.0.0'), /commit/);
    assert.throws(() => validateRecord({ ...record, extra: 1 }, '0.0.0'), /unknown field/);
    assert.deepEqual(Object.keys(record.files).sort(),
      ['Caddyfile.template', 'bin/lawoss-selfhost.mjs', 'bin/lib.mjs', 'compose.yaml', 'services.json']);
    const { files } = record;
    assert.throws(() => validateRecord({ ...record, files: undefined }, '0.0.0'), /files/);
    const without = { ...files };
    delete without['services.json'];
    assert.throws(() => validateRecord({ ...record, files: without }, '0.0.0'), /services\.json/);
    assert.throws(() => validateRecord({ ...record, files: { ...files, '../etc/passwd': '0'.repeat(64) } }, '0.0.0'), /host file/);
    assert.throws(() => validateRecord({ ...record, files: { ...files, 'compose.yaml': 'abc' } }, '0.0.0'), /sha256/);
  });
});

describe('update and rollback', () => {
  it('update refuses a release whose digest is not in the signed release record', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    const { path, sha } = nextRecord(t.root);
    // The record on disk no longer matches the digest the catalog pins.
    writeFileSync(path, readFileSync(path, 'utf8').replace(digest('1'), digest('2')));
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 1);
    assert.match(t.err.join('\n'), /does not match/);
    // A record that pins an image by tag instead of digest.
    const tagged = nextRecord(t.root, record => ({ ...record, images: { ...record.images, hub: 'lawoss-hub:0.0.1' } }));
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', tagged.path, '--record-sha256', tagged.sha), 1);
    // A record for another version than the one requested.
    const good = nextRecord(t.root);
    assert.equal(await t.cli('update', '--to', '0.0.2', '--record', good.path, '--record-sha256', good.sha), 1);
    assert.equal(t.calls.length, 0, 'nothing ran');
    assert.deepEqual(readFileSync(join(t.root, '.env')), env, '.env unchanged');
  });

  it('update snapshots, switches digests, starts and checks', async () => {
    const t = await initialized('crz');
    const { path, sha } = nextRecord(t.root);
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 0, t.err.join('\n'));
    const vars = readEnvFile(join(t.root, '.env'));
    assert.equal(vars.LAWOSS_AUTH_IMAGE, `lawoss-auth@sha256:${digest('1')}`);
    assert.equal(vars.LAWOSS_RELEASE, '0.0.1');
    assert.equal(statSync(join(t.root, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(t.calls.map(kindOf), ['ps', 'stop', 'snapshot', 'snapshot', 'snapshot', 'up', 'introspection', 'manifest', 'tools']);
    for (const argv of t.calls.filter(isSnapshot)) {
      const volume = argv[argv.indexOf('-v') + 1];
      assert.match(volume, /^lawoss_(auth|hub|caddy)-data:\/source\/(auth|hub|caddy)-data:ro$/);
      assert.ok(argv.includes('--read-only') && argv.includes('none'));
      assert.ok(argv.some(a => a.startsWith(`${join(t.root, 'snapshots')}/`)), 'writes into <root>/snapshots');
    }
    // Recreated, so that the proxy reads the re-rendered Caddyfile (a single-file bind mount).
    assert.deepEqual(t.calls.find(isUp), [...composeBase(t.root), 'up', '-d', '--wait', '--wait-timeout', '300', '--force-recreate']);
    const snapshot = t.out.find(line => line.startsWith(join(t.root, 'snapshots')));
    for (const volume of ['auth-data', 'hub-data', 'caddy-data']) {
      const archive = join(snapshot, `${volume}.tar`);
      assert.equal(statSync(archive).mode & 0o777, 0o600, `${volume} snapshot is 0600`);
      assert.ok(t.chowns.some(([path, uid]) => path === archive && uid === 0));
    }
    assert.doesNotMatch([...t.out, ...t.err].join('\n').replace(/sha256:[0-9a-f]{64}/g, ''), SECRETISH);
  });

  it('update rolls back when doctor fails after switch', async () => {
    const t = await initialized('crz');
    const before = readFileSync(join(t.root, '.env'));
    const { path, sha } = nextRecord(t.root);
    // The new release answers TLS but its issuer metadata is broken.
    const healthy = healthyProbes('example.com');
    t.state.probes = { ...healthy, async fetch() { return { status: 502, headers: new Headers(), json: async () => ({}) }; } };
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 1);
    assert.deepEqual(t.calls.map(kindOf), ['ps', 'stop', 'snapshot', 'snapshot', 'snapshot', 'up', 'introspection', 'manifest', 'tools', 'up']);
    assert.deepEqual(readFileSync(join(t.root, '.env')), before, 'the previous .env is restored byte for byte');
    assert.equal(statSync(join(t.root, '.env')).mode & 0o777, 0o600);
    assert.match(t.err.join('\n'), /rolled back to 0\.0\.0/);
  });

  it('update rolls back when compose up fails', async () => {
    const t = await initialized('crz');
    const before = readFileSync(join(t.root, '.env'));
    const { path, sha } = nextRecord(t.root);
    let ups = 0;
    t.state.handler = argv => (isUp(argv) && ++ups === 1) ? { code: 1, stdout: '', stderr: 'boom' } : undefined;
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 1);
    assert.equal(ups, 2);
    assert.deepEqual(readFileSync(join(t.root, '.env')), before);
  });

  it('update rolls back when doctor throws after the switch', async () => {
    const t = await initialized('crz');
    const before = readFileSync(join(t.root, '.env'));
    const { path, sha } = nextRecord(t.root);
    let ups = 0;
    // The manifest disappears after the start, so doctor cannot even run.
    t.state.handler = argv => {
      if (isUp(argv) && ++ups === 1) writeFileSync(join(t.root, 'services.json'), '{not json');
      return undefined;
    };
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 1);
    assert.equal(ups, 2);
    assert.deepEqual(readFileSync(join(t.root, '.env')), before);
    assert.match(t.err.join('\n'), /rolled back to 0\.0\.0/);
  });

  it('update refuses until the release\'s host files are installed', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    const { path, sha } = nextRecord(t.root);
    // The record was made for the files as they were; one changes, one appears.
    writeFileSync(join(t.root, 'compose.yaml'), `${readFileSync(join(t.root, 'compose.yaml'), 'utf8')}# local edit\n`);
    writeFileSync(join(t.root, 'bin', 'commands', 'extra.mjs'), '// not in the release\n');
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 1);
    const message = t.err.join('\n');
    assert.match(message, /host files of release 0\.0\.1 must be installed first/);
    assert.match(message, /compose\.yaml/);
    assert.match(message, /bin\/commands\/extra\.mjs/);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
  });

  it('rollback reports a failed check without switching back again', async () => {
    const t = await initialized('crz');
    const { path, sha } = nextRecord(t.root);
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 0);
    t.state.probes = { ...healthyProbes('example.com'), async fetch() { return { status: 502, headers: new Headers(), json: async () => ({}) }; } };
    assert.equal(await t.cli('rollback'), 1);
    assert.equal(t.calls.filter(isUp).length, 1, 'no automatic second switch');
    assert.equal(readEnvFile(join(t.root, '.env')).LAWOSS_RELEASE, '0.0.0', '.env names the release rolled back to');
    assert.ok(t.out.includes('FAIL rollback 0.0.0'));
  });

  it('rollback returns to the previous release images and keeps the current secrets', async () => {
    const t = await initialized('crz');
    const initial = readEnvFile(join(t.root, '.env'));
    const { path, sha } = nextRecord(t.root);
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 0);
    assert.equal(await t.cli('rollback'), 0, t.err.join('\n'));
    const vars = readEnvFile(join(t.root, '.env'));
    assert.equal(vars.LAWOSS_RELEASE, '0.0.0');
    assert.equal(vars.LAWOSS_HUB_IMAGE, initial.LAWOSS_HUB_IMAGE);
    assert.equal(vars.HUB_CONFIG_JSON, initial.HUB_CONFIG_JSON);
    assert.ok(t.calls.some(isUp));
  });

  it('rollback without a previous release is a failure that changes nothing', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('rollback'), 1);
    assert.equal(t.calls.length, 0);
  });
});

describe('update and rollback: host files', () => {
  const update = (t, next) => t.cli('update', '--to', '0.0.1', '--record', next.path, '--record-sha256', next.sha);
  const failingDoctor = () => ({ ...healthyProbes('example.com'), async fetch() { return { status: 502, headers: new Headers(), json: async () => ({}) }; } });
  const snapshotOf = t => t.out.find(line => line.startsWith(join(t.root, 'snapshots')));

  it('update stops auth for the volume snapshot and keeps .env and the outgoing release\'s host files beside it', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    const caddyfile = readFileSync(join(t.root, 'Caddyfile'));
    const old = hostBytes(t.root);
    const next = installNextRelease(t.root);
    assert.equal(await update(t, next), 0, t.err.join('\n'));
    assert.deepEqual(t.calls[0], ['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=lawoss',
      '--filter', 'label=com.docker.compose.service=auth']);
    assert.deepEqual(t.calls[1], ['docker', 'stop', RUNNING_ID]);
    const snapshot = snapshotOf(t);
    assert.deepEqual(readFileSync(join(snapshot, 'host', '.env')), env);
    assert.equal(statSync(join(snapshot, 'host', '.env')).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(join(snapshot, 'host', 'Caddyfile')), caddyfile);
    assert.deepEqual(hostBytes(join(snapshot, 'host')), old, 'the outgoing release\'s files, not the installed new ones');
    assert.equal(JSON.parse(readFileSync(join(snapshot, 'snapshot.json'), 'utf8')).release, '0.0.0');
    assert.equal(statSync(snapshot).mode & 0o777, 0o700);
    // The Caddyfile is rendered again from the new template.
    assert.match(readFileSync(join(t.root, 'Caddyfile'), 'utf8'), /# release 0\.0\.1/);
    // The accepted release is kept with its host files, for a later rollback.
    verifyHostFiles(join(t.root, 'releases', '0.0.1'), keptRecord(t.root, '0.0.1'));
  });

  it('a failed update restores the outgoing release\'s host files, the Caddyfile and .env together', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    const caddyfile = readFileSync(join(t.root, 'Caddyfile'));
    const old = hostBytes(t.root);
    const next = installNextRelease(t.root);
    t.state.probes = failingDoctor();
    assert.equal(await update(t, next), 1);
    assert.deepEqual(hostBytes(t.root), old, 'compose.yaml, the template and bin/ are 0.0.0\'s again');
    assert.equal(existsSync(join(t.root, 'bin', 'commands', 'added.mjs')), false, 'a module only the new release has is removed');
    verifyHostFiles(t.root, keptRecord(t.root, '0.0.0'));
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
    assert.deepEqual(readFileSync(join(t.root, 'Caddyfile')), caddyfile);
    assert.equal(existsSync(join(t.root, 'releases', '0.0.1')), false, 'a refused release is not kept');
    const message = t.err.join('\n');
    assert.match(message, /rolled back to 0\.0\.0/);
    assert.ok(message.includes(`restore-snapshot ${snapshotOf(t)}`), 'names the snapshot that also restores the volumes');
  });

  it('a failed volume snapshot starts auth again, switches nothing and restores the host files', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    const old = hostBytes(t.root);
    const next = installNextRelease(t.root);
    t.state.handler = argv => isSnapshot(argv) && argv.join(' ').includes('hub-data') ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await update(t, next), 1);
    assert.deepEqual(t.calls.at(-1), ['docker', 'start', RUNNING_ID]);
    assert.equal(t.calls.filter(isUp).length, 0);
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
    assert.deepEqual(hostBytes(t.root), old);
    assert.match(t.err.join('\n'), /snapshot of hub-data failed/);
  });

  it('a release refused before the switch leaves the outgoing release\'s host files in place', async () => {
    const t = await initialized('crz');
    const old = hostBytes(t.root);
    const next = installNextRelease(t.root);
    t.state.which = name => name === 'gh';
    t.state.handler = argv => argv[0] === 'gh' ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await update(t, next), 1);
    assert.deepEqual(hostBytes(t.root), old);
    assert.match(t.err.join('\n'), /host files of 0\.0\.0 are back in place/);
  });

  it('rollback installs the previous release\'s kept host files and keeps the current secrets', async () => {
    const t = await initialized('crz');
    const old = hostBytes(t.root);
    const oldCaddyfile = readFileSync(join(t.root, 'Caddyfile'));
    const next = installNextRelease(t.root);
    assert.equal(await update(t, next), 0, t.err.join('\n'));
    const current = readEnvFile(join(t.root, '.env'));
    assert.equal(await t.cli('rollback'), 0, t.err.join('\n'));
    assert.deepEqual(hostBytes(t.root), old);
    assert.deepEqual(readFileSync(join(t.root, 'Caddyfile')), oldCaddyfile);
    const vars = readEnvFile(join(t.root, '.env'));
    assert.equal(vars.LAWOSS_RELEASE, '0.0.0');
    assert.equal(vars.HUB_CONFIG_JSON, current.HUB_CONFIG_JSON);
    assert.ok(snapshotOf(t), 'rollback snapshots too');
    assert.ok(t.calls.some(argv => isUp(argv) && argv.includes('--force-recreate')));
  });

  it('rollback refuses when the previous release\'s host files are not kept', async () => {
    const t = await initialized('crz');
    const next = installNextRelease(t.root);
    assert.equal(await update(t, next), 0);
    const env = readFileSync(join(t.root, '.env'));
    rmSync(join(t.root, 'releases', '0.0.0'), { recursive: true });
    assert.equal(await t.cli('rollback'), 1);
    assert.match(t.err.join('\n'), /0\.0\.0/);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
  });
});

describe('restore-snapshot', () => {
  it('stops the stack, restores every volume, the host files and .env from the snapshot, starts and checks', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    const old = hostBytes(t.root);
    const next = installNextRelease(t.root);
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', next.path, '--record-sha256', next.sha), 0);
    const snapshot = t.out.find(line => line.startsWith(join(t.root, 'snapshots')));
    assert.equal(await t.cli('restore-snapshot', snapshot), 0, t.err.join('\n'));
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
    assert.deepEqual(hostBytes(t.root), old);
    assert.deepEqual(t.calls[0], ['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=lawoss']);
    assert.deepEqual(t.calls[1], ['docker', 'stop', RUNNING_ID]);
    const restores = t.calls.filter(argv => argv[1] === 'run' && String(argv.at(-1)).includes('tar -xpf'));
    assert.deepEqual(restores.map(argv => argv.find(arg => /^lawoss_[a-z-]+:\/target\//.test(arg))),
      ['lawoss_auth-data:/target/auth-data', 'lawoss_hub-data:/target/hub-data', 'lawoss_caddy-data:/target/caddy-data']);
    for (const argv of restores) {
      assert.ok(argv.includes('--network') && argv.includes('none'));
      assert.ok(argv.some(arg => arg.startsWith(`${snapshot}/`) && arg.endsWith('.tar:ro')), 'the archive is mounted read-only');
      assert.ok(argv.includes(readEnvFile(join(t.root, '.env')).LAWOSS_AUTH_IMAGE), 'the snapshot\'s own auth image');
    }
    assert.ok(t.calls.some(argv => isUp(argv) && argv.includes('--force-recreate')));
    assert.ok(t.out.includes(`PASS restore-snapshot ${snapshot}`));
    assert.doesNotMatch([...t.out, ...t.err].join('\n').replace(/sha256:[0-9a-f]{64}/g, ''), SECRETISH);
  });

  it('refuses a relative path, a directory without a snapshot and a tampered host file, changing nothing', async () => {
    const t = await initialized('crz');
    const next = installNextRelease(t.root);
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', next.path, '--record-sha256', next.sha), 0);
    const snapshot = t.out.find(line => line.startsWith(join(t.root, 'snapshots')));
    const env = readFileSync(join(t.root, '.env'));
    assert.equal(await t.cli('restore-snapshot', 'snapshots/x'), 2);
    assert.equal(await t.cli('restore-snapshot', join(t.root, 'backups')), 1);
    writeFileSync(join(snapshot, 'host', 'compose.yaml'), 'tampered\n');
    assert.equal(await t.cli('restore-snapshot', snapshot), 1);
    assert.match(t.err.join('\n'), /compose\.yaml/);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
  });
});
