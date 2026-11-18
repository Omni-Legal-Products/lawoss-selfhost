import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { principalKey } from '../dist/resource-auth.js';
import { routeHost } from '../dist/routing.js';
import { createHub } from '../dist/server.js';
import { BASE, fakePool, manifest, rpc, secrets, send, startHub, startIntrospection } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('resource adapter copy', () => {
  it('hub resource-auth.ts has the same SHA-256 as the upstream adapter', () => {
    const upstream = join(here, '..', '..', 'auth', 'resource-server', 'skallars-auth.ts');
    assert.equal(sha256File(join(here, '..', 'src', 'resource-auth.ts')), sha256File(upstream));
  });
});

describe('host routing (pure)', () => {
  const ids = new Set(['orsr', 'crz']);
  it('maps exactly <id>.<base> and nothing else', () => {
    assert.equal(routeHost('orsr.example.test', BASE, ids), 'orsr');
    assert.equal(routeHost('crz.example.test', BASE, ids), 'crz');
    for (const host of [undefined, '', 'example.test', 'CRZ.example.test', 'crz.Example.Test', 'rpo.example.test', 'orsr.example.test:8443',
      'orsr.example.test.evil.test', 'x.orsr.example.test', 'constructor.example.test', '__proto__.example.test',
      'orsr.example.test.', 'orsr.example.com'])
      assert.equal(routeHost(host, BASE, ids), undefined, String(host));
  });
});

describe('hub routing and authentication', () => {
  let introspection, pool, hub;
  before(async () => {
    introspection = await startIntrospection();
    pool = fakePool();
    hub = await startHub({ issuer: introspection.issuer, pool, log: () => {} });
  });
  after(async () => {
    await hub.close();
    await pool.close();
    await introspection.close();
  });

  it('unknown host returns 404', async () => {
    // rpo is in the manifest but has no secret, so it is not enabled.
    for (const host of ['nope.example.test', BASE, 'rpo.example.test', 'orsr.example.test:8443',
      'orsr.example.test.evil.test', 'constructor.example.test', '127.0.0.1', `ORSR.${BASE}`, 'orsr.EXAMPLE.test']) {
      for (const path of ['/mcp', '/.well-known/oauth-protected-resource/mcp'])
        assert.equal((await send(hub.port, { host, path })).status, 404, `${host}${path}`);
    }
  });

  it('metadata on both well-known paths names the issuer and https://<id>.<base>/mcp', async () => {
    for (const id of ['orsr', 'crz']) {
      for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const response = await send(hub.port, { host: `${id}.${BASE}`, path });
        assert.equal(response.status, 200, path);
        const metadata = JSON.parse(response.text);
        assert.equal(metadata.resource, `https://${id}.${BASE}/mcp`);
        assert.deepEqual(metadata.authorization_servers, [introspection.issuer]);
      }
    }
  });

  it('missing token returns 401 with WWW-Authenticate challenge', async () => {
    for (const method of ['POST', 'GET']) {
      const response = await send(hub.port, { host: `orsr.${BASE}`, method, path: '/mcp',
        body: method === 'POST' ? { jsonrpc: '2.0', id: 1, method: 'tools/list' } : undefined });
      assert.equal(response.status, 401, method);
      assert.equal(response.headers['www-authenticate'],
        `Bearer resource_metadata="https://orsr.${BASE}/.well-known/oauth-protected-resource/mcp"`);
    }
    assert.equal(pool.clientCalls.length, 0);
  });

  it('token for orsr is refused on crz host', async () => {
    introspection.issue('orsr-token', 'orsr');
    const refused = await rpc(hub.port, 'crz', 'orsr-token', 'tools/list');
    assert.equal(refused.status, 401);
    assert.match(refused.headers['www-authenticate'], /crz\.example\.test/);
    assert.equal(pool.clientCalls.length, 0, 'the runtime pool is not reached');
    const accepted = await rpc(hub.port, 'orsr', 'orsr-token', 'tools/list');
    assert.equal(accepted.status, 200);
    assert.deepEqual(pool.clientCalls.map(call => call.id), ['orsr']);
  });

  it('a foreign Origin fails the adapter request check with 403', async () => {
    introspection.issue('origin-token', 'orsr');
    const foreign = await rpc(hub.port, 'orsr', 'origin-token', 'tools/list', {}, { origin: 'https://evil.example.com' });
    assert.equal(foreign.status, 403);
  });

  it('the runtime is selected by the verified principal, never by client headers', async () => {
    const identity = introspection.issue('judikaty-token', 'judikaty', 'user-7');
    const before = pool.clientCalls.length;
    const response = await rpc(hub.port, 'judikaty', 'judikaty-token', 'tools/list', {},
      { 'x-principal': 'someone-else', 'x-forwarded-user': 'admin', 'mcp-session-id': 'spoofed' });
    assert.equal(response.status, 200);
    assert.deepEqual(pool.clientCalls.slice(before), [{
      principal: principalKey({ ...identity, scope: 'mcp:tools', exp: 0 }), id: 'judikaty',
    }]);
  });

  it('initialize succeeds over stateless Streamable HTTP without a session id', async () => {
    introspection.issue('init-token', 'crz');
    const response = await rpc(hub.port, 'crz', 'init-token', 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['mcp-session-id'], undefined);
    assert.ok(response.message.result.capabilities.tools);
  });

  it('non-POST methods on /mcp return 405 after authentication', async () => {
    introspection.issue('get-token', 'crz');
    const response = await send(hub.port, { host: `crz.${BASE}`, path: '/mcp', headers: { authorization: 'Bearer get-token' } });
    assert.equal(response.status, 405);
  });
});

describe('hub configuration', () => {
  const pool = fakePool();
  const issuer = 'https://auth.example.test';
  it('refuses a secret for a service absent from the manifest', () => {
    assert.throws(() => createHub({ base: BASE, issuer, manifest, pool, secrets: { ...secrets, nope: 'n'.repeat(40) } }),
      /nope/);
  });
  it('refuses a short secret and an HTTP issuer without the test flag', () => {
    assert.throws(() => createHub({ base: BASE, issuer, manifest, pool, secrets: { orsr: 'short' } }));
    assert.throws(() => createHub({ base: BASE, issuer: 'http://127.0.0.1:1', manifest, pool, secrets }));
  });
});
