import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SECRETISH, SENTINEL, composeBase, initialized } from './helpers.mjs';

const admin = root => [...composeBase(root), 'run', '--rm', '--no-deps'];
const mounts = argv => argv.flatMap((arg, i) => (arg === '-v' || arg === '--volume' || arg === '--mount') ? [argv[i + 1]] : []);

// Answers the invite container like admin.js does: the link goes into the mounted file, never to stdout.
const inviteWrites = token => argv => {
  if (!argv.includes('invite')) return undefined;
  const [source, target] = mounts(argv)[0].split(':');
  const out = argv[argv.length - 1];
  assert.ok(out.startsWith(`${target}/`), 'admin writes inside the mounted handoff directory');
  writeFileSync(join(source, out.slice(target.length + 1)), `https://auth.example.com/activate/${token}\n`, { flag: 'wx', mode: 0o600 });
  return { code: 0, stdout: 'One-time link saved to the specified private file; valid for 1 hour.\n', stderr: '' };
};

describe('account commands', () => {
  it('account commands run as docker compose run --rm auth node dist/admin.js with only auth-data mounted', async () => {
    const t = await initialized('crz,orsr');
    const base = admin(t.root);
    const expect = async (argv, tail) => {
      assert.equal(await t.cli(...argv), 0, t.err.join('\n'));
      assert.deepEqual(t.calls, tail.map(rest => [...base, 'auth', 'node', 'dist/admin.js', ...rest]));
      for (const call of t.calls) assert.deepEqual(mounts(call), [], 'no mount beyond the service definition (auth-data)');
    };
    await expect(['grant', 'alice', 'crz,orsr'], [
      ['grant-resource', 'alice', 'https://crz.example.com/mcp', 'alice'],
      ['grant-resource', 'alice', 'https://orsr.example.com/mcp', 'alice'],
    ]);
    await expect(['revoke', 'alice', 'orsr'], [['revoke-resource', 'alice', 'https://orsr.example.com/mcp']]);
    await expect(['disable', 'alice'], [['disable', 'alice']]);
    t.state.handler = argv => argv.includes('list')
      ? { code: 0, stdout: JSON.stringify([{ id: 'u1', username: 'alice', status: 'active', resources: { 'https://crz.example.com/mcp': 'alice' }, extra: SENTINEL }]), stderr: '' }
      : undefined;
    await expect(['list'], [['list']]);
    assert.deepEqual(t.out, ['alice active crz']);
  });

  it('list escapes characters that are not printable in user names', async () => {
    const t = await initialized('crz');
    t.state.handler = () => ({ code: 0, stderr: '', stdout: JSON.stringify([
      { username: 'eve\u001b[2Jx', status: 'active', resources: {} },
      { username: 'bob\u202esuffix', status: 'pending', resources: { 'https://crz.example.com/mcp': 'bob' } },
    ]) });
    assert.equal(await t.cli('list'), 0);
    assert.deepEqual(t.out, ['eve\\u001b[2Jx active -', 'bob\\u202esuffix pending crz']);
    for (const line of t.out) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u202e]/);
  });

  it('invite USER orsr,crz runs invite for orsr with tenant USER, then grant-resource for crz with tenant USER', async () => {
    const t = await initialized('crz,orsr');
    t.state.handler = inviteWrites('a'.repeat(43));
    assert.equal(await t.cli('invite', 'alice', 'orsr,crz'), 0, t.err.join('\n'));
    const base = admin(t.root);
    assert.equal(t.calls.length, 2);
    const [invite, grant] = t.calls;
    const [mount] = mounts(invite);
    assert.deepEqual(invite, [...base, '-v', mount, 'auth', 'node', 'dist/admin.js',
      'invite', 'alice', 'https://orsr.example.com/mcp', 'alice', '/handoff/link']);
    assert.match(mount, new RegExp(`^${join(t.root, 'handoff')}/\\.staging-[^:/]+:/handoff$`));
    assert.deepEqual(grant, [...base, 'auth', 'node', 'dist/admin.js', 'grant-resource', 'alice', 'https://crz.example.com/mcp', 'alice']);
  });

  it('invite leaves a root-owned 0600 file in /opt/lawoss/handoff and prints only its path', async () => {
    const token = `${SENTINEL}-activation`;
    const t = await initialized('crz,orsr');
    t.state.handler = inviteWrites(token);
    assert.equal(await t.cli('invite', 'alice', 'crz'), 0, t.err.join('\n'));
    const handoff = join(t.root, 'handoff');
    const file = join(handoff, 'alice.link');
    assert.equal(statSync(handoff).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(t.chowns.some(([path, uid, gid]) => path === file && uid === 0 && gid === 0), 'chowned to root:root');
    assert.match(readFileSync(file, 'utf8'), new RegExp(SENTINEL));
    assert.deepEqual(t.out, [file]);
    const printed = [...t.out, ...t.err].join('\n');
    assert.ok(!printed.includes(SENTINEL) && !printed.includes('activate'));
    assert.doesNotMatch(printed, SECRETISH);
    assert.deepEqual(readdirSync(handoff), ['alice.link'], 'the staging directory is removed');
  });

  it('invite refuses when the account already has a pending file', async () => {
    const t = await initialized('crz,orsr');
    t.state.handler = inviteWrites('b'.repeat(43));
    assert.equal(await t.cli('invite', 'alice', 'crz'), 0);
    const before = readFileSync(join(t.root, 'handoff', 'alice.link'), 'utf8');
    assert.equal(await t.cli('invite', 'alice', 'crz'), 1);
    assert.equal(t.calls.length, 0, 'no container runs');
    assert.match(t.err.join('\n'), /pending/);
    assert.equal(readFileSync(join(t.root, 'handoff', 'alice.link'), 'utf8'), before);
  });

  it('invite cleans up and prints nothing from the container when it fails', async () => {
    const t = await initialized('crz,orsr');
    t.state.handler = () => ({ code: 1, stdout: SENTINEL, stderr: SENTINEL });
    assert.equal(await t.cli('invite', 'alice', 'crz'), 1);
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
    assert.equal(existsSync(join(t.root, 'handoff', 'alice.link')), false);
    assert.deepEqual(readdirSync(join(t.root, 'handoff')), []);
  });

  it('rejects user names that cannot be their own tenant and services that are not enabled', async () => {
    const t = await initialized('crz,orsr');
    assert.equal(await t.cli('invite', 'Alice.Smith@example.com', 'crz'), 2);
    assert.equal(await t.cli('invite', '../alice', 'crz'), 2);
    assert.equal(await t.cli('invite', 'alice', 'ruz'), 2);
    assert.equal(await t.cli('invite', 'alice', 'crz,crz'), 2);
    assert.equal(await t.cli('grant', 'alice'), 2);
    assert.equal(t.calls.length, 0);
  });
});
