import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exitLogLine, parseHubConfig, verifyRuntimes } from '../dist/main.js';
import { loadManifest } from '../dist/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const mainScript = join(here, '..', 'dist', 'main.js');
const manifest = loadManifest(join(here, '..', 'services.json'));
const scratch = mkdtempSync(join(tmpdir(), 'lawoss-main-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = text => createHash('sha256').update(text).digest('hex');
// Recognisable in output if a value were ever echoed.
const SENTINEL = 'SENTINEL-do-not-print-0123456789abcdef';
const secret = id => `${id}-${SENTINEL}`;
const config = (overrides = {}) => ({
  base: 'example.test',
  issuer: 'https://auth.example.test',
  services: ['crz'],
  secrets: { crz: secret('crz') },
  ...overrides,
});
const parse = value => parseHubConfig(JSON.stringify(value), manifest);

// A fetch-runtimes output with one runtime (the crz plugin) that matches its provenance.
function runtimes(label, mutate = () => {}) {
  const dir = join(scratch, `runtimes-${label}`);
  const plugin = join(dir, 'crz');
  mkdirSync(join(plugin, 'runtime', 'dist'), { recursive: true });
  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  const runtimeConfig = '{"name":"crz","entrypoint":"dist/index.js","minimumNode":"22.14.0"}\n';
  const index = 'console.log("crz");\n';
  writeFileSync(join(plugin, 'runtime-config.json'), runtimeConfig);
  writeFileSync(join(plugin, 'scripts', 'run.mjs'), '// launcher\n');
  writeFileSync(join(plugin, 'runtime', 'dist', 'index.js'), index);
  writeFileSync(join(plugin, 'runtime', 'provenance.json'), JSON.stringify({
    configSha256: sha256(runtimeConfig),
    files: { 'dist/index.js': sha256(index) },
  }));
  mutate(plugin);
  return dir;
}

// The entry point's environment: only what the image sets, plus the config under test.
const baseEnv = extra => ({
  PATH: process.env.PATH,
  LAWOSS_RUNTIMES_DIR: runtimes('env'),
  LAWOSS_CACHE_DIR: join(scratch, 'cache'),
  LAWOSS_DATA_DIR: join(scratch, 'data'),
  PORT: '0',
  ...extra,
});
const runMain = env => spawnSync(process.execPath, [mainScript], { env, encoding: 'utf8', timeout: 15_000 });

describe('hub entry point: configuration', () => {
  it('missing HUB_CONFIG_JSON exits non-zero with a clear message', () => {
    const result = runMain(baseEnv({}));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HUB_CONFIG_JSON is required/);
  });

  it('invalid HUB_CONFIG_JSON exits non-zero without printing any of its value', () => {
    const result = runMain(baseEnv({ HUB_CONFIG_JSON: `{"secrets":{"crz":"${SENTINEL}"` }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HUB_CONFIG_JSON is not valid JSON/);
    assert.ok(!result.stderr.includes(SENTINEL) && !result.stdout.includes(SENTINEL), 'no config value is printed');
  });

  it('a rejected config value is never printed', () => {
    const bad = config({ base: `${SENTINEL}..`, secrets: { crz: `short ${SENTINEL}` } });
    const result = runMain(baseEnv({ HUB_CONFIG_JSON: JSON.stringify(bad) }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HUB_CONFIG_JSON/);
    assert.ok(!result.stderr.includes(SENTINEL) && !result.stdout.includes(SENTINEL), 'no config value is printed');
  });

  it('maxPerService greater than maxTotal is rejected', () => {
    assert.throws(() => parse(config({ limits: { maxTotal: 4, maxPerService: 5 } })), /maxPerService must not exceed maxTotal/);
    assert.equal(parse(config({ limits: { maxTotal: 4, maxPerService: 4 } })).limits.maxPerService, 4);
  });

  it('allowHttpForTests is never accepted from the config', () => {
    assert.throws(() => parse(config({ allowHttpForTests: true })), /unknown field allowHttpForTests/);
  });

  it('the issuer is the bare HTTPS origin of auth.<base>', () => {
    assert.throws(() => parse(config({ issuer: 'http://auth.example.test' })), /issuer/);
    assert.throws(() => parse(config({ issuer: 'https://auth.example.test/' })), /issuer/);
    assert.throws(() => parse(config({ issuer: 'https://login.example.test' })), /issuer/);
  });

  it('services must be manifest services and secrets must match them exactly', () => {
    assert.throws(() => parse(config({ services: ['nope'], secrets: { nope: secret('nope') } })), /services/);
    assert.throws(() => parse(config({ services: ['crz', 'crz'], secrets: { crz: secret('crz') } })), /services/);
    assert.throws(() => parse(config({ services: ['crz', 'orsr'] })), /secrets/);
    assert.throws(() => parse(config({ secrets: { crz: secret('crz'), orsr: secret('orsr') } })), /secrets/);
    assert.throws(() => parse(config({ secrets: { crz: 'too-short' } })), /secrets/);
  });

  it('limits default to the documented values and must be positive integers', () => {
    assert.deepEqual(parse(config()).limits, {
      ratePerMinute: 30, perPrincipalConcurrency: 2, perServiceConcurrency: 4,
      maxTotal: 40, maxPerService: 8, idleMs: 600_000, callTimeoutMs: 120_000,
    });
    assert.throws(() => parse(config({ limits: { ratePerMinute: 0 } })), /ratePerMinute/);
    assert.throws(() => parse(config({ limits: { idleMs: 1.5 } })), /idleMs/);
    assert.throws(() => parse(config({ limits: { burst: 3 } })), /unknown field burst/);
  });
});

describe('hub entry point: runtimes are verified again at start', () => {
  it('a fetched runtime that matches its provenance passes', () => {
    assert.doesNotThrow(() => verifyRuntimes(runtimes('good'), manifest, ['crz']));
  });

  it('a changed, extra or missing runtime file fails the start', () => {
    assert.throws(() => verifyRuntimes(runtimes('changed', p => writeFileSync(join(p, 'runtime', 'dist', 'index.js'), 'x\n')),
      manifest, ['crz']), /crz: runtime file digest mismatch: dist\/index\.js/);
    assert.throws(() => verifyRuntimes(runtimes('extra', p => writeFileSync(join(p, 'runtime', 'dist', 'extra.js'), 'x\n')),
      manifest, ['crz']), /crz: runtime contains an unlisted file: dist\/extra\.js/);
    assert.throws(() => verifyRuntimes(runtimes('config', p => writeFileSync(join(p, 'runtime-config.json'), '{}\n')),
      manifest, ['crz']), /crz: runtime-config\.json digest mismatch/);
    assert.throws(() => verifyRuntimes(runtimes('launcher', p => rmSync(join(p, 'scripts', 'run.mjs'))),
      manifest, ['crz']), /crz: scripts\/run\.mjs/);
  });

  it('the entry point exits non-zero when a runtime does not verify', () => {
    const dir = runtimes('tampered', p => writeFileSync(join(p, 'runtime', 'dist', 'index.js'), 'x\n'));
    const result = runMain(baseEnv({ LAWOSS_RUNTIMES_DIR: dir, HUB_CONFIG_JSON: JSON.stringify(config()) }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest mismatch/);
  });
});

describe('hub entry point: serving', () => {
  const get = (port, path, host) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  it('starts, answers /health on loopback only, and serves enabled service hosts', async () => {
    const child = spawn(process.execPath, [mainScript], {
      env: baseEnv({ HUB_CONFIG_JSON: JSON.stringify(config()) }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const port = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', chunk => {
          out += chunk;
          const match = /"port":(\d+)/.exec(out);
          if (match) resolve(Number(match[1]));
        });
        child.on('exit', code => reject(new Error(`exited ${code}: ${stderr}`)));
      });
      assert.equal((await get(port, '/health', `127.0.0.1:${port}`)).status, 200);
      assert.equal((await get(port, '/health', 'crz.example.test')).status, 404, 'not reachable through a public host');
      assert.equal((await get(port, '/', 'unknown.example.test')).status, 404);
      const metadata = await get(port, '/.well-known/oauth-protected-resource/mcp', 'crz.example.test');
      assert.equal(metadata.status, 200);
      assert.equal(JSON.parse(metadata.body).resource, 'https://crz.example.test/mcp');
      assert.equal((await get(port, '/.well-known/oauth-protected-resource/mcp', 'orsr.example.test')).status, 404, 'disabled service');
      assert.ok(!stderr.includes(SENTINEL));
      // SIGTERM drains the pool and closes the server, then exits cleanly.
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      assert.deepEqual(await exited, { code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('runtime exit log lines carry the exit code and a principal hash, never the principal', () => {
    const principal = JSON.stringify(['https://crz.example.test/mcp', 'https://auth.example.test', 'alice', 'firm']);
    const line = JSON.parse(exitLogLine({ id: 'crz', principal, code: 3, signal: null }));
    assert.equal(line.event, 'runtime-exit');
    assert.equal(line.service, 'crz');
    assert.equal(line.code, 3);
    assert.equal(line.signal, null);
    assert.match(line.principal, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(line).includes('alice'));
  });
});

describe('hub entry point: --list-tools', () => {
  // The verified crz runtime whose launcher starts the echo fixture over stdio (SDK from hub/node_modules).
  const echoRuntimes = label => runtimes(label, plugin => writeFileSync(join(plugin, 'scripts', 'run.mjs'),
    `import ${JSON.stringify(pathToFileURL(join(here, 'fixtures', 'echo-runtime.mjs')).href)};\n`));
  const listTools = (args, env) => spawnSync(process.execPath, [mainScript, '--list-tools', ...args],
    { env, encoding: 'utf8', timeout: 30_000 });

  it('prints the tool names a runtime reports over stdio, without needing or printing HUB_CONFIG_JSON', () => {
    const result = listTools(['crz'], baseEnv({
      LAWOSS_RUNTIMES_DIR: echoRuntimes('list-tools'),
      HUB_CONFIG_JSON: JSON.stringify(config()),
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { service: 'crz', tools: ['env', 'exit', 'list', 'sleep', 'write'] });
    assert.ok(!result.stdout.includes(SENTINEL) && !result.stderr.includes(SENTINEL));
  });

  it('refuses an unknown service and a runtime that does not verify', () => {
    const unknown = listTools(['nope'], baseEnv({ LAWOSS_RUNTIMES_DIR: echoRuntimes('list-unknown') }));
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown service/);
    const bad = runtimes('list-bad', p => writeFileSync(join(p, 'runtime', 'dist', 'index.js'), 'x\n'));
    const failed = listTools(['crz'], baseEnv({ LAWOSS_RUNTIMES_DIR: bad }));
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /digest mismatch/);
  });
});
