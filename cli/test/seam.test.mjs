// The configuration seam: what init, rotate and services write into .env must be accepted by the
// real hub (parseHubConfig) and the real auth server (createAuth), and the hub's introspection
// secret must open auth's introspection endpoint. Imports hub/dist and auth/dist, so both must be
// built first (npm ci --ignore-scripts && npm run build in hub/ and auth/; CI does it).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkIntrospection, parseHubConfig } from '../../hub/dist/main.js';
import { loadManifest } from '../../hub/dist/manifest.js';
import { createAuth } from '../../auth/dist/server.js';
import { readEnvFile } from '../lib.mjs';
import { initialized, repo } from './helpers.mjs';

const manifest = loadManifest(join(repo, 'hub', 'services.json'));
const scratch = mkdtempSync(join(tmpdir(), 'lawoss-seam-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

/** Starts the real auth server for the deployment's AUTH_CONFIG_JSON, with its data in a temporary directory. */
async function startAuth(config, dataDir = join(scratch, `auth-${counter++}`)) {
  const auth = createAuth({ ...config, dataDir });
  const server = auth.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    port: server.address().port,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }).finally(() => auth.close()),
  };
}

/**
 * The fetch the hub's check uses, sent to the local auth as the proxy would forward it: the public
 * Host and X-Forwarded-Proto https.
 */
const viaProxy = (port, host) => (url, init) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const req = request({ host: '127.0.0.1', port, method: init.method, path: target.pathname,
    headers: { ...init.headers, host, 'x-forwarded-proto': 'https' } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: { 'content-type': res.headers['content-type'] ?? '' } })));
  });
  req.on('error', reject);
  req.end(init.body);
});

async function assertSeam(t) {
  const vars = readEnvFile(join(t.root, '.env'));
  const hub = parseHubConfig(vars.HUB_CONFIG_JSON, manifest);
  assert.deepEqual(hub.services, vars.LAWOSS_SERVICES.split(','));
  const auth = await startAuth(JSON.parse(vars.AUTH_CONFIG_JSON));
  try {
    const results = await checkIntrospection(hub, { fetch: viaProxy(auth.port, `auth.${hub.base}`) });
    assert.deepEqual(results, Object.fromEntries(hub.services.map(id => [id, 'ok'])));
    // And a secret auth does not hold is refused.
    const wrong = { ...hub, secrets: Object.fromEntries(hub.services.map(id => [id, `wrong-${'x'.repeat(40)}`])) };
    const refused = await checkIntrospection(wrong, { fetch: viaProxy(auth.port, `auth.${hub.base}`) });
    assert.deepEqual(refused, Object.fromEntries(hub.services.map(id => [id, 'secret-mismatch'])));
  } finally {
    await auth.close();
  }
}

/** One request to the local auth as the proxy forwards it; redirects are not followed. */
const toAuth = (port, { method = 'GET', path, body, type }) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path,
    headers: { host: 'auth.example.com', 'x-forwarded-proto': 'https', ...(type ? { 'content-type': type } : {}) } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(body);
});

/** What Claude's hosted apps send: a public client with their exact web callback. */
const claudeRegistration = redirect => JSON.stringify({
  client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
});

describe('configuration seam between the CLI, the hub and auth', () => {
  it('auth registers Claude with its web callback and starts the sign-in, and still refuses other web callbacks', async () => {
    const t = await initialized('crz');
    const auth = await startAuth(JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON));
    try {
      const callback = 'https://claude.ai/api/mcp/auth_callback';
      const registered = await toAuth(auth.port, { method: 'POST', path: '/reg', type: 'application/json', body: claudeRegistration(callback) });
      assert.equal(registered.status, 201, registered.body);
      const client = JSON.parse(registered.body);
      assert.deepEqual(client.redirect_uris, [callback]);
      const refused = await toAuth(auth.port, { method: 'POST', path: '/reg', type: 'application/json',
        body: claudeRegistration('https://app.example.org/oauth/callback') });
      assert.equal(refused.status, 400, refused.body);
      // The authorization request goes on to sign-in instead of failing on the callback.
      const query = new URLSearchParams({
        client_id: client.client_id, redirect_uri: callback, response_type: 'code', scope: 'mcp:tools', state: 'seam',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', resource: 'https://crz.example.com/mcp',
      });
      const authorize = await toAuth(auth.port, { path: `/auth?${query}` });
      assert.equal(authorize.status, 303, authorize.body);
      assert.match(authorize.headers.location ?? '', /\/interaction\//);
    } finally {
      await auth.close();
    }
  });

  it('after callbacks remove, a client registered with that callback cannot start a sign-in any more', async () => {
    const t = await initialized('crz');
    const dataDir = join(scratch, `auth-${counter++}`);
    const callback = 'https://claude.ai/api/mcp/auth_callback';
    const authorizePath = clientId => `/auth?${new URLSearchParams({
      client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'mcp:tools', state: 'seam',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', resource: 'https://crz.example.com/mcp',
    })}`;
    let clientId;
    let auth = await startAuth(JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON), dataDir);
    try {
      const registered = await toAuth(auth.port, { method: 'POST', path: '/reg', type: 'application/json', body: claudeRegistration(callback) });
      assert.equal(registered.status, 201, registered.body);
      clientId = JSON.parse(registered.body).client_id;
    } finally {
      await auth.close();
    }
    assert.equal(await t.cli('callbacks', 'remove', callback), 0, t.err.join('\n'));
    auth = await startAuth(JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON), dataDir);
    try {
      const authorize = await toAuth(auth.port, { path: authorizePath(clientId) });
      assert.equal(authorize.status, 400, authorize.body);
    } finally {
      await auth.close();
    }
  });


  it('init writes configurations that the real hub and auth accept, with matching introspection secrets', async () => {
    await assertSeam(await initialized('crz,orsr'));
  });

  it('they still agree after rotate introspection, cookies and signing, and services add and remove', async () => {
    const t = await initialized('crz,orsr');
    for (const step of [['rotate', 'introspection'], ['rotate', 'cookies'], ['rotate', 'signing'], ['services', 'add', 'judikaty'],
      ['services', 'remove', 'crz']]) {
      assert.equal(await t.cli(...step), 0, `${step.join(' ')}: ${t.err.join('\n')}`);
      await assertSeam(t);
    }
  });
});
