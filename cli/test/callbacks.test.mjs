import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CLAUDE_CALLBACKS, readEnvFile } from '../lib.mjs';
import { SECRETISH, composeBase, initialized } from './helpers.mjs';

const authConfig = t => JSON.parse(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON);
const recreateAuth = t => [...composeBase(t.root), 'up', '-d', '--wait', '--wait-timeout', '300', '--force-recreate', 'auth'];
const quiet = t => assert.doesNotMatch([...t.out, ...t.err].join('\n'), SECRETISH);

describe('callbacks', () => {
  it('Claude\'s callback is the documented exact URL', () => {
    assert.deepEqual(CLAUDE_CALLBACKS, ['https://claude.ai/api/mcp/auth_callback']);
  });

  it('lists the allowed web callbacks, Claude\'s after init', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('callbacks'), 0, t.err.join('\n'));
    assert.deepEqual(t.out.slice(-1), CLAUDE_CALLBACKS);
    assert.equal(t.calls.length, 0, 'listing runs no container');
    quiet(t);
  });

  it('add puts one exact https callback in auth\'s config and recreates only auth', async () => {
    const t = await initialized('crz');
    const before = authConfig(t);
    t.out.length = 0;
    assert.equal(await t.cli('callbacks', 'add', 'https://app.example.org/oauth/callback'), 0, t.err.join('\n'));
    const after = authConfig(t);
    assert.deepEqual(after.redirectUris, [...CLAUDE_CALLBACKS, 'https://app.example.org/oauth/callback']);
    assert.deepEqual({ ...after, redirectUris: undefined }, { ...before, redirectUris: undefined }, 'nothing else changes');
    assert.equal(statSync(join(t.root, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(t.calls, [recreateAuth(t)]);
    assert.deepEqual(t.out, ['allowed https://app.example.org/oauth/callback']);
    quiet(t);
  });

  it('add claude restores Claude\'s callback on a deployment made without it', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('callbacks', 'remove', CLAUDE_CALLBACKS[0]), 0, t.err.join('\n'));
    assert.deepEqual(authConfig(t).redirectUris, []);
    t.calls.length = 0;
    t.out.length = 0;
    assert.equal(await t.cli('callbacks', 'add', 'claude'), 0, t.err.join('\n'));
    assert.deepEqual(authConfig(t).redirectUris, CLAUDE_CALLBACKS);
    assert.deepEqual(t.calls, [recreateAuth(t)]);
    assert.deepEqual(t.out, CLAUDE_CALLBACKS.map(uri => `allowed ${uri}`));
  });

  it('adding a callback that is already allowed changes nothing and restarts nothing', async () => {
    const t = await initialized('crz');
    t.out.length = 0;
    assert.equal(await t.cli('callbacks', 'add', CLAUDE_CALLBACKS[0]), 0, t.err.join('\n'));
    assert.deepEqual(authConfig(t).redirectUris, CLAUDE_CALLBACKS);
    assert.equal(t.calls.length, 0);
    assert.deepEqual(t.out, [`already allowed ${CLAUDE_CALLBACKS[0]}`]);
  });

  it('remove takes one exact callback out and refuses one that is not there', async () => {
    const t = await initialized('crz');
    t.out.length = 0;
    assert.equal(await t.cli('callbacks', 'remove', CLAUDE_CALLBACKS[0]), 0, t.err.join('\n'));
    assert.deepEqual(authConfig(t).redirectUris, []);
    assert.deepEqual(t.calls, [recreateAuth(t)]);
    assert.deepEqual(t.out, [`removed ${CLAUDE_CALLBACKS[0]}`]);
    t.calls.length = 0;
    assert.equal(await t.cli('callbacks', 'remove', 'https://app.example.org/oauth/callback'), 1);
    assert.equal(t.calls.length, 0);
  });

  it('refuses anything but one exact https URL and writes nothing', async () => {
    const t = await initialized('crz');
    const before = readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON;
    for (const uri of [
      'http://app.example.org/callback', // a web callback must be https; loopback needs no entry
      'https://*.example.org/callback',
      'https://user:pass@app.example.org/callback',
      'https://app.example.org/callback#x',
      'https://app.example.org/callback?x=1',
      'https://APP.example.org/callback', // not in canonical form
      'https://app.example.org', // no path: not what the URL parser gives back
      'javascript:alert(1)',
      'not a url',
      `https://app.example.org/${'a'.repeat(2048)}`, // longer than 2048 characters
    ]) {
      assert.equal(await t.cli('callbacks', 'add', uri), 2, uri);
    }
    assert.equal(await t.cli('callbacks', 'drop', CLAUDE_CALLBACKS[0]), 2);
    assert.equal(await t.cli('callbacks', 'add'), 2);
    assert.equal(readEnvFile(join(t.root, '.env')).AUTH_CONFIG_JSON, before);
    assert.equal(t.calls.length, 0);
  });

  it('allows at most 20 web callbacks', async () => {
    const t = await initialized('crz');
    for (let n = 1; n < 20; n++) assert.equal(await t.cli('callbacks', 'add', `https://app${n}.example.org/callback`), 0, t.err.join('\n'));
    assert.equal(authConfig(t).redirectUris.length, 20);
    t.calls.length = 0;
    assert.equal(await t.cli('callbacks', 'add', 'https://app20.example.org/callback'), 1);
    assert.match(t.err.join('\n'), /at most 20/);
    assert.equal(authConfig(t).redirectUris.length, 20);
    assert.equal(t.calls.length, 0);
  });
});
