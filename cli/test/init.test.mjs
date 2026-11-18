import assert from 'node:assert/strict';
import { createHash, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readEnvFile } from '../lib.mjs';
import { RECORD, RECORD_SHA, SECRETISH, initialized, setup } from './helpers.mjs';

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

  it('renders the Caddyfile with the auth host and one site per enabled service', async () => {
    const t = await initialized('crz,orsr');
    const caddy = readFileSync(join(t.root, 'Caddyfile'), 'utf8');
    assert.match(caddy, /^auth\.example\.com \{\n\treverse_proxy auth:3000\n\}/m);
    assert.match(caddy, /^crz\.example\.com \{\n\treverse_proxy hub:3000\n\}/m);
    assert.match(caddy, /^orsr\.example\.com \{\n\treverse_proxy hub:3000\n\}/m);
    assert.doesNotMatch(caddy, /\{\{/);
  });

  it('init refuses to overwrite an existing .env', async () => {
    const t = setup();
    writeFileSync(join(t.root, '.env'), 'EXISTING=1\n', { mode: 0o600 });
    const code = await t.cli('init', '--base', 'example.com', '--services', 'crz', '--record', RECORD, '--record-sha256', RECORD_SHA);
    assert.equal(code, 1);
    assert.equal(readFileSync(join(t.root, '.env'), 'utf8'), 'EXISTING=1\n');
    assert.match(t.err.join('\n'), /already exists/);
  });

  it('rejects unknown services, an invalid base and a missing record with a usage error', async () => {
    const t = setup();
    const args = ['--record', RECORD, '--record-sha256', RECORD_SHA];
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz,nope', ...args), 2);
    assert.equal(await t.cli('init', '--base', 'Example..com', '--services', 'crz', ...args), 2);
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz'), 2);
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--brand', '../x', ...args), 2);
  });

  it('refuses a release record that does not hash to the pinned value and writes nothing', async () => {
    const t = setup();
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--record', RECORD, '--record-sha256', '0'.repeat(64)), 1);
    assert.match(t.err.join('\n'), /does not match/);
    assert.equal(existsSync(join(t.root, '.env')), false);
  });

  it('records a built-in brand pack as a path inside the auth image', async () => {
    const t = setup();
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--brand', 'lawoss',
      '--record', RECORD, '--record-sha256', RECORD_SHA), 0);
    assert.equal(JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON).brand, 'brand/lawoss');
  });
});
