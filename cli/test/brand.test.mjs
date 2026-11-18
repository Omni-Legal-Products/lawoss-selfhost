import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readEnvFile } from '../lib.mjs';
import { RECORD, RECORD_SHA, SENTINEL, initialized, setup } from './helpers.mjs';

const image = `lawoss-auth@sha256:${'0'.repeat(64)}`;

/** A pack directory as an operator would build it (contents are not checked on the host). */
function makePack(parent, name = 'firm') {
  const dir = join(parent, 'packs', name);
  mkdirSync(join(dir, 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), '{"productName":"Firm"}\n');
  writeFileSync(join(dir, 'logo.svg'), '<svg/>\n');
  writeFileSync(join(dir, 'fonts', 'OFL.txt'), 'licence\n');
  return dir;
}

describe('brand', () => {
  it('brand check validates a built-in pack in the auth image, offline and read-only', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('brand', 'check', 'lawoss'), 0);
    const [argv] = t.calls;
    assert.deepEqual(argv.slice(0, 10), ['docker', 'run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true']);
    assert.ok(argv.includes(image));
    assert.ok(!argv.includes('-v'), 'a built-in pack needs no mount');
    assert.ok(argv.at(-1).includes('/app/brand/lawoss'));
    assert.deepEqual(t.out, ['PASS brand lawoss']);
  });

  it('brand check copies a pack directory into <root>/brand and validates it where auth will read it', async () => {
    const t = await initialized('crz');
    const pack = makePack(t.root);
    t.state.handler = () => ({ code: 1, stdout: SENTINEL, stderr: SENTINEL });
    assert.equal(await t.cli('brand', 'check', pack), 1);
    const [argv] = t.calls;
    assert.ok(argv.includes(`${join(t.root, 'brand')}:/brand:ro`));
    assert.ok(argv.at(-1).includes('"/brand/firm"'));
    assert.deepEqual(t.out, ['FAIL brand firm']);
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
    const copy = join(t.root, 'brand', 'firm');
    assert.equal(readFileSync(join(copy, 'fonts', 'OFL.txt'), 'utf8'), 'licence\n');
    assert.equal(statSync(copy).mode & 0o777, 0o755);
    assert.equal(statSync(join(copy, 'logo.svg')).mode & 0o777, 0o644);
    assert.ok(t.chowns.some(([path, uid]) => path === join(copy, 'logo.svg') && uid === 0));
    // Once copied, the pack is known by its name.
    t.state.handler = undefined;
    assert.equal(await t.cli('brand', 'check', 'firm'), 0);
    assert.ok(t.calls[0].includes(`${join(t.root, 'brand')}:/brand:ro`));
    assert.deepEqual(t.out, ['PASS brand firm']);
  });

  it('a pack with a symbolic link or without brand.json is refused', async () => {
    const t = await initialized('crz');
    const linked = makePack(t.root, 'linked');
    symlinkSync(join(t.root, '.env'), join(linked, 'logo-dark.svg'));
    assert.equal(await t.cli('brand', 'check', linked), 1);
    assert.match(t.err.join('\n'), /regular files/);
    const empty = join(t.root, 'packs', 'empty');
    mkdirSync(empty, { recursive: true });
    assert.equal(await t.cli('brand', 'check', empty), 1);
    assert.match(t.err.join('\n'), /brand\.json/);
    assert.equal(t.calls.length, 0);
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

  it('brand preview of a custom pack reads it from the mounted brand directory', async () => {
    const t = await initialized('crz');
    const pack = makePack(t.root);
    assert.equal(await t.cli('brand', 'preview', pack), 0);
    const [argv] = t.calls;
    assert.ok(argv.includes(`${join(t.root, 'brand')}:/brand:ro`));
    assert.ok(argv.includes('AUTH_BRAND=/brand/firm'));
  });

  it('rejects a pack name that is neither a slug nor an absolute directory', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('brand', 'check', '../etc'), 2);
    assert.equal(await t.cli('brand', 'frob', 'lawoss'), 2);
    assert.equal(t.calls.length, 0);
  });
});

describe('init --brand', () => {
  const init = (t, ...extra) => t.cli('init', '--base', 'example.com', '--services', 'crz', ...extra, '--record', RECORD, '--record-sha256', RECORD_SHA);
  const brandOf = t => JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON).brand;

  it('without a pack, auth uses its default LAWOSS pack and the mounted directory still exists', async () => {
    const t = setup();
    assert.equal(await init(t), 0);
    assert.equal(brandOf(t), undefined);
    assert.equal(statSync(join(t.root, 'brand')).mode & 0o777, 0o755, 'compose refuses to create the bind source itself');
  });

  it('a custom pack directory is copied into <root>/brand and configured at its mounted path', async () => {
    const t = setup();
    const pack = makePack(t.root);
    assert.equal(await init(t, '--brand', pack), 0, t.err.join('\n'));
    assert.equal(brandOf(t), '/brand/firm');
    assert.equal(readFileSync(join(t.root, 'brand', 'firm', 'brand.json'), 'utf8'), '{"productName":"Firm"}\n');
    assert.equal(t.calls.length, 0, 'init runs no container');
  });

  it('a pack already in <root>/brand is configured by name; a built-in name stays inside the image', async () => {
    const t = setup();
    makePack(t.root);
    mkdirSync(join(t.root, 'brand'), { recursive: true });
    const { cpSync } = await import('node:fs');
    cpSync(join(t.root, 'packs', 'firm'), join(t.root, 'brand', 'firm'), { recursive: true });
    assert.equal(await init(t, '--brand', 'firm'), 0);
    assert.equal(brandOf(t), '/brand/firm');
    const u = setup();
    assert.equal(await init(u, '--brand', 'lawoss'), 0);
    assert.equal(brandOf(u), 'brand/lawoss');
  });
});
