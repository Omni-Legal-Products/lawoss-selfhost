import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initialized, setup, writeRecord } from './helpers.mjs';

const zeros = '0'.repeat(64);
// --repo binds the attestation to this repository (gh refuses --owner together with --repo).
const verify = image => ['gh', 'attestation', 'verify', `oci://${image}`, '--repo', 'Omni-Legal-Products/lawoss-selfhost'];
const isGh = argv => argv[0] === 'gh';
const initArgs = t => ['init', '--base', 'example.com', '--services', 'crz', '--record', t.record, '--record-sha256', t.recordSha];

describe('build attestations', () => {
  it('init verifies the attestation of each image built by the organization when gh is available', async () => {
    const t = setup();
    t.state.which = name => name === 'gh';
    assert.equal(await t.cli(...initArgs(t)), 0, t.err.join('\n'));
    assert.deepEqual(t.calls.filter(isGh), [verify(`lawoss-auth@sha256:${zeros}`), verify(`lawoss-hub@sha256:${zeros}`)]);
    assert.deepEqual(t.out, ['auth.example.com', 'crz.example.com'], 'stdout still carries only host names');
    assert.ok(existsSync(join(t.root, '.env')));
  });

  it('init refuses when an attestation does not verify, hints at the gh login, and writes nothing', async () => {
    const t = setup();
    t.state.which = name => name === 'gh';
    t.state.handler = argv => isGh(argv) && argv[3].includes('lawoss-hub') ? { code: 1, stdout: 'details', stderr: 'details' } : undefined;
    assert.equal(await t.cli(...initArgs(t)), 1);
    assert.match(t.err.join('\n'), /attestation of the hub image did not verify/);
    assert.equal(t.err.filter(line => /gh must be logged in as root/.test(line)).length, 1);
    assert.ok(!t.err.join('\n').includes('details'), 'gh output is not passed on');
    assert.equal(existsSync(join(t.root, '.env')), false);
  });

  it('update refuses when an attestation does not verify, before anything is switched', async () => {
    const t = await initialized('crz');
    const before = readFileSync(join(t.root, '.env'));
    const ones = '1'.repeat(64);
    const { path, sha, record } = writeRecord(t.root, {
      version: '0.0.1',
      images: { auth: `lawoss-auth@sha256:${ones}`, hub: `lawoss-hub@sha256:${ones}`, proxy: `caddy@sha256:${ones}` },
    });
    t.state.which = name => name === 'gh';
    t.state.handler = argv => isGh(argv) ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha), 1);
    assert.deepEqual(t.calls, [verify(record.images.auth)], 'stops at the first failure; no snapshot, no start');
    assert.deepEqual(readFileSync(join(t.root, '.env')), before);
  });

  it('without gh, prints one notice line and continues', async () => {
    const t = setup();
    t.state.which = () => false;
    assert.equal(await t.cli(...initArgs(t)), 0);
    assert.equal(t.calls.filter(isGh).length, 0);
    const notices = t.err.filter(line => /gh is not installed/.test(line));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /build attestations were not verified/);
  });
});
