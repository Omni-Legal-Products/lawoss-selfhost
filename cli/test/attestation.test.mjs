import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RECORD, RECORD_SHA, initialized, setup, sha256 } from './helpers.mjs';

const zeros = '0'.repeat(64);
const verify = image => ['gh', 'attestation', 'verify', `oci://${image}`, '--owner', 'Omni-Legal-Products'];
const isGh = argv => argv[0] === 'gh';
const initArgs = ['init', '--base', 'example.com', '--services', 'crz', '--record', RECORD, '--record-sha256', RECORD_SHA];

describe('build attestations', () => {
  it('init verifies the attestation of each image built by the organization when gh is available', async () => {
    const t = setup();
    t.state.which = name => name === 'gh';
    assert.equal(await t.cli(...initArgs), 0, t.err.join('\n'));
    assert.deepEqual(t.calls.filter(isGh), [verify(`lawoss-auth@sha256:${zeros}`), verify(`lawoss-hub@sha256:${zeros}`)]);
    assert.deepEqual(t.out, ['auth.example.com', 'crz.example.com'], 'stdout still carries only host names');
    assert.ok(existsSync(join(t.root, '.env')));
  });

  it('init refuses when an attestation does not verify, and writes nothing', async () => {
    const t = setup();
    t.state.which = name => name === 'gh';
    t.state.handler = argv => isGh(argv) && argv[3].includes('lawoss-hub') ? { code: 1, stdout: 'details', stderr: 'details' } : undefined;
    assert.equal(await t.cli(...initArgs), 1);
    assert.match(t.err.join('\n'), /attestation of the hub image did not verify/);
    assert.ok(!t.err.join('\n').includes('details'), 'gh output is not passed on');
    assert.equal(existsSync(join(t.root, '.env')), false);
  });

  it('update refuses when an attestation does not verify, before anything is switched', async () => {
    const t = await initialized('crz');
    const before = readFileSync(join(t.root, '.env'));
    const record = {
      version: '0.0.1', commit: '1'.repeat(40), note: 'Placeholder release for tests.',
      images: { auth: `lawoss-auth@sha256:${'1'.repeat(64)}`, hub: `lawoss-hub@sha256:${'1'.repeat(64)}`, proxy: `caddy@sha256:${'1'.repeat(64)}` },
    };
    const path = join(t.root, 'record.json');
    writeFileSync(path, JSON.stringify(record));
    t.state.which = name => name === 'gh';
    t.state.handler = argv => isGh(argv) ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', path, '--record-sha256', sha256(readFileSync(path))), 1);
    assert.deepEqual(t.calls, [verify(record.images.auth)], 'stops at the first failure; no snapshot, no start');
    assert.deepEqual(readFileSync(join(t.root, '.env')), before);
  });

  it('without gh, prints one notice line and continues', async () => {
    const t = setup();
    t.state.which = () => false;
    assert.equal(await t.cli(...initArgs), 0);
    assert.equal(t.calls.filter(isGh).length, 0);
    const notices = t.err.filter(line => /gh is not installed/.test(line));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /build attestations were not verified/);
  });
});
