import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readEnvFile } from '../lib.mjs';
import { SECRETISH, composeBase, initialized } from './helpers.mjs';

const configs = t => {
  const vars = readEnvFile(join(t.root, '.env'));
  return { vars, auth: JSON.parse(vars.AUTH_CONFIG_JSON), hub: JSON.parse(vars.HUB_CONFIG_JSON) };
};
const hash = value => createHash('sha256').update(value).digest('hex');
const recreate = (t, ...services) => [...composeBase(t.root), 'up', '-d', '--wait', '--wait-timeout', '300', '--force-recreate', ...services];
const quiet = t => assert.doesNotMatch([...t.out, ...t.err].join('\n'), SECRETISH);

describe('rotate', () => {
  it('rotate introspection replaces every service secret in the hub and its hash in auth together', async () => {
    const t = await initialized('crz,orsr');
    const before = configs(t);
    assert.equal(await t.cli('rotate', 'introspection'), 0, t.err.join('\n'));
    const after = configs(t);
    for (const id of ['crz', 'orsr']) {
      assert.notEqual(after.hub.secrets[id], before.hub.secrets[id]);
      assert.match(after.hub.secrets[id], /^\S{32,}$/);
      assert.equal(after.auth.resources[`https://${id}.example.com/mcp`].secretHash, hash(after.hub.secrets[id]));
    }
    assert.deepEqual(after.auth.cookieKeys, before.auth.cookieKeys);
    assert.deepEqual(after.auth.jwks, before.auth.jwks);
    assert.equal(statSync(join(t.root, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(t.calls, [recreate(t, 'auth', 'hub')]);
    assert.deepEqual(t.out, ['rotated introspection']);
    quiet(t);
  });

  it('rotate cookies puts a new key first and keeps only the previous one', async () => {
    const t = await initialized('crz');
    const before = configs(t);
    assert.equal(await t.cli('rotate', 'cookies'), 0, t.err.join('\n'));
    const once = configs(t);
    assert.equal(once.auth.cookieKeys.length, 2);
    assert.equal(once.auth.cookieKeys[1], before.auth.cookieKeys[0]);
    assert.ok(!before.auth.cookieKeys.includes(once.auth.cookieKeys[0]));
    assert.ok(once.auth.cookieKeys.every(key => key.length >= 32));
    assert.equal(await t.cli('rotate', 'cookies'), 0);
    const twice = configs(t);
    assert.deepEqual(twice.auth.cookieKeys.slice(1), [once.auth.cookieKeys[0]], 'a second rotation drops every older key');
    assert.deepEqual(twice.hub, before.hub);
    assert.deepEqual(t.calls, [recreate(t, 'auth')]);
    quiet(t);
  });

  it('rotate signing adds a new signing key first and keeps the previous one second for tokens still valid', async () => {
    const t = await initialized('crz');
    const [old] = configs(t).auth.jwks.keys;
    assert.equal(await t.cli('rotate', 'signing'), 0, t.err.join('\n'));
    const keys = configs(t).auth.jwks.keys;
    assert.equal(keys.length, 2);
    assert.deepEqual(keys[1], old);
    assert.notEqual(keys[0].kid, old.kid);
    assert.equal(keys[0].alg, 'RS256');
    assert.equal(keys[0].use, 'sig');
    assert.ok(keys[0].d, 'a private key');
    assert.match(t.err.join('\n'), /60 minutes/);
    assert.equal(await t.cli('rotate', 'signing'), 0);
    const again = configs(t).auth.jwks.keys;
    assert.equal(again.length, 2);
    assert.deepEqual(again[1], keys[0]);
    assert.deepEqual(t.calls, [recreate(t, 'auth')]);
    quiet(t);
  });

  it('refuses an unknown kind and reports a failed restart', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    assert.equal(await t.cli('rotate'), 2);
    assert.equal(await t.cli('rotate', 'everything'), 2);
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
    t.state.handler = argv => argv.includes('up') ? { code: 1, stdout: '', stderr: '' } : undefined;
    assert.equal(await t.cli('rotate', 'cookies'), 1);
    assert.match(t.err.join('\n'), /did not restart/);
  });
});

describe('services', () => {
  it('services add enables a manifest service in both configs, .env and the Caddyfile, and prints its host', async () => {
    const t = await initialized('crz');
    const before = configs(t);
    assert.equal(await t.cli('services', 'add', 'orsr'), 0, t.err.join('\n'));
    const after = configs(t);
    assert.equal(after.vars.LAWOSS_SERVICES, 'crz,orsr');
    assert.deepEqual(after.hub.services, ['crz', 'orsr']);
    assert.equal(after.hub.secrets.crz, before.hub.secrets.crz);
    const resource = after.auth.resources['https://orsr.example.com/mcp'];
    assert.deepEqual(resource, { name: 'Obchodný register', scope: 'mcp:tools', secretHash: hash(after.hub.secrets.orsr) });
    assert.match(readFileSync(join(t.root, 'Caddyfile'), 'utf8'), /^orsr\.example\.com \{\n\treverse_proxy hub:3000\n\}/m);
    assert.deepEqual(t.calls, [recreate(t)]);
    assert.deepEqual(t.out, ['orsr.example.com']);
    quiet(t);
  });

  it('services remove disables a service everywhere but refuses to remove the last one', async () => {
    const t = await initialized('crz,orsr');
    assert.equal(await t.cli('services', 'remove', 'crz'), 0, t.err.join('\n'));
    const after = configs(t);
    assert.equal(after.vars.LAWOSS_SERVICES, 'orsr');
    assert.deepEqual(after.hub.services, ['orsr']);
    assert.deepEqual(Object.keys(after.hub.secrets), ['orsr']);
    assert.deepEqual(Object.keys(after.auth.resources), ['https://orsr.example.com/mcp']);
    assert.doesNotMatch(readFileSync(join(t.root, 'Caddyfile'), 'utf8'), /crz\.example\.com/);
    assert.deepEqual(t.out, ['removed crz']);
    const env = readFileSync(join(t.root, '.env'));
    assert.equal(await t.cli('services', 'remove', 'orsr'), 1);
    assert.match(t.err.join('\n'), /last/);
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
  });

  it('refuses unknown, duplicate and absent services with a usage error and changes nothing', async () => {
    const t = await initialized('crz');
    const env = readFileSync(join(t.root, '.env'));
    assert.equal(await t.cli('services', 'add', 'crz'), 2);
    assert.equal(await t.cli('services', 'add', 'nope'), 2);
    assert.equal(await t.cli('services', 'remove', 'orsr'), 2);
    assert.equal(await t.cli('services', 'list'), 2);
    assert.deepEqual(readFileSync(join(t.root, '.env')), env);
    assert.equal(t.calls.length, 0);
  });
});
