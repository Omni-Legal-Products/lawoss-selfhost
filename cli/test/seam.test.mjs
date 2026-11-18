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
async function startAuth(config) {
  const auth = createAuth({ ...config, dataDir: join(scratch, `auth-${counter++}`) });
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

describe('configuration seam between the CLI, the hub and auth', () => {
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
