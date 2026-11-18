import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readEnvFile } from '../lib.mjs';
import { SENTINEL, composeBase, initialized, setup } from './helpers.mjs';

const image = `lawoss-auth@sha256:${'0'.repeat(64)}`;
const DECLARED = ['brand.json', 'fonts/a.woff2', 'logo.svg', 'tokens.css'];

/** A pack directory as an operator would build it; notes.txt is not declared and is never copied. */
function makePack(parent, name = 'firm', brand = {}) {
  const dir = join(parent, 'packs', name);
  mkdirSync(join(dir, 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({
    productName: 'Firm',
    assets: { logo: 'logo.svg', tokens: 'tokens.css', fonts: [{ file: 'fonts/a.woff2', family: 'A' }], ...brand },
  }));
  writeFileSync(join(dir, 'logo.svg'), '<svg/>\n');
  writeFileSync(join(dir, 'tokens.css'), ':root{}\n');
  writeFileSync(join(dir, 'fonts', 'a.woff2'), 'wOF2');
  writeFileSync(join(dir, 'notes.txt'), 'private notes\n');
  return dir;
}

const listFiles = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort();
const mountOf = (argv, target) => argv.find(arg => arg.endsWith(`:${target}:ro`));
const brandOf = t => JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON).brand;

describe('brand check and preview', () => {
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

  it('brand check validates a staged copy of only the declared files and never installs it', async () => {
    const t = await initialized('crz');
    const pack = makePack(t.root);
    let staged;
    t.state.handler = argv => {
      const mount = mountOf(argv, '/brand/firm');
      staged = listFiles(mount.slice(0, -':/brand/firm:ro'.length));
      return { code: 1, stdout: SENTINEL, stderr: SENTINEL };
    };
    assert.equal(await t.cli('brand', 'check', pack), 1);
    assert.deepEqual(staged, DECLARED);
    assert.ok(t.calls[0].at(-1).includes('"/brand/firm"'));
    assert.deepEqual(t.out, ['FAIL brand firm']);
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
    assert.deepEqual(readdirSync(join(t.root, 'brand')), [], 'nothing installed and the staged copy is removed');
    // A passing check does not install either.
    t.state.handler = undefined;
    assert.equal(await t.cli('brand', 'check', pack), 0);
    assert.deepEqual(readdirSync(join(t.root, 'brand')), []);
  });

  it('brand check runs before init with the auth image from the pinned release record', async () => {
    const t = setup();
    const pack = makePack(t.root);
    assert.equal(await t.cli('brand', 'check', pack), 1, 'without .env or a record there is no image');
    assert.match(t.err.join('\n'), /run init first or pass --record/);
    assert.equal(await t.cli('brand', 'check', pack, '--record', t.record, '--record-sha256', t.recordSha), 0, t.err.join('\n'));
    assert.ok(t.calls.at(-1).includes(image));
    assert.equal(await t.cli('brand', 'check', pack, '--record', t.record, '--record-sha256', '1'.repeat(64)), 1);
    assert.equal(existsSync(join(t.root, '.env')), false);
  });

  it('refuses a pack whose declared file is a symbolic link, lies outside, or that has no brand.json', async () => {
    const t = await initialized('crz');
    const linked = makePack(t.root, 'linked');
    writeFileSync(join(t.root, 'outside.svg'), '<svg/>\n');
    const { rmSync } = await import('node:fs');
    rmSync(join(linked, 'logo.svg'));
    symlinkSync(join(t.root, 'outside.svg'), join(linked, 'logo.svg'));
    assert.equal(await t.cli('brand', 'check', linked), 1);
    assert.match(t.err.join('\n'), /logo\.svg is not a regular file/);
    const escaping = makePack(t.root, 'escaping', { logo: '../outside.svg' });
    assert.equal(await t.cli('brand', 'check', escaping), 1);
    assert.match(t.err.join('\n'), /outside the pack/);
    const empty = join(t.root, 'packs', 'empty');
    mkdirSync(empty, { recursive: true });
    assert.equal(await t.cli('brand', 'check', empty), 1);
    assert.match(t.err.join('\n'), /brand\.json/);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(readdirSync(join(t.root, 'brand')), []);
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

  it('brand preview of a pack directory serves the staged copy at /brand/<name> and installs nothing', async () => {
    const t = await initialized('crz');
    const pack = makePack(t.root);
    assert.equal(await t.cli('brand', 'preview', pack), 0);
    const [argv] = t.calls;
    assert.ok(mountOf(argv, '/brand/firm').startsWith(join(t.root, 'brand', '.incoming-')));
    assert.ok(argv.includes('AUTH_BRAND=/brand/firm'));
    assert.deepEqual(readdirSync(join(t.root, 'brand')), []);
  });

  it('rejects a pack name that is neither a slug nor an absolute directory', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('brand', 'check', '../etc'), 2);
    assert.equal(await t.cli('brand', 'frob', 'lawoss'), 2);
    assert.equal(await t.cli('brand', 'set', 'lawoss', '--record', t.record, '--record-sha256', t.recordSha), 2);
    assert.equal(t.calls.length, 0);
  });
});

describe('brand set', () => {
  it('validates, installs atomically, points auth at /brand/<name> and recreates auth', async () => {
    const t = await initialized('crz');
    const before = readEnvFile(join(t.root, '.env'));
    const pack = makePack(t.root);
    assert.equal(await t.cli('brand', 'set', pack), 0, t.err.join('\n'));
    const [check, up] = t.calls;
    assert.ok(mountOf(check, '/brand/firm').startsWith(join(t.root, 'brand', '.incoming-')), 'validated before install');
    assert.deepEqual(up, [...composeBase(t.root), 'up', '-d', '--force-recreate', 'auth']);
    const installed = join(t.root, 'brand', 'firm');
    assert.deepEqual(listFiles(installed), DECLARED);
    assert.equal(statSync(installed).mode & 0o777, 0o755);
    assert.equal(statSync(join(installed, 'logo.svg')).mode & 0o777, 0o644);
    assert.ok(t.chowns.some(([path, uid]) => path === join(installed, 'logo.svg') && uid === 0));
    assert.deepEqual(readdirSync(join(t.root, 'brand')), ['firm'], 'no staging left behind');
    assert.equal(brandOf(t), '/brand/firm');
    const after = readEnvFile(join(t.root, '.env'));
    assert.equal(after.HUB_CONFIG_JSON, before.HUB_CONFIG_JSON);
    assert.deepEqual({ ...JSON.parse(after.AUTH_CONFIG_JSON), brand: undefined }, { ...JSON.parse(before.AUTH_CONFIG_JSON), brand: undefined });
    assert.equal(statSync(join(t.root, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(t.out, ['PASS brand firm', 'auth uses brand firm']);
    assert.ok(![...t.out, ...t.err].join('\n').includes(after.AUTH_CONFIG_JSON));
  });

  it('replaces an installed pack only after the new one passes', async () => {
    const t = await initialized('crz');
    const pack = makePack(t.root);
    assert.equal(await t.cli('brand', 'set', pack), 0);
    writeFileSync(join(pack, 'logo.svg'), '<svg>new</svg>\n');
    t.state.handler = argv => argv[1] === 'run' ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await t.cli('brand', 'set', pack), 1);
    assert.equal(readFileSync(join(t.root, 'brand', 'firm', 'logo.svg'), 'utf8'), '<svg/>\n', 'the live pack is untouched');
    assert.ok(!t.calls.some(argv => argv.includes('up')), 'auth is not restarted');
    t.state.handler = undefined;
    assert.equal(await t.cli('brand', 'set', pack), 0);
    assert.equal(readFileSync(join(t.root, 'brand', 'firm', 'logo.svg'), 'utf8'), '<svg>new</svg>\n');
  });

  it('brand set default returns auth to its built-in LAWOSS pack', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('brand', 'set', makePack(t.root)), 0);
    assert.equal(await t.cli('brand', 'set', 'default'), 0);
    assert.equal(brandOf(t), undefined);
  });
});

describe('init --brand', () => {
  const init = (t, ...extra) => t.cli('init', '--base', 'example.com', '--services', 'crz', ...extra, '--record', t.record, '--record-sha256', t.recordSha);

  it('without a pack, auth uses its default LAWOSS pack and the mounted directory still exists', async () => {
    const t = setup();
    assert.equal(await init(t), 0);
    assert.equal(brandOf(t), undefined);
    assert.equal(t.calls.length, 0, 'nothing to check');
    assert.equal(statSync(join(t.root, 'brand')).mode & 0o777, 0o755, 'compose refuses to create the bind source itself');
  });

  it('a pack directory is checked with the record\'s auth image, then installed and configured at its mounted path', async () => {
    const t = setup();
    const pack = makePack(t.root);
    assert.equal(await init(t, '--brand', pack), 0, t.err.join('\n'));
    assert.equal(t.calls.length, 1);
    assert.ok(t.calls[0].includes(image) && mountOf(t.calls[0], '/brand/firm'));
    assert.equal(brandOf(t), '/brand/firm');
    assert.deepEqual(listFiles(join(t.root, 'brand', 'firm')), DECLARED);
  });

  it('a pack that fails auth\'s check, or an unknown built-in name, is refused before anything is written', async () => {
    const t = setup();
    const pack = makePack(t.root);
    t.state.handler = argv => argv[1] === 'run' ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await init(t, '--brand', pack), 1);
    assert.match(t.err.join('\n'), /did not pass/);
    assert.equal(existsSync(join(t.root, '.env')), false);
    assert.equal(existsSync(join(t.root, 'Caddyfile')), false);
    assert.equal(existsSync(join(t.root, 'brand', 'firm')), false);
    t.state.handler = argv => argv.at(-1).includes('/app/brand/nosuch') ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await init(t, '--brand', 'nosuch'), 1);
    assert.equal(existsSync(join(t.root, '.env')), false);
  });

  it('an installed pack is used by name; a built-in name stays inside the image', async () => {
    const t = setup();
    makePack(t.root);
    mkdirSync(join(t.root, 'brand'), { recursive: true });
    cpSync(join(t.root, 'packs', 'firm'), join(t.root, 'brand', 'firm'), { recursive: true });
    assert.equal(await init(t, '--brand', 'firm'), 0);
    assert.equal(mountOf(t.calls[0], '/brand/firm'), `${join(t.root, 'brand', 'firm')}:/brand/firm:ro`);
    assert.equal(brandOf(t), '/brand/firm');
    const u = setup();
    assert.equal(await init(u, '--brand', 'lawoss'), 0);
    assert.ok(u.calls[0].at(-1).includes('/app/brand/lawoss'));
    assert.equal(brandOf(u), 'brand/lawoss');
  });
});

describe('built-in pack names', () => {
  it('a pack directory named like a built-in pack is refused and nothing is staged', async () => {
    const t = await initialized('crz');
    for (const name of ['default', 'lawoss']) {
      const pack = makePack(t.root, name);
      assert.equal(await t.cli('brand', 'set', pack), 2, name);
      assert.match(t.err.join('\n'), /reserved for a pack built into the auth image/);
      assert.equal(await t.cli('brand', 'check', pack), 2, name);
    }
    assert.equal(t.calls.length, 0);
    assert.deepEqual(readdirSync(join(t.root, 'brand')), []);
    assert.equal(brandOf(t), undefined);
  });

  it('the reserved names are exactly the packs built into auth', async () => {
    const { BUILT_IN_PACKS } = await import('../commands/brand.mjs');
    const { repo } = await import('./helpers.mjs');
    assert.deepEqual([...BUILT_IN_PACKS].sort(), readdirSync(join(repo, 'auth', 'brand')).sort());
  });
});
