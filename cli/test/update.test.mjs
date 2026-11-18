import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readEnvFile, validateRecord } from '../lib.mjs';
import { RECORD, SECRETISH, composeBase, healthyProbes, initialized, sha256 } from './helpers.mjs';

const digest = hex => hex.repeat(64);
// A second release, written at test time; its digests are obvious placeholders.
function nextRecord(root, mutate = record => record) {
  const record = mutate({
    version: '0.0.1',
    commit: '1'.repeat(40),
    images: {
      auth: `lawoss-auth@sha256:${digest('1')}`,
      hub: `lawoss-hub@sha256:${digest('1')}`,
      proxy: `caddy@sha256:${digest('1')}`,
    },
    note: 'Placeholder release for tests.',
  });
  const path = join(root, 'record-0.0.1.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { path, sha: sha256(readFileSync(path)) };
}

const isSnapshot = argv => argv[0] === 'docker' && argv[1] === 'run';
const isUp = argv => argv.includes('up');

describe('release records', () => {
  it('the example release record matches the schema', () => {
    const record = JSON.parse(readFileSync(RECORD, 'utf8'));
    assert.deepEqual(validateRecord(record, '0.0.0'), record);
    assert.throws(() => validateRecord(record, '0.0.1'), /version/);
    assert.throws(() => validateRecord({ ...record, images: { ...record.images, hub: 'lawoss-hub:latest' } }, '0.0.0'), /digest/);
    assert.throws(() => validateRecord({ ...record, commit: 'main' }, '0.0.0'), /commit/);
    assert.throws(() => validateRecord({ ...record, extra: 1 }, '0.0.0'), /unknown field/);
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
    const kinds = t.calls.map(argv => isSnapshot(argv) ? 'snapshot' : isUp(argv) ? 'up' : argv.includes('--list-tools') ? 'tools' : 'other');
    assert.deepEqual(kinds, ['snapshot', 'snapshot', 'snapshot', 'up', 'tools']);
    for (const argv of t.calls.filter(isSnapshot)) {
      const volume = argv[argv.indexOf('-v') + 1];
      assert.match(volume, /^lawoss_(auth|hub|caddy)-data:\/source\/(auth|hub|caddy)-data:ro$/);
      assert.ok(argv.includes('--read-only') && argv.includes('none'));
      assert.ok(argv.some(a => a.startsWith(`${join(t.root, 'snapshots')}/`)), 'writes into <root>/snapshots');
    }
    assert.deepEqual(t.calls.find(isUp), [...composeBase(t.root), 'up', '-d', '--wait', '--wait-timeout', '300']);
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
    const kinds = t.calls.map(argv => isSnapshot(argv) ? 'snapshot' : isUp(argv) ? 'up' : argv.includes('--list-tools') ? 'tools' : 'other');
    assert.deepEqual(kinds, ['snapshot', 'snapshot', 'snapshot', 'up', 'tools', 'up']);
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
