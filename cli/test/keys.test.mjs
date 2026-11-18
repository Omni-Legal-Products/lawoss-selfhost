import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { readSecret } from '../lawoss-selfhost.mjs';
import { readEnvFile } from '../lib.mjs';
import { SENTINEL, composeBase, initialized } from './helpers.mjs';

describe('provider keys', () => {
  it('set-key reads the value from stdin, writes .env atomically and recreates only the hub', async () => {
    const t = await initialized('crz,fs');
    const before = readEnvFile(join(t.root, '.env'));
    t.secrets.push(`${SENTINEL}-fs-key`);
    assert.equal(await t.cli('set-key', 'FS_API_KEY'), 0, t.err.join('\n'));
    const after = readEnvFile(join(t.root, '.env'));
    assert.equal(after.FS_API_KEY, `${SENTINEL}-fs-key`);
    assert.equal(after.HUB_CONFIG_JSON, before.HUB_CONFIG_JSON);
    assert.equal(statSync(join(t.root, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(t.calls, [[...composeBase(t.root), 'up', '-d', 'hub']]);
    assert.deepEqual(t.out, ['set FS_API_KEY']);
    const printed = [...t.out, ...t.err, ...t.calls.flat()].join('\n');
    assert.ok(!printed.includes(SENTINEL), 'the value is never printed nor passed in argv');
  });

  it('unset-key empties the variable and recreates the hub', async () => {
    const t = await initialized('crz');
    t.secrets.push('value-1');
    assert.equal(await t.cli('set-key', 'MISTRAL_API_KEY'), 0);
    assert.equal(await t.cli('unset-key', 'MISTRAL_API_KEY'), 0);
    assert.equal(readEnvFile(join(t.root, '.env')).MISTRAL_API_KEY, '');
    assert.match(readFileSync(join(t.root, '.env'), 'utf8'), /^MISTRAL_API_KEY=$/m);
    assert.deepEqual(t.calls, [[...composeBase(t.root), 'up', '-d', 'hub']]);
  });

  it('accepts only names a manifest entry allowlists, and never a value in argv', async () => {
    const t = await initialized('crz');
    assert.equal(await t.cli('set-key', 'HUB_CONFIG_JSON'), 2);
    assert.equal(await t.cli('set-key', 'PATH'), 2);
    assert.equal(await t.cli('set-key', 'FS_API_KEY', 'inline-value'), 2);
    assert.equal(await t.cli('set-key', 'FS_API_KEY=inline-value'), 2);
    assert.equal(await t.cli('unset-key', 'AUTH_CONFIG_JSON'), 2);
    assert.equal(t.calls.length, 0);
  });

  it('refuses an empty value or one that .env cannot hold, changing nothing', async () => {
    const t = await initialized('crz');
    const before = readFileSync(join(t.root, '.env'));
    for (const value of ['', 'two\nlines', "it's", 'tab\there']) {
      t.secrets.push(value);
      assert.equal(await t.cli('set-key', 'FS_API_KEY'), 1, JSON.stringify(value));
    }
    assert.deepEqual(readFileSync(join(t.root, '.env')), before);
    assert.equal(t.calls.length, 0);
  });

  it('reads the value without echo on a terminal, and whole from piped stdin', async () => {
    const tty = new PassThrough();
    tty.isTTY = true;
    const modes = [];
    tty.setRawMode = mode => modes.push(mode);
    let shown = '';
    const typed = readSecret('Value: ', { stdin: tty, stderr: { write: text => { shown += text; } } });
    tty.write('ab');
    tty.write('x\u007fc\r');
    assert.equal(await typed, 'abc');
    assert.deepEqual(modes, [true, false]);
    assert.equal(shown, 'Value: \n', 'only the prompt is shown');
    const pipe = new PassThrough();
    const piped = readSecret('Value: ', { stdin: pipe, stderr: { write: () => assert.fail('no prompt for a pipe') } });
    pipe.end('from-a-file\n');
    assert.equal(await piped, 'from-a-file');
  });
});
