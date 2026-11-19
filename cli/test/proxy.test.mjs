// The proxy's published host ports and bind address: .env keys, init options, one shared validator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { seal, unseal } from '../commands/backup.mjs';
import { USAGE } from '../lawoss-selfhost.mjs';
import { deployment, proxyProblem, readEnvFile, setEnvVars } from '../lib.mjs';
import { ACME_EMAIL, SECRETISH, SENTINEL, initialized, installNextRelease, setup } from './helpers.mjs';

const KEYS = ['LAWOSS_HTTP_PORT', 'LAWOSS_HTTPS_PORT', 'LAWOSS_PROXY_BIND'];
const initArgs = t => ['init', '--base', 'example.com', '--services', 'crz', '--acme-email', ACME_EMAIL,
  '--record', t.record, '--record-sha256', t.recordSha];
const proxyVars = root => {
  const vars = readEnvFile(join(root, '.env'));
  return Object.fromEntries(KEYS.map(key => [key, vars[key]]));
};
const CUSTOM = { LAWOSS_HTTP_PORT: '8080', LAWOSS_HTTPS_PORT: '8443', LAWOSS_PROXY_BIND: '127.0.0.1' };
const edit = (root, vars) => writeFileSync(join(root, '.env'), setEnvVars(readFileSync(join(root, '.env'), 'utf8'), vars));

describe('proxy validator', () => {
  it('accepts the defaults and well-formed values', () => {
    assert.equal(proxyProblem({}), undefined);
    assert.equal(proxyProblem({ http: '', https: '', bind: '' }), undefined);
    assert.equal(proxyProblem({ http: '8080', https: '8443', bind: '127.0.0.1' }), undefined);
    assert.equal(proxyProblem({ http: '1', https: '65535', bind: '::1' }), undefined);
    assert.equal(proxyProblem({ bind: 'fd00::1' }), undefined);
  });

  it('names the key of a bad value', () => {
    for (const http of ['0', '65536', '080', '+80', '-1', '8o', ' 80', '80 ', '1e2', '0x50'])
      assert.equal(proxyProblem({ http }), 'LAWOSS_HTTP_PORT', http);
    for (const https of ['0', '65536', '0443', '+443'])
      assert.equal(proxyProblem({ https }), 'LAWOSS_HTTPS_PORT', https);
    assert.equal(proxyProblem({ http: '443' }), 'LAWOSS_HTTPS_PORT', 'the https default equals this http port');
    assert.equal(proxyProblem({ http: '8080', https: '8080' }), 'LAWOSS_HTTPS_PORT');
    for (const bind of ['localhost', '[::1]', '1.2.3', '1.2.3.4.5', '0.0.0.0/0', 'fe80::1%eth0', ' 127.0.0.1', 'example.com'])
      assert.equal(proxyProblem({ bind }), 'LAWOSS_PROXY_BIND', bind);
  });
});

describe('init proxy options', () => {
  it('writes the three keys with their defaults, so the file states the choice', async () => {
    const t = await initialized('crz');
    assert.deepEqual(proxyVars(t.root), { LAWOSS_HTTP_PORT: '80', LAWOSS_HTTPS_PORT: '443', LAWOSS_PROXY_BIND: '' });
    assert.match(readFileSync(join(t.root, '.env'), 'utf8'), /^LAWOSS_PROXY_BIND=$/m);
    assert.deepEqual(deployment(t.root).proxy, { httpPort: '80', httpsPort: '443', bind: '' });
  });

  it('writes custom ports and an IPv4 or IPv6 bind address', async () => {
    for (const bind of ['127.0.0.1', '172.17.0.1', '::1']) {
      const t = setup();
      assert.equal(await t.cli(...initArgs(t), '--http-port', '8080', '--https-port', '8443', '--proxy-bind', bind), 0, t.err.join('\n'));
      assert.deepEqual(proxyVars(t.root), { LAWOSS_HTTP_PORT: '8080', LAWOSS_HTTPS_PORT: '8443', LAWOSS_PROXY_BIND: bind });
      assert.deepEqual(deployment(t.root).proxy, { httpPort: '8080', httpsPort: '8443', bind });
      assert.doesNotMatch([...t.out, ...t.err].join('\n'), SECRETISH);
    }
  });

  it('accepts one option on its own', async () => {
    const t = setup();
    assert.equal(await t.cli(...initArgs(t), '--https-port', '8443'), 0, t.err.join('\n'));
    assert.deepEqual(proxyVars(t.root), { LAWOSS_HTTP_PORT: '80', LAWOSS_HTTPS_PORT: '8443', LAWOSS_PROXY_BIND: '' });
  });

  it('refuses bad values with a usage error and writes nothing', async () => {
    const bad = [
      ['--http-port', '0'], ['--http-port', '65536'], ['--http-port', '080'], ['--http-port', '+80'], ['--http-port', ''],
      ['--https-port', '0'], ['--https-port', '65536'], ['--https-port', '0443'], ['--https-port', '-443'],
      ['--proxy-bind', 'localhost'], ['--proxy-bind', '[::1]'], ['--proxy-bind', '1.2.3'], ['--proxy-bind', ' '],
      ['--http-port', '8080', '--https-port', '8080'],
      ['--http-port', '443'],
      ['--https-port', '80'],
    ];
    for (const extra of bad) {
      const t = setup();
      assert.equal(await t.cli(...initArgs(t), ...extra), 2, extra.join(' '));
      assert.equal(existsSync(join(t.root, '.env')), false, extra.join(' '));
      assert.equal(existsSync(join(t.root, 'Caddyfile')), false, extra.join(' '));
      assert.equal(existsSync(join(t.root, 'releases')), false, extra.join(' '));
      assert.equal(t.calls.length, 0);
    }
  });

  it('the usage text names the options', () => {
    for (const option of ['--http-port', '--https-port', '--proxy-bind']) assert.ok(USAGE.includes(option), option);
  });
});

describe('deployment() reads the keys', () => {
  it('an .env written by 0.1.0 (no keys) means the defaults', async () => {
    const t = await initialized('crz');
    const text = readFileSync(join(t.root, '.env'), 'utf8').split('\n').filter(line => !/^LAWOSS_(HTTP_PORT|HTTPS_PORT|PROXY_BIND)=/.test(line)).join('\n');
    writeFileSync(join(t.root, '.env'), text);
    assert.deepEqual(deployment(t.root).proxy, { httpPort: '80', httpsPort: '443', bind: '' });
  });

  it('refuses an invalid value and names the key, never the value', async () => {
    const t = await initialized('crz');
    for (const [key, value] of [['LAWOSS_HTTP_PORT', '70000'], ['LAWOSS_HTTPS_PORT', '80'], ['LAWOSS_PROXY_BIND', 'my-host']]) {
      edit(t.root, { LAWOSS_HTTP_PORT: '80', LAWOSS_HTTPS_PORT: '443', LAWOSS_PROXY_BIND: '', [key]: value });
      assert.throws(() => deployment(t.root), error => error.message.includes(key) && !error.message.includes(value), key);
      assert.equal(await t.cli('doctor'), 1, key);
      assert.ok(t.err.join('\n').includes(key));
      assert.ok(!t.err.join('\n').includes(value));
    }
  });
});

describe('other commands leave the keys alone', () => {
  it('update, rotate and services add|remove keep custom values', async () => {
    const t = setup();
    assert.equal(await t.cli(...initArgs(t), '--http-port', '8080', '--https-port', '8443', '--proxy-bind', '127.0.0.1'), 0, t.err.join('\n'));
    const next = installNextRelease(t.root);
    assert.equal(await t.cli('update', '--to', '0.0.1', '--record', next.path, '--record-sha256', next.sha), 0, t.err.join('\n'));
    assert.deepEqual(proxyVars(t.root), CUSTOM, 'update');
    for (const argv of [['rotate', 'introspection'], ['rotate', 'cookies'], ['rotate', 'signing'], ['services', 'add', 'orsr'], ['services', 'remove', 'orsr']]) {
      assert.equal(await t.cli(...argv), 0, `${argv.join(' ')}: ${t.err.join('\n')}`);
      assert.deepEqual(proxyVars(t.root), CUSTOM, argv.join(' '));
    }
    assert.equal(await t.cli('rollback'), 0, t.err.join('\n'));
    assert.deepEqual(proxyVars(t.root), CUSTOM, 'rollback');
  });
});

describe('restore refuses a backup with an invalid proxy setting', () => {
  function backupWrites(argv) {
    if (argv[0] !== 'docker' || argv[1] !== 'run') return undefined;
    const out = argv.find(arg => arg.endsWith(':/backup'))?.split(':')[0];
    if (argv.includes('scripts/backup.mjs') && argv.includes('snapshot')) {
      writeFileSync(join(out, 'auth.enc.json'), '{"placeholder":"auth backup"}\n', { mode: 0o600 });
      return { code: 0, stdout: JSON.stringify({ output: '/backup/auth.enc.json', sha256: SENTINEL }), stderr: '' };
    }
    if (argv.includes('tar')) {
      writeFileSync(join(out, 'hub-data.tar'), 'archive\n', { mode: 0o600 });
      return { code: 0, stdout: '', stderr: '' };
    }
    return undefined;
  }

  it('before anything is stopped or written, naming the key', async () => {
    const source = await initialized('crz');
    edit(source.root, CUSTOM);
    source.state.handler = backupWrites;
    assert.equal(await source.cli('backup', 'init-key'), 0);
    assert.equal(await source.cli('backup'), 0, source.err.join('\n'));
    const [dir] = source.out;
    const away = mkdtempSync(join(tmpdir(), 'lawoss-key-away-'));
    after(() => rmSync(away, { recursive: true, force: true }));
    const key = join(away, 'backup-private.pem');
    renameSync(join(source.root, 'keys', 'backup-private.pem'), key);
    const publicKey = readFileSync(join(source.root, 'keys', 'backup-public.pem'));

    // A valid custom backup is accepted and restores the same .env.
    const good = setup();
    assert.equal(await good.cli('restore', '--apply', '--record-sha256', source.recordSha, '--private-key', key, dir), 0, good.err.join('\n'));
    assert.deepEqual(proxyVars(good.root), CUSTOM);

    const original = unseal(JSON.parse(readFileSync(join(dir, 'host.enc.json'), 'utf8')), readFileSync(key));
    for (const [name, value] of [['LAWOSS_HTTP_PORT', '0'], ['LAWOSS_HTTPS_PORT', '8080'], ['LAWOSS_PROXY_BIND', 'evil.example.com']]) {
      const content = structuredClone(original);
      const env = setEnvVars(Buffer.from(content.files['.env'], 'base64').toString('utf8'), { ...CUSTOM, [name]: value });
      content.files['.env'] = Buffer.from(env).toString('base64');
      content.manifest['.env'] = createHash('sha256').update(env).digest('hex');
      writeFileSync(join(dir, 'host.enc.json'), JSON.stringify(seal(content, publicKey)));
      const fresh = setup();
      assert.equal(await fresh.cli('restore', '--apply', '--record-sha256', source.recordSha, '--private-key', key, dir), 1, name);
      assert.ok(fresh.err.join('\n').includes(name), fresh.err.join('\n'));
      assert.ok(!fresh.err.join('\n').includes(value));
      assert.equal(fresh.calls.length, 0, 'nothing was stopped or run');
      assert.equal(existsSync(join(fresh.root, '.env')), false);
      assert.deepEqual(readdirSync(fresh.root).filter(n => n === 'releases' || n === 'brand'), [], 'nothing written');
    }
  });
});
