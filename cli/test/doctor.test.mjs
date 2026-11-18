import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readEnvFile } from '../lib.mjs';
import { SENTINEL, composeBase, initialized, introspectionAnswer, listToolsAnswer, manifestAnswer, toolsOf } from './helpers.mjs';

// Every value in .env that could be secret: the whole JSON values and every string inside them.
function secretsOf(root) {
  const vars = readEnvFile(join(root, '.env'));
  const values = new Set([vars.AUTH_CONFIG_JSON, vars.HUB_CONFIG_JSON]);
  const walk = value => {
    if (typeof value === 'string') { if (value.length >= 16) values.add(value); }
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  };
  walk(JSON.parse(vars.AUTH_CONFIG_JSON));
  walk(JSON.parse(vars.HUB_CONFIG_JSON));
  return [...values, SENTINEL];
}

describe('doctor', () => {
  it('passes every check in order on a healthy deployment', async () => {
    const t = await initialized('crz,orsr');
    assert.equal(await t.cli('doctor'), 0, t.out.join('\n'));
    assert.deepEqual(t.out, [
      'PASS dns auth.example.com', 'PASS dns crz.example.com', 'PASS dns orsr.example.com',
      'PASS tls auth.example.com', 'PASS tls crz.example.com', 'PASS tls orsr.example.com',
      'PASS issuer metadata auth.example.com',
      'PASS resource metadata crz.example.com', 'PASS 401 challenge crz.example.com',
      'PASS resource metadata orsr.example.com', 'PASS 401 challenge orsr.example.com',
      'PASS introspection crz', 'PASS introspection orsr',
      'PASS manifest services.json',
      'PASS tools crz', 'PASS tools orsr',
    ]);
    const hubRun = (...args) => [...composeBase(t.root), 'run', '--rm', '--no-deps', 'hub', 'node', 'dist/main.js', ...args];
    assert.deepEqual(t.calls, [
      hubRun('--check-introspection'),
      hubRun('--manifest-sha256'),
      ...['crz', 'orsr'].map(id => hubRun('--list-tools', id)),
    ]);
  });

  it('doctor never prints values from .env', async () => {
    const t = await initialized('crz,orsr');
    // Plant a sentinel among the secrets so that the fixture has a known value too.
    const path = join(t.root, '.env');
    writeFileSync(path, readFileSync(path, 'utf8').replace('FS_API_KEY=', `FS_API_KEY=${SENTINEL}`));
    const secrets = secretsOf(t.root);
    const leak = secrets.join(' ');
    // Every probe and the runner fail with messages that carry the secrets.
    t.state.probes = {
      async resolve() { throw new Error(leak); },
      async tls() { throw new Error(leak); },
      async fetch() { return { status: 500, headers: new Headers({ 'www-authenticate': leak }), json: async () => ({ issuer: leak }) }; },
    };
    t.state.handler = () => ({ code: 1, stdout: leak, stderr: leak });
    assert.equal(await t.cli('doctor'), 1);
    const printed = [...t.out, ...t.err].join('\n');
    for (const secret of secrets) assert.ok(!printed.includes(secret), 'a value from .env was printed');
    for (const line of t.out) assert.match(line, /^(PASS|FAIL) /);
    // And when everything passes.
    t.state.probes = (await import('./helpers.mjs')).healthyProbes('example.com');
    t.state.handler = undefined;
    assert.equal(await t.cli('doctor'), 0);
    const passed = [...t.out, ...t.err].join('\n');
    for (const secret of secrets) assert.ok(!passed.includes(secret));
  });

  it('doctor reports manifest drift when a runtime lists a tool absent from services.json', async () => {
    const t = await initialized('crz,orsr');
    const listed = toolsOf('crz');
    t.state.handler = argv => argv.at(-1) === 'crz'
      ? listToolsAnswer('crz', [...listed.slice(1), 'crz_rogue_tool'])
      : undefined;
    assert.equal(await t.cli('doctor'), 1);
    const fail = t.out.find(line => line.startsWith('FAIL tools crz'));
    assert.ok(fail, t.out.join('\n'));
    assert.match(fail, /not in services\.json: crz_rogue_tool/);
    assert.match(fail, new RegExp(`missing from the runtime: ${listed[0]}`));
    assert.ok(t.out.includes('PASS tools orsr'));
  });

  it('fails a resource whose metadata or challenge is wrong and never prints tool names that are not names', async () => {
    const t = await initialized('crz');
    const healthy = t.state.probes;
    t.state.probes = {
      ...healthy,
      async fetch(url, init) {
        if (url.endsWith('/mcp') && init?.method === 'POST') return { status: 200, headers: new Headers(), json: async () => ({}) };
        return healthy.fetch(url, init);
      },
    };
    t.state.handler = () => listToolsAnswer('crz', [...toolsOf('crz'), `${SENTINEL} <script>`]);
    assert.equal(await t.cli('doctor'), 1);
    assert.ok(t.out.includes('FAIL 401 challenge crz.example.com'));
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
  });

  it('fails introspection per service: a secret mismatch and a broken path are told apart', async () => {
    const t = await initialized('crz,orsr');
    t.state.handler = argv => argv.includes('--check-introspection')
      ? introspectionAnswer(t.root, { crz: 'secret-mismatch', orsr: 'unreachable' }) : undefined;
    assert.equal(await t.cli('doctor'), 1);
    assert.ok(t.out.includes('FAIL introspection crz: the hub and auth hold different introspection secrets'), t.out.join('\n'));
    assert.ok(t.out.includes('FAIL introspection orsr: the hub cannot reach auth at its public origin'), t.out.join('\n'));
    assert.ok(t.out.includes('PASS tools crz'));
  });

  it('fails every introspection check when the check cannot run, and an unreadable answer is not a pass', async () => {
    const t = await initialized('crz,orsr');
    t.state.handler = argv => argv.includes('--check-introspection') ? { code: 125, stdout: SENTINEL, stderr: SENTINEL } : undefined;
    assert.equal(await t.cli('doctor'), 1);
    assert.ok(t.out.includes('FAIL introspection crz: the check did not run (exit 125)'), t.out.join('\n'));
    assert.ok(t.out.includes('FAIL introspection orsr: the check did not run (exit 125)'));
    t.state.handler = argv => argv.includes('--check-introspection')
      ? { code: 0, stdout: JSON.stringify({ introspection: { crz: 'ok' } }), stderr: '' } : undefined;
    assert.equal(await t.cli('doctor'), 1);
    assert.ok(t.out.includes('PASS introspection crz'));
    assert.ok(t.out.includes('FAIL introspection orsr: no answer for this service'));
    assert.ok(![...t.out, ...t.err].join('\n').includes(SENTINEL));
  });

  it('fails when the hub image carries a different services.json than the host', async () => {
    const t = await initialized('crz');
    t.state.handler = argv => argv.includes('--manifest-sha256') ? manifestAnswer(t.root, 'f'.repeat(64)) : undefined;
    assert.equal(await t.cli('doctor'), 1);
    assert.ok(t.out.includes('FAIL manifest services.json: the hub image carries a different services.json than the host'), t.out.join('\n'));
  });
});
