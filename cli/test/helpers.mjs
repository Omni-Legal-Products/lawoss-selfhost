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
  // The CLI as installed in <root>/bin.
  mkdirSync(join(root, 'bin', 'commands'), { recursive: true });
  for (const name of ['lawoss-selfhost.mjs', 'lib.mjs', 'package.json']) copyFileSync(join(repo, 'cli', name), join(root, 'bin', name));
  for (const name of readdirSync(join(repo, 'cli', 'commands')))
    copyFileSync(join(repo, 'cli', 'commands', name), join(root, 'bin', 'commands', name));
  const { path: record, sha: recordSha } = writeRecord(root);
  const calls = [];
  const chowns = [];
  const out = [];
  const err = [];
  const state = { handler, probes: probes ?? healthyProbes(base) };
  let ticks = 0;
  const ctx = {
    root,
    async run(argv, opts = {}) {
      calls.push(argv);
      const answer = state.handler ? await state.handler(argv, opts) : undefined;
      if (answer) return answer;
      const at = argv.indexOf('--list-tools');
      if (at >= 0) return listToolsAnswer(argv[at + 1]);
      // A snapshot container: tar writes its archive into the mounted directory with a loose mode.
      const snapshot = argv.find(arg => arg.endsWith(':/snapshot'));
      if (snapshot && argv.includes('tar')) {
        const archive = argv[argv.indexOf('-cf') + 1].replace('/snapshot/', '');
        writeFileSync(join(snapshot.slice(0, -':/snapshot'.length), archive), 'archive\n', { mode: 0o644 });
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    chown(path, uid, gid) { chowns.push([path, uid, gid]); },
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

/** setup() plus a successful init for `services`. */
export async function initialized(services = 'crz,orsr', options = {}) {
  const t = setup(options);
  const code = await t.cli('init', '--base', options.base ?? 'example.com', '--services', services,
    '--record', t.record, '--record-sha256', t.recordSha);
  if (code !== 0) throw new Error(`init failed: ${t.err.join('\n')}`);
  return t;
}

export const composeBase = root => ['docker', 'compose', '-f', join(root, 'compose.yaml'), '--env-file', join(root, '.env')];
