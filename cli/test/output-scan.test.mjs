// Review focus: no command prints a secret. Every command (but brand preview, whose terminal is the
// container's own by design) runs against one deployment whose
// containers and probes all echo every secret they could know (the .env values, a provider key,
// the backup private key), on stdout and stderr; nothing of it may reach the CLI's own output.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { USAGE } from '../lawoss-selfhost.mjs';
import { readEnvFile } from '../lib.mjs';
import { ACME_EMAIL, SECRETISH, SENTINEL, initialized, installNextRelease, setup } from './helpers.mjs';

/** Every value in .env that could be secret, each string inside the two JSON configurations included. */
function secretsOf(root) {
  const found = new Set();
  const walk = value => {
    if (typeof value === 'string') { if (value.length >= 16) found.add(value); }
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  };
  for (const [name, value] of Object.entries(readEnvFile(join(root, '.env')))) {
    if (!value || /^LAWOSS_|^AUTH_PUBLIC_HOST$/.test(name)) continue;
    found.add(value);
    if (name.endsWith('_CONFIG_JSON')) walk(JSON.parse(value));
  }
  return found;
}

/** The base64 body of a PEM file, line by line. */
const pemLines = path => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(line => line && !line.startsWith('-----')) : [];

// Digests, commit ids and the fixed snapshot and backup directory names are not secrets.
const scrub = text => text.replace(/sha256:[0-9a-f]{64}/g, '').replace(/\b[0-9a-f]{40,64}\b/g, '');

/**
 * Runs every command once against a fresh deployment. `noisy`: containers succeed but also print
 * every secret; `failing`: containers fail and print every secret, and every probe fails with it.
 */
async function sweep(mode) {
  const t = await initialized('crz,orsr');
  const known = new Set();
  const away = mkdtempSync(join(tmpdir(), 'lawoss-scan-key-'));
  after(() => rmSync(away, { recursive: true, force: true }));
  const remember = () => {
    for (const value of secretsOf(t.root)) known.add(value);
    for (const line of [...pemLines(join(t.root, 'keys', 'backup-private.pem')), ...pemLines(join(away, 'backup-private.pem'))]) known.add(line);
    known.add(SENTINEL);
    const leak = [...known].join(' | ');
    t.state.leak = leak;
    if (mode === 'failing') t.state.probes = {
      async resolve() { throw new Error(leak); },
      async tls() { throw new Error(leak); },
      async fetch() { return { status: 500, headers: new Headers({ 'www-authenticate': leak }), json: async () => ({ issuer: leak }) }; },
    };
  };
  // Containers that write files still write them; in the failing pass they then exit 1.
  t.state.handler = argv => {
    if (!argv.includes('run')) return undefined;
    const backupDir = argv.find(arg => arg.endsWith(':/backup'))?.split(':')[0];
    if (backupDir && argv.includes('snapshot')) writeFileSync(join(backupDir, 'auth.enc.json'), '{}\n');
    if (backupDir && argv.includes('tar')) writeFileSync(join(backupDir, 'hub-data.tar'), 'archive\n');
    // list's own answer, with fields it must never print.
    if (argv.at(-1) === 'list' && argv.includes('dist/admin.js'))
      return { code: mode === 'failing' ? 1 : 0, stderr: '', stdout: JSON.stringify([{ username: 'alice', status: 'active',
        resources: { 'https://crz.example.com/mcp': 'alice' }, passwordHash: SENTINEL, link: `https://auth.example.com/a#${SENTINEL}` }]) };
    const handoff = argv.find(arg => arg.endsWith(':/handoff'))?.split(':')[0];
    if (handoff) writeFileSync(join(handoff, 'link'), `https://auth.example.com/activate#${SENTINEL}\n`);
    return mode === 'failing' && !argv.includes('tar') && !argv.includes('snapshot') ? { code: 1, stdout: '', stderr: '' } : undefined;
  };
  const next = installNextRelease(t.root);
  const steps = [
    ['brand', 'check', 'lawoss'],
    ['brand', 'set', 'lawoss'],
    ['invite', 'alice', 'crz,orsr'],
    ['grant', 'alice', 'orsr'],
    ['revoke', 'alice', 'orsr'],
    ['list'],
    ['disable', 'alice'],
    ['set-key', 'FS_API_KEY'],
    ['unset-key', 'FS_API_KEY'],
    ['doctor'],
    ['backup', 'init-key'],
    ['backup'],
    ['restore', '--dry-run'],
    ['update', '--to', '0.0.1', '--record', next.path, '--record-sha256', next.sha],
    ['rollback'],
    ['rotate', 'introspection'],
    ['rotate', 'cookies'],
    ['rotate', 'signing'],
    ['services', 'add', 'judikaty'],
    ['services', 'remove', 'judikaty'],
    ['restore-snapshot', 'SNAPSHOT'],
    ['restore', '--apply', '--record-sha256', t.recordSha, '--private-key', join(away, 'backup-private.pem'), 'BACKUP'],
  ];
  let snapshot = join(t.root, 'snapshots', 'none');
  let backup = join(t.root, 'backups', 'none');
  const codes = {};
  for (const step of steps) {
    if (step[0] === 'set-key') t.secrets.push(SENTINEL);
    const key = join(t.root, 'keys', 'backup-private.pem');
    if (step[1] === '--apply' && existsSync(key)) renameSync(key, join(away, 'backup-private.pem'));
    const argv = step.map(arg => arg === 'SNAPSHOT' ? snapshot : arg === 'BACKUP' ? backup : arg);
    remember();
    const code = await t.cli(...argv);
    codes[step.slice(0, 2).join(' ')] = code;
    snapshot = t.out.find(line => line.startsWith(join(t.root, 'snapshots'))) ?? snapshot;
    if (step[0] === 'backup' && step.length === 1 && code === 0) [backup] = t.out;
    remember();
    const printed = [...t.out, ...t.err].join('\n');
    for (const secret of known) assert.ok(!printed.includes(secret), `${step.join(' ')} printed a secret`);
    assert.doesNotMatch(scrub(printed.replaceAll(USAGE, '')), SECRETISH, `${step.join(' ')} printed something secret-like`);
  }
  return codes;
}

describe('no command prints a secret', () => {
  it('every command, with containers that succeed but print every secret', async () => {
    const codes = await sweep('noisy');
    // The sweep is only meaningful when the commands really ran through.
    const failed = Object.entries(codes).filter(([, code]) => code !== 0).map(([step]) => step);
    assert.deepEqual(failed, [], JSON.stringify(codes));
  });

  it('every command, with containers and probes that fail and print every secret', async () => {
    const codes = await sweep('failing');
    assert.ok(Object.values(codes).filter(code => code !== 0).length >= 8, JSON.stringify(codes));
  });

  it('init prints only host names, also when its checks fail', async () => {
    const t = setup();
    t.state.leak = SENTINEL;
    mkdirSync(join(t.root, 'brand'), { recursive: true });
    assert.equal(await t.cli('init', '--base', 'example.com', '--services', 'crz', '--acme-email', ACME_EMAIL,
      '--record', t.record, '--record-sha256', t.recordSha), 0);
    assert.deepEqual(t.out, ['auth.example.com', 'crz.example.com']);
    const known = secretsOf(t.root);
    const printed = [...t.out, ...t.err].join('\n');
    for (const secret of known) assert.ok(!printed.includes(secret));
    assert.ok(!printed.includes(SENTINEL));
  });
});
