import assert from 'node:assert/strict';
import { createHash, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readEnvFile } from '../lib.mjs';
import { ACME_EMAIL, SECRETISH, initialized, setup } from './helpers.mjs';

describe('init', () => {
  it('init writes .env with mode 0600 and prints only hostnames', async () => {
    const t = await initialized('crz,orsr');
    const env = join(t.root, '.env');
    assert.equal(statSync(env).mode & 0o777, 0o600);
    assert.deepEqual(t.chowns.find(([path]) => path === env), [env, 0, 0], '.env is chowned to root');
    assert.deepEqual(t.out, ['auth.example.com', 'crz.example.com', 'orsr.example.com']);
    const printed = [...t.out, ...t.err].join('\n');
    assert.doesNotMatch(printed, SECRETISH);
    assert.equal(t.calls.length, 0, 'init runs no container');
  });

  it('generates configuration that auth and the hub accept, with one introspection secret per service', async () => {
    const t = await initialized('crz,orsr');
    const vars = readEnvFile(join(t.root, '.env'));
    assert.equal(vars.LAWOSS_BASE, 'example.com');
    assert.equal(vars.LAWOSS_SERVICES, 'crz,orsr');
    assert.equal(vars.AUTH_PUBLIC_HOST, 'auth.example.com');
    assert.match(vars.LAWOSS_AUTH_IMAGE, /^lawoss-auth@sha256:0{64}$/);
    const auth = JSON.parse(vars.AUTH_CONFIG_JSON);
    const hub = JSON.parse(vars.HUB_CONFIG_JSON);
    assert.equal(auth.origin, 'https://auth.example.com');
    // Claude's hosted apps register with these exact web callbacks; loopback ones need no entry.
    assert.deepEqual(auth.redirectUris, ['https://claude.ai/api/mcp/auth_callback']);
    assert.equal(auth.dataDir, '/data');
    assert.ok(auth.cookieKeys.length >= 1 && auth.cookieKeys.every(k => k.length >= 32));
    const [jwk] = auth.jwks.keys;
    assert.equal(jwk.alg, 'RS256');
    assert.equal(jwk.use, 'sig');
    assert.ok(jwk.kid);
    assert.equal(createPrivateKey({ key: jwk, format: 'jwk' }).asymmetricKeyType, 'rsa');
    assert.deepEqual(Object.keys(auth.resources), ['https://crz.example.com/mcp', 'https://orsr.example.com/mcp']);
    assert.deepEqual(hub, { base: 'example.com', issuer: 'https://auth.example.com', services: ['crz', 'orsr'], secrets: hub.secrets });
    for (const id of ['crz', 'orsr']) {
      const secret = hub.secrets[id];
      assert.ok(/^\S{32,}$/.test(secret));
      const resource = auth.resources[`https://${id}.example.com/mcp`];
      assert.equal(resource.scope, 'mcp:tools');
      assert.equal(resource.secretHash, createHash('sha256').update(secret).digest('hex'));
    }
    assert.notEqual(hub.secrets.crz, hub.secrets.orsr);
    assert.equal(auth.brand, undefined, 'no brand means the default pack');
  });

  it('says on stderr which web callbacks it allowed, so stdout stays the host names', async () => {
    const t = await initialized('crz');
    assert.deepEqual(t.out, ['auth.example.com', 'crz.example.com']);
    const notice = t.err.join('\n');
    assert.ok(notice.includes('https://claude.ai/api/mcp/auth_callback'), notice);
    assert.match(notice, /callbacks remove/);
  });

  it('--no-claude-callbacks allows no web callback and says that Claude desktop and claude.ai will not connect', async () => {
    const t = setup();
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--acme-email', ACME_EMAIL, '--no-claude-callbacks',
      '--record', t.record, '--record-sha256', t.recordSha), 0, t.err.join('\n'));
    assert.deepEqual(JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON).redirectUris, []);
    assert.deepEqual(t.out, ['auth.example.com', 'crz.example.com']);
    assert.match(t.err.join('\n'), /no web callback.*callbacks add claude/s);
  });

  it('renders the Caddyfile with the auth host and one site per enabled service', async () => {
    const t = await initialized('crz,orsr');
    const caddy = readFileSync(join(t.root, 'Caddyfile'), 'utf8');
    assert.match(caddy, /^auth\.example\.com \{\n\treverse_proxy auth:3000\n\}/m);
    assert.match(caddy, /^crz\.example\.com \{\n\treverse_proxy hub:3000\n\}/m);
    assert.match(caddy, /^orsr\.example\.com \{\n\treverse_proxy hub:3000\n\}/m);
    assert.doesNotMatch(caddy, /\{\{/);
  });

  it('renders the certificate contact e-mail as a Caddy global option and keeps it in .env', async () => {
    const t = await initialized('crz');
    const caddy = readFileSync(join(t.root, 'Caddyfile'), 'utf8');
    assert.match(caddy, /^\{\n\temail ops@example\.com\n\}\n/m);
    assert.equal(readEnvFile(join(t.root, '.env')).LAWOSS_ACME_EMAIL, ACME_EMAIL);
  });

  it('requires --acme-email and refuses one that could break out of the Caddyfile', async () => {
    const t = setup();
    const rest = ['--record', t.record, '--record-sha256', t.recordSha];
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', ...rest), 2);
    for (const bad of ['ops example.com', 'ops@example.com}', 'ops@example.com\nimport x', 'ops@', '@example.com', 'ops@EXAMPLE..com', '{ops}@example.com'])
      assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--acme-email', bad, ...rest), 2, JSON.stringify(bad));
    assert.equal(existsSync(join(t.root, '.env')), false);
    assert.equal(existsSync(join(t.root, 'Caddyfile')), false);
  });

  it('init refuses to overwrite an existing .env', async () => {
    const t = setup();
    writeFileSync(join(t.root, '.env'), 'EXISTING=1\n', { mode: 0o600 });
    const code = await t.cli('init', '--base', 'example.com', '--services', 'crz', '--acme-email', ACME_EMAIL,
      '--record', t.record, '--record-sha256', t.recordSha);
    assert.equal(code, 1);
    assert.equal(readFileSync(join(t.root, '.env'), 'utf8'), 'EXISTING=1\n');
    assert.match(t.err.join('\n'), /already exists/);
  });

  it('rejects unknown services, an invalid base and a missing record with a usage error', async () => {
    const t = setup();
    const args = ['--acme-email', ACME_EMAIL, '--record', t.record, '--record-sha256', t.recordSha];
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz,nope', ...args), 2);
    assert.equal(await t.cli('init', '--base', 'Example..com', '--services', 'crz', ...args), 2);
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--acme-email', ACME_EMAIL), 2);
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--brand', '../x', ...args), 2);
  });

  it('refuses a release record that does not hash to the pinned value and writes nothing', async () => {
    const t = setup();
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--acme-email', ACME_EMAIL,
      '--record', t.record, '--record-sha256', '0'.repeat(64)), 1);
    assert.match(t.err.join('\n'), /does not match/);
    assert.equal(existsSync(join(t.root, '.env')), false);
  });

  it('refuses until the release\'s host files are installed', async () => {
    const t = setup();
    writeFileSync(join(t.root, 'services.json'), '{}\n');
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--acme-email', ACME_EMAIL,
      '--record', t.record, '--record-sha256', t.recordSha), 1);
    assert.match(t.err.join('\n'), /host files of release 0\.0\.0 must be installed first: services\.json/);
    assert.equal(existsSync(join(t.root, '.env')), false);
  });

  it('records a built-in brand pack as a path inside the auth image', async () => {
    const t = setup();
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--brand', 'lawoss', '--acme-email', ACME_EMAIL,
      '--record', t.record, '--record-sha256', t.recordSha), 0);
    assert.equal(JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON).brand, 'brand/lawoss');
  });
});
