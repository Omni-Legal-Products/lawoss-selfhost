import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SENTINEL, initialized } from './helpers.mjs';

const image = `lawoss-auth@sha256:${'0'.repeat(64)}`;

describe('brand', () => {
  it('brand check validates a built-in pack in the auth image, offline and read-only', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('brand', 'check', 'lawoss'), 0);
    const [argv] = t.calls;
    assert.deepEqual(argv.slice(0, 10), ['docker', 'run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true']);
    assert.ok(argv.includes(image));
    assert.ok(argv.at(-1).includes('/app/brand/lawoss'));
    assert.deepEqual(t.out, ['PASS brand lawoss']);
  });

  it('brand check mounts a pack directory read-only and prints nothing from the container', async () => {
    const t = await initialized('crz');
    const pack = join(t.root, 'packs', 'firm');
    mkdirSync(pack, { recursive: true });
    t.state.handler = () => ({ code: 1, stdout: SENTINEL, stderr: SENTINEL });
    assert.equal(await t.cli('brand', 'check', pack), 1);
    assert.ok(t.calls[0].includes(`${pack}:/app/brand/custom:ro`));
    assert.deepEqual(t.out, [`FAIL brand ${pack}`]);
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
  });

  it('brand preview serves on loopback only and prints the SSH tunnel command', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('brand', 'preview', 'lawoss'), 0);
    const [argv] = t.calls;
    assert.ok(argv.includes('--network') && argv[argv.indexOf('--network') + 1] === 'host', 'the preview binds 127.0.0.1 of the host');
    assert.ok(!argv.includes('-p') && !argv.includes('--publish'));
    assert.ok(argv.includes('--init'), 'Ctrl-C reaches the preview');
    assert.ok(argv.includes('AUTH_BRAND=brand/lawoss'));
    assert.deepEqual(argv.slice(-2), ['node', 'dist/preview.js']);
    assert.match(t.out.join('\n'), /ssh -N -L 4317:127\.0\.0\.1:4317 /);
  });

  it('rejects a pack name that is neither a slug nor an absolute directory', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('brand', 'check', '../etc'), 2);
    assert.equal(await t.cli('brand', 'frob', 'lawoss'), 2);
    assert.equal(t.calls.length, 0);
  });
});
