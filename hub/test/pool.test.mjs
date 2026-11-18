import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RetryableError } from '../dist/limits.js';
import { loadManifest } from '../dist/manifest.js';
import { DEFAULT_POOL, ProcessPool, allowlistedEnv } from '../dist/pool.js';
import { principalKey } from '../dist/resource-auth.js';
import { TIMEOUT_TEXT } from '../dist/server.js';
import { fakePool, manifest as hubManifest, rpc, startHub, startIntrospection } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const COMMIT = 'e0681bb4a79c1dd415d7c47944dfc1894e77672b';
const tools = { env: 'allow', write: 'allow', list: 'allow', sleep: 'allow', exit: 'allow' };
const manifest = {
  catalogCommit: COMMIT,
  services: {
    echo: { plugin: 'echo', tools, env: ['ECHO_TOKEN'], stateEnv: 'ECHO_STATE_DIR' },
    other: { plugin: 'echo', tools, env: [] },
    crash: { plugin: 'crash', tools, env: [] },
  },
};
// Principals as principalKey() builds them: JSON with slashes and quotes, never usable as a path.
const principal = sub => JSON.stringify(['https://echo.example.test/mcp', 'https://auth.example.test', sub, 'firm']);
const A = principal('alice');
const B = principal('bob');
const C = principal('carol');

const scratch = mkdtempSync(join(tmpdir(), 'lawoss-pool-'));
const runtimesDir = join(scratch, 'runtimes');
const cacheDir = join(scratch, 'cache');
let dataCount = 0;
const newDataDir = () => join(scratch, `data-${++dataCount}`);
// The launcher layout <runtimesDir>/<plugin>/scripts/run.mjs; the shim imports the fixture by URL
// so that the SDK resolves from hub/node_modules.
mkdirSync(join(runtimesDir, 'echo', 'scripts'), { recursive: true });
writeFileSync(join(runtimesDir, 'echo', 'scripts', 'run.mjs'),
  `import ${JSON.stringify(pathToFileURL(join(here, 'fixtures', 'echo-runtime.mjs')).href)};\n`);
// A runtime that dies before it answers initialize.
mkdirSync(join(runtimesDir, 'crash', 'scripts'), { recursive: true });
writeFileSync(join(runtimesDir, 'crash', 'scripts', 'run.mjs'), 'process.exit(7);\n');
after(() => rmSync(scratch, { recursive: true, force: true }));

const pools = [];
function makePool(overrides = {}) {
  const pool = new ProcessPool({
    runtimesDir, dataDir: newDataDir(), cacheDir, manifest,
    maxTotal: 10, maxPerService: 10, idleMs: 60_000,
    envFor: allowlistedEnv(manifest, { ECHO_TOKEN: 'echo-value', UNLISTED_SECRET: 'nope' }),
    ...overrides,
  });
  pools.push(pool);
  return pool;
}
// Every test's processes are stopped so that no child or timer outlives the suite.
after(async () => {
  for (const pool of pools) for (const p of [A, B, C]) await pool.stopPrincipal(p);
});

async function call(pool, who, id, name, args = {}) {
  const client = await pool.client(who, id);
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// Polls without timers, so that it also works while setTimeout is mocked.
async function until(condition, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe('process pool', () => {
  it('two principals get different processes and different working directories', async () => {
    const dataDir = newDataDir();
    const pool = makePool({ dataDir });
    const a = await call(pool, A, 'echo', 'env');
    const b = await call(pool, B, 'echo', 'env');
    assert.notEqual(a.pid, b.pid);
    assert.notEqual(a.cwd, b.cwd);
    for (const [who, info] of [[A, a], [B, b]]) {
      const dir = join(dataDir, sha256(who), 'echo');
      assert.equal(info.cwd, realpathSync(dir));
      for (const key of ['HOME', 'TMPDIR', 'ECHO_STATE_DIR', 'LAWOSS_STATE_DIR']) assert.equal(info.env[key], dir, key);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(dirname(dir)).mode & 0o777, 0o700);
    }
    // The raw principal never appears in a path.
    assert.deepEqual(readdirSync(dataDir).sort(), [sha256(A), sha256(B)].sort());
    // The same principal and service reuse the process.
    assert.equal((await call(pool, A, 'echo', 'env')).pid, a.pid);
    assert.equal(pool.size(), 2);
  });

  it("a principal cannot read a file the other principal's process wrote", async () => {
    const pool = makePool();
    assert.equal(await call(pool, A, 'echo', 'write', { name: 'watchlist.json', content: 'private' }), 'written');
    assert.deepEqual(await call(pool, B, 'echo', 'list'), []);
    assert.deepEqual(await call(pool, A, 'echo', 'list'), ['watchlist.json']);
    // A service without stateEnv uses its working directory, which is equally separate.
    assert.equal(await call(pool, A, 'other', 'write', { name: 'note.txt' }), 'written');
    assert.deepEqual(await call(pool, B, 'other', 'list'), []);
  });

  it('idle process stops after idleMs', async () => {
    assert.equal(DEFAULT_POOL.idleMs, 10 * 60_000);
    const pool = makePool({ idleMs: DEFAULT_POOL.idleMs });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { pid } = await call(pool, A, 'echo', 'env');
      mock.timers.tick(DEFAULT_POOL.idleMs - 1);
      assert.equal(pool.size(), 1);
      // Every call resets the idle timer.
      assert.equal((await call(pool, A, 'echo', 'env')).pid, pid);
      mock.timers.tick(DEFAULT_POOL.idleMs - 1);
      assert.equal(pool.size(), 1);
      mock.timers.tick(1);
      assert.equal(pool.size(), 0);
      await until(() => !alive(pid), 'the idle process to exit');
    } finally {
      mock.timers.reset();
    }
  });

  it('maxTotal evicts the least recently used idle process', async () => {
    const pool = makePool({ maxTotal: 2 });
    const a = await call(pool, A, 'echo', 'env');
    const b = await call(pool, B, 'other', 'env');
    await call(pool, A, 'echo', 'env'); // A is now more recently used than B.
    const c = await call(pool, C, 'echo', 'env');
    assert.equal(pool.size(), 2);
    await until(() => !alive(b.pid), 'the least recently used process to stop');
    assert.ok(alive(a.pid) && alive(c.pid));
    assert.equal((await call(pool, A, 'echo', 'env')).pid, a.pid);
  });

  it('when both caps are reached only a same-service process stops', async () => {
    const pool = makePool({ maxTotal: 2, maxPerService: 1 });
    const b = await call(pool, B, 'other', 'env'); // Globally least recently used.
    const a = await call(pool, A, 'echo', 'env');
    await call(pool, C, 'echo', 'env');
    await until(() => !alive(a.pid), 'the same-service process to stop');
    assert.equal(pool.size(), 2);
    // B's process was not evicted: the pool still hands out the same one.
    assert.equal((await call(pool, B, 'other', 'env')).pid, b.pid);
  });

  it('maxPerService evicts only within the service', async () => {
    const pool = makePool({ maxPerService: 1 });
    const a = await call(pool, A, 'echo', 'env');
    const b = await call(pool, B, 'other', 'env');
    const c = await call(pool, C, 'echo', 'env');
    await until(() => !alive(a.pid), 'the same-service process to stop');
    assert.ok(alive(b.pid) && alive(c.pid));
    assert.equal(pool.size(), 2);
  });

  it('a full pool with no idle process refuses with RetryableError', async () => {
    const pool = makePool({ maxTotal: 1 });
    const client = await pool.client(A, 'echo');
    const busy = client.callTool({ name: 'sleep', arguments: { ms: 300 } });
    await assert.rejects(pool.client(B, 'echo'), RetryableError);
    await busy;
    // Once the call is done the process is idle and can be evicted.
    await call(pool, B, 'echo', 'env');
    assert.equal(pool.size(), 1);
  });

  it('a leased process with no request in flight is not evicted at capacity', async () => {
    const pool = makePool({ maxTotal: 1, idleMs: 50 });
    const lease = await pool.lease(A, 'echo');
    const { pid } = JSON.parse((await lease.client.callTool({ name: 'env', arguments: {} })).content[0].text);
    // Between two requests of one hub call: nothing in flight, but the lease is held.
    await assert.rejects(pool.client(B, 'echo'), RetryableError);
    // Nor does the idle timer stop it while leased.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(pool.size(), 1);
    assert.equal(JSON.parse((await lease.client.callTool({ name: 'env', arguments: {} })).content[0].text).pid, pid);
    lease.release();
    lease.release(); // Idempotent.
    await call(pool, B, 'echo', 'env');
    await until(() => !alive(pid), 'the released process to be evicted');
  });

  it('a failed close on idle stop or eviction is contained and the entry is removed', async () => {
    const rejections = [];
    const onRejection = reason => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    const pids = [];
    try {
      const failClose = client => { client.close = async () => { throw new Error('close failed'); }; };
      // Idle stop.
      const idle = makePool({ idleMs: 50 });
      failClose(await idle.client(A, 'echo'));
      pids.push((await call(idle, A, 'echo', 'env')).pid);
      await until(() => idle.size() === 0, 'the idle entry to be removed');
      // Eviction at capacity: the new process still starts.
      const full = makePool({ maxTotal: 1 });
      failClose(await full.client(A, 'echo'));
      pids.push((await call(full, A, 'echo', 'env')).pid);
      const b = await call(full, B, 'echo', 'env');
      assert.notEqual(b.pid, pids[1]);
      assert.equal(full.size(), 1);
      // stopPrincipal does not reject either.
      failClose(await full.client(B, 'echo'));
      await full.stopPrincipal(B);
      pids.push(b.pid);
      assert.equal(full.size(), 0);
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
      // close() was replaced, so these children were never told to stop.
      for (const pid of pids) { try { process.kill(pid); } catch {} }
    }
  });

  it('concurrent first calls share one process', async () => {
    const pool = makePool();
    const [x, y] = await Promise.all([call(pool, A, 'echo', 'env'), call(pool, A, 'echo', 'env')]);
    assert.equal(x.pid, y.pid);
    assert.equal(pool.size(), 1);
  });

  it('a crashed process is removed and the next client() starts a fresh one', async () => {
    const pool = makePool();
    const { pid } = await call(pool, A, 'echo', 'env');
    await assert.rejects(call(pool, A, 'echo', 'exit'));
    await until(() => pool.size() === 0, 'the crashed process to leave the pool');
    const fresh = await call(pool, A, 'echo', 'env');
    assert.notEqual(fresh.pid, pid);
  });

  it('reports each runtime exit with its code or signal', async () => {
    const exits = [];
    const pool = makePool({ onExit: event => exits.push(event) });
    await assert.rejects(call(pool, A, 'echo', 'exit'));
    await until(() => exits.length === 1, 'the crash to be reported');
    assert.deepEqual(exits[0], { id: 'echo', principal: A, code: 3, signal: null });
    await call(pool, B, 'other', 'env');
    await pool.stopPrincipal(B);
    await until(() => exits.length === 2, 'the stop to be reported');
    assert.equal(exits[1].id, 'other');
    assert.equal(exits[1].principal, B);
    assert.ok(exits[1].code !== null || exits[1].signal !== null);
  });

  it('reports a runtime that exits during start-up', async () => {
    const exits = [];
    const pool = makePool({ onExit: event => exits.push(event) });
    await assert.rejects(pool.lease(A, 'crash'));
    await until(() => exits.length === 1, 'the start-up crash to be reported');
    assert.deepEqual(exits[0], { id: 'crash', principal: A, code: 7, signal: null });
    assert.equal(pool.size(), 0);
  });

  it('stopAll closes every process of every principal', async () => {
    const pool = makePool();
    const a = await call(pool, A, 'echo', 'env');
    const b = await call(pool, B, 'other', 'env');
    await pool.stopAll();
    assert.equal(pool.size(), 0);
    await until(() => !alive(a.pid) && !alive(b.pid), 'all processes to exit');
  });

  it('stopPrincipal closes every process of that principal', async () => {
    const pool = makePool();
    const a1 = await call(pool, A, 'echo', 'env');
    const a2 = await call(pool, A, 'other', 'env');
    const b = await call(pool, B, 'echo', 'env');
    await pool.stopPrincipal(A);
    assert.equal(pool.size(), 1);
    await until(() => !alive(a1.pid) && !alive(a2.pid), "the principal's processes to exit");
    assert.ok(alive(b.pid));
  });

  it('env contains only allowlisted keys plus PATH, HOME, TMPDIR, LAWOSS_CACHE_DIR', async () => {
    // Keys the SDK would inherit by default, plus an arbitrary hub variable, must not reach the runtime.
    const saved = { USER: process.env.USER, SHELL: process.env.SHELL, LAWOSS_LEAK_PROBE: process.env.LAWOSS_LEAK_PROBE };
    Object.assign(process.env, { USER: 'hub-user', SHELL: '/bin/sh', LAWOSS_LEAK_PROBE: 'leak' });
    try {
      const dataDir = newDataDir();
      const envFor = id => ({ ...allowlistedEnv(manifest, { ECHO_TOKEN: 'echo-value', UNLISTED_SECRET: 'nope' })(id), HOME: '/elsewhere' });
      const pool = makePool({ dataDir, envFor, path: '/usr/bin:/bin' });
      const { env } = await call(pool, A, 'echo', 'env');
      // The launcher variable LAWOSS_STATE_DIR and the service's stateEnv point at the principal's directory.
      const expected = ['ECHO_STATE_DIR', 'ECHO_TOKEN', 'HOME', 'LAWOSS_CACHE_DIR', 'LAWOSS_STATE_DIR', 'PATH', 'TMPDIR'];
      // macOS adds this one to every process it starts.
      const keys = Object.keys(env).filter(key => !(process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING'));
      assert.deepEqual(keys.sort(), expected);
      assert.equal(env.ECHO_TOKEN, 'echo-value');
      assert.equal(env.PATH, '/usr/bin:/bin');
      assert.equal(env.LAWOSS_CACHE_DIR, cacheDir);
      assert.equal(env.HOME, join(dataDir, sha256(A), 'echo'), 'pool-set keys win over envFor');
      const other = await call(pool, A, 'other', 'env');
      assert.deepEqual(Object.keys(other.env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort(),
        ['HOME', 'LAWOSS_CACHE_DIR', 'LAWOSS_STATE_DIR', 'PATH', 'TMPDIR']);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('allowlistedEnv passes only the manifest env names that are set', () => {
    const envFor = allowlistedEnv({ ...manifest, services: { ...manifest.services, x: { plugin: 'x', tools, env: ['A_KEY', 'B_KEY'] } } },
      { A_KEY: 'a', OTHER: 'o' });
    assert.deepEqual(envFor('x'), { A_KEY: 'a' });
    assert.deepEqual(envFor('other'), {});
  });

  const runtimes = process.env.LAWOSS_RUNTIMES_DIR;
  it('runtime starts with PATH lacking npm and network disabled', {
    skip: runtimes && process.env.LAWOSS_CACHE_DIR ? false
      : 'set LAWOSS_RUNTIMES_DIR and a warm LAWOSS_CACHE_DIR to run this integration test',
    timeout: 120_000,
  }, async () => {
    const real = loadManifest(join(here, '..', 'services.json'));
    assert.equal(real.services.crz.plugin, 'crz');
    const emptyPath = mkdtempSync(join(scratch, 'path-'));
    assert.ok(!existsSync(join(emptyPath, 'npm')));
    const dataDir = newDataDir();
    const pool = makePool({
      runtimesDir: runtimes, cacheDir: process.env.LAWOSS_CACHE_DIR, manifest: real, dataDir, path: emptyPath,
      // Approximation of a disabled network: unreachable proxies and offline npm.
      envFor: () => ({ HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', npm_config_offline: 'true' }),
    });
    try {
      const client = await pool.client(A, 'crz');
      const { tools: listed } = await client.listTools();
      assert.ok(listed.some(tool => tool.name === 'crz_search'), 'CRZ lists its tools');
      // The launcher's state directory and the service's own cache are inside the principal's directory.
      const dir = join(dataDir, sha256(A), 'crz');
      assert.ok(statSync(join(dir, 'crz')).isDirectory(), 'launcher state under the principal directory');
      assert.ok(!existsSync(join(process.env.LAWOSS_CACHE_DIR, 'crz', 'state')), 'no state in the shared cache');
    } finally {
      await pool.stopPrincipal(A);
    }
  });
});

describe('hub over a real process pool', () => {
  it('proxies tools/call to the runtime process and applies the call timeout', async () => {
    const introspection = await startIntrospection();
    // judikaty served by the echo runtime, so the hub talks to a real stdio process.
    const echoManifest = { ...hubManifest, services: { ...hubManifest.services, judikaty: { plugin: 'echo', tools, env: [] } } };
    const pool = makePool({ manifest: echoManifest });
    const hub = await startHub({ issuer: introspection.issuer, pool, log: () => {}, manifest: echoManifest, callTimeoutMs: 200 });
    const identity = introspection.issue('real-pool-token', 'judikaty', 'frank');
    try {
      const env = await rpc(hub.port, 'judikaty', 'real-pool-token', 'tools/call', { name: 'env', arguments: {} });
      const info = JSON.parse(env.message.result.content[0].text);
      assert.equal(info.env.HOME, join(dirname(dirname(info.env.HOME)), sha256(principalKey(identity)), 'judikaty'));
      const slow = await rpc(hub.port, 'judikaty', 'real-pool-token', 'tools/call', { name: 'sleep', arguments: { ms: 1000 } });
      assert.equal(slow.message.error.message, TIMEOUT_TEXT);
      // The process survives a timed-out call and keeps serving.
      const again = await rpc(hub.port, 'judikaty', 'real-pool-token', 'tools/call', { name: 'env', arguments: {} });
      assert.equal(JSON.parse(again.message.result.content[0].text).pid, info.pid);
    } finally {
      await pool.stopPrincipal(principalKey(identity));
      await hub.close();
      await introspection.close();
    }
  });
});

describe('hub and pool', () => {
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

  it('disabled principal: introspection inactive → stopPrincipal called and request 401', async () => {
    const identity = introspection.issue('disabled-token', 'judikaty', 'dave');
    assert.equal((await rpc(hub.port, 'judikaty', 'disabled-token', 'tools/list')).status, 200);
    introspection.revoke('disabled-token');
    const response = await rpc(hub.port, 'judikaty', 'disabled-token', 'tools/list');
    assert.equal(response.status, 401);
    assert.deepEqual(pool.stopped, [principalKey(identity)]);
  });

  it('an unknown inactive token stops nothing', async () => {
    pool.stopped.length = 0;
    assert.equal((await rpc(hub.port, 'judikaty', 'never-seen-token', 'tools/list')).status, 401);
    assert.deepEqual(pool.stopped, []);
  });

  it('a token remembered for one service does not stop a principal on another host', async () => {
    pool.stopped.length = 0;
    introspection.issue('orsr-only-token', 'orsr', 'erin');
    assert.equal((await rpc(hub.port, 'orsr', 'orsr-only-token', 'tools/list')).status, 200);
    // The same token sent to crz is inactive there (wrong audience), but is not known for crz.
    assert.equal((await rpc(hub.port, 'crz', 'orsr-only-token', 'tools/list')).status, 401);
    assert.deepEqual(pool.stopped, []);
  });
});
