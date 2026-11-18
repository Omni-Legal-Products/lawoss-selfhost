// Test harness: a temporary LAWOSS_ROOT laid out like /opt/lawoss, a fake runner that records every
// argument vector, a recorded chown and fake doctor probes. Nothing here runs Docker or needs root.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../lawoss-selfhost.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, '..', '..');
/** The committed example record (all-zero digests); only the schema test reads it. */
export const RECORD = join(here, 'fixtures', 'release-0.0.0.json');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const zeroImages = {
  auth: `lawoss-auth@sha256:${'0'.repeat(64)}`,
  hub: `lawoss-hub@sha256:${'0'.repeat(64)}`,
  proxy: `caddy@sha256:${'0'.repeat(64)}`,
};

/** The host files installed under root, as a release record lists them. */
export function hostFiles(root) {
  const files = {};
  const add = path => { files[path] = sha256(readFileSync(join(root, path))); };
  for (const name of ['compose.yaml', 'services.json', 'Caddyfile.template']) add(name);
  const walk = dir => {
    for (const name of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${name.name}`;
      if (name.isDirectory()) walk(path); else add(path);
    }
  };
  walk('bin');
  return files;
}

/** Writes a release record for the files currently under root, outside root; returns path and digest. */
export function writeRecord(root, fields = {}) {
  const record = {
    version: '0.0.0',
    commit: '0'.repeat(40),
    images: zeroImages,
    files: hostFiles(root),
    note: 'Placeholder release for tests.',
    ...fields,
  };
  const dir = mkdtempSync(join(tmpdir(), 'lawoss-record-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, `release-${record.version}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { path, sha: sha256(readFileSync(path)), record };
}
/** Any base64url-ish run this long would be a key, secret or link token. */
export const SECRETISH = /[A-Za-z0-9_-]{32,}/;
export const SENTINEL = 'SENTINEL-do-not-print-0123456789abcdef';

const manifest = JSON.parse(readFileSync(join(repo, 'hub', 'services.json'), 'utf8'));
export const toolsOf = id => Object.keys(manifest.services[id].tools).sort();

/** A healthy deployment as the fake probes see it. */
export function healthyProbes(base) {
  const issuer = `https://auth.${base}`;
  return {
    async resolve() { return ['127.0.0.1']; },
    async tls() { return { authorized: true, validTo: new Date('2027-01-01T00:00:00Z') }; },
    async fetch(url, init = {}) {
      const { hostname, pathname } = new URL(url);
      const json = body => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body });
      if (hostname === `auth.${base}` && pathname === '/.well-known/oauth-authorization-server') return json({ issuer });
      if (pathname === '/.well-known/oauth-protected-resource/mcp')
        return json({ resource: `https://${hostname}/mcp`, authorization_servers: [issuer] });
      if (pathname === '/mcp' && (init.method ?? 'GET') === 'POST')
        return {
          status: 401,
          headers: new Headers({ 'www-authenticate': `Bearer resource_metadata="https://${hostname}/.well-known/oauth-protected-resource/mcp"` }),
          json: async () => ({}),
        };
      return { status: 404, headers: new Headers(), json: async () => ({}) };
    },
  };
}

/** The hub's `--check-introspection` answer: every enabled service (from .env) passes unless overridden. */
export function introspectionAnswer(root, overrides = {}) {
  const services = /^LAWOSS_SERVICES=(.*)$/m.exec(readFileSync(join(root, '.env'), 'utf8'))?.[1].split(',') ?? [];
  const introspection = Object.fromEntries(services.map(id => [id, overrides[id] ?? 'ok']));
  const passed = Object.values(introspection).every(result => result === 'ok');
  return { code: passed ? 0 : 1, stdout: `${JSON.stringify({ introspection })}\n`, stderr: '' };
}

/** The hub's `--manifest-sha256` answer: the image carries the host's services.json unless told otherwise. */
export const manifestAnswer = (root, digest = sha256(readFileSync(join(root, 'services.json')))) =>
  ({ code: 0, stdout: `${JSON.stringify({ manifestSha256: digest })}\n`, stderr: '' });

/** The hub's `--list-tools` answer for a service, as the fake runner returns it. */
export const listToolsAnswer = (id, tools = toolsOf(id)) => ({ code: 0, stdout: `${JSON.stringify({ service: id, tools })}\n`, stderr: '' });

/**
 * A fresh root with compose.yaml, Caddyfile.template and services.json installed, and a context
 * whose runner answers through `handler(argv)` (default: success, and the manifest's tools for
 * `--list-tools`).
 */
export function setup({ handler, probes, base = 'example.com' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lawoss-cli-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(join(repo, 'deploy', 'compose.yaml'), join(root, 'compose.yaml'));
  copyFileSync(join(repo, 'deploy', 'Caddyfile.template'), join(root, 'Caddyfile.template'));
  copyFileSync(join(repo, 'hub', 'services.json'), join(root, 'services.json'));
  // The CLI as installed in <root>/bin: every file of cli/ and cli/commands/ (not the tests).
  mkdirSync(join(root, 'bin', 'commands'), { recursive: true });
  for (const entry of readdirSync(join(repo, 'cli'), { withFileTypes: true }))
    if (entry.isFile()) copyFileSync(join(repo, 'cli', entry.name), join(root, 'bin', entry.name));
  for (const name of readdirSync(join(repo, 'cli', 'commands')))
    copyFileSync(join(repo, 'cli', 'commands', name), join(root, 'bin', 'commands', name));
  const { path: record, sha: recordSha } = writeRecord(root);
  const calls = [];
  const chowns = [];
  const out = [];
  const err = [];
  const state = { handler, probes: probes ?? healthyProbes(base) };
  let ticks = 0;
  /** The answer of the fake runner before any `state.leak` is added. */
  async function answerOf(argv, opts) {
    const answer = state.handler ? await state.handler(argv, opts) : undefined;
    if (answer) return answer;
    const at = argv.indexOf('--list-tools');
    if (at >= 0) return listToolsAnswer(argv[at + 1]);
    if (argv.includes('--check-introspection')) return introspectionAnswer(root);
    // The running auth container of the project, as `docker ps -q` lists it.
    if (argv[0] === 'docker' && argv[1] === 'ps') return { code: 0, stdout: `${RUNNING_ID}\n`, stderr: '' };
    if (argv.includes('--manifest-sha256')) return manifestAnswer(root);
    // A snapshot container: tar writes its archive into the mounted directory with a loose mode.
    const snapshot = argv.find(arg => arg.endsWith(':/snapshot'));
    if (snapshot && argv.includes('tar')) {
      const archive = argv[argv.indexOf('-cf') + 1].replace('/snapshot/', '');
      writeFileSync(join(snapshot.slice(0, -':/snapshot'.length), archive), 'archive\n', { mode: 0o644 });
    }
    return { code: 0, stdout: '', stderr: '' };
  }
  async function run(argv, opts = {}) {
    calls.push(argv);
    const answer = await answerOf(argv, opts);
    // `state.leak`: every container also prints this text (stdout too, unless it carries an answer).
    return state.leak === undefined ? answer
      : { ...answer, stdout: answer.stdout || state.leak, stderr: `${answer.stderr}${state.leak}` };
  }
  const ctx = {
    root,
    run,
    // `state.failChown(path)`: true makes this chown fail (an injected write error).
    chown(path, uid, gid) {
      if (state.failChown?.(path)) throw Object.assign(new Error('injected'), { code: 'EIO' });
      chowns.push([path, uid, gid]);
    },
    // Whether a command is on PATH; gh is absent unless a test says otherwise.
    which: name => (state.which ?? (() => false))(name),
    out: line => out.push(line),
    err: line => err.push(line),
    get probes() { return state.probes; },
    // Advances one second per call, so that every snapshot or backup gets its own directory.
    now: () => new Date(Date.UTC(2026, 10, 18, 10, 0, ticks++)),
  };
  const cli = async (...argv) => {
    calls.length = 0; out.length = 0; err.length = 0;
    return main(argv, ctx);
  };
  const secrets = [];
  ctx.readSecret = async () => {
    if (!secrets.length) throw new Error('no secret queued');
    return secrets.shift();
  };
  return { root, ctx, calls, chowns, out, err, state, cli, record, recordSha, secrets };
}

/** The container id the fake `docker ps` reports. */
export const RUNNING_ID = 'c0ffee';

/**
 * Installs the host files of a next release under root, as install-host-files.sh would: compose.yaml,
 * Caddyfile.template and one CLI module change, one module is added. Returns a record for them.
 */
export function installNextRelease(root, version = '0.0.1', images) {
  const marker = `# release ${version}\n`;
  for (const name of ['compose.yaml', 'Caddyfile.template', 'bin/commands/doctor.mjs'])
    writeFileSync(join(root, name), `${readFileSync(join(root, name), 'utf8')}${name.endsWith('.mjs') ? '// ' : ''}${marker}`);
  writeFileSync(join(root, 'bin', 'commands', 'added.mjs'), `// only in ${version}\n`);
  const digit = String(version.split('.').at(-1));
  return writeRecord(root, {
    version,
    commit: digit.repeat(40),
    images: images ?? {
      auth: `lawoss-auth@sha256:${digit.repeat(64)}`,
      hub: `lawoss-hub@sha256:${digit.repeat(64)}`,
      proxy: `caddy@sha256:${digit.repeat(64)}`,
    },
  });
}

/** The host files under root with their bytes, for byte-for-byte comparisons. */
export function hostBytes(root) {
  return Object.fromEntries(Object.keys(hostFiles(root)).sort().map(path => [path, readFileSync(join(root, path), 'utf8')]));
}

/** The certificate contact every test deployment uses. */
export const ACME_EMAIL = 'ops@example.com';

/** setup() plus a successful init for `services`. */
export async function initialized(services = 'crz,orsr', options = {}) {
  const t = setup(options);
  const code = await t.cli('init', '--base', options.base ?? 'example.com', '--services', services,
    '--acme-email', ACME_EMAIL, '--record', t.record, '--record-sha256', t.recordSha);
  if (code !== 0) throw new Error(`init failed: ${t.err.join('\n')}`);
  return t;
}

export const composeBase = root => ['docker', 'compose', '-f', join(root, 'compose.yaml'), '--env-file', join(root, '.env')];
