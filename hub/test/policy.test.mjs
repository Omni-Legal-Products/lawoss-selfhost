import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { checkCall, listedTools } from '../dist/policy.js';
import { principalKey } from '../dist/resource-auth.js';
import { RUNTIME_TOOLS, fakePool, rpc, startHub, startIntrospection } from './harness.mjs';

const DENY_TEXT = 'Tento nástroj je dostupný len v lokálnom plugine.';
const SAVE_TEXT = 'Ukladanie súborov na server nie je dostupné; výsledok dostanete v odpovedi.';

const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

describe('tool policy (pure)', () => {
  const policies = {
    open: 'allow',
    closed: 'deny-remote',
    partial: { 'allow-without': ['savePath', 'saveToDefaultPath'] },
  };

  it('lists allowed tools, strips allow-without properties and does not mutate its input', () => {
    const tools = deepFreeze([
      { name: 'open', inputSchema: { type: 'object' } },
      { name: 'closed', inputSchema: { type: 'object' } },
      { name: 'toString', inputSchema: { type: 'object' } },
      { name: 'partial', inputSchema: { type: 'object', properties: { id: {}, savePath: {}, saveToDefaultPath: {} }, required: ['id', 'savePath'] } },
    ]);
    const before = JSON.stringify(tools);
    const listed = listedTools(policies, tools);
    assert.deepEqual(listed.map(tool => tool.name), ['open', 'partial']);
    assert.deepEqual(listed[0], tools[0]);
    assert.deepEqual(listed[1].inputSchema, { type: 'object', properties: { id: {} }, required: ['id'] });
    assert.equal(JSON.stringify(tools), before);
  });

  it('decides calls before any runtime is involved', () => {
    assert.deepEqual(checkCall(policies, 'open', { savePath: 'x' }), { allowed: true });
    assert.deepEqual(checkCall(policies, 'partial', { id: '1' }), { allowed: true });
    assert.deepEqual(checkCall(policies, 'partial', undefined), { allowed: true });
    for (const name of ['closed', 'missing', 'toString', 'constructor', '__proto__'])
      assert.deepEqual(checkCall(policies, name, {}), { allowed: false, text: DENY_TEXT }, name);
    for (const args of [{ savePath: '/tmp/x' }, { saveToDefaultPath: false }, { id: '1', savePath: null }])
      assert.deepEqual(checkCall(policies, 'partial', args), { allowed: false, text: SAVE_TEXT }, JSON.stringify(args));
  });

  it('treats a malformed policy value as denied', () => {
    assert.equal(checkCall({ odd: 'maybe' }, 'odd', {}).allowed, false);
    assert.equal(checkCall({ odd: { 'allow-without': 'savePath' } }, 'odd', {}).allowed, false);
    assert.deepEqual(listedTools({ odd: 'maybe' }, [{ name: 'odd', inputSchema: { type: 'object' } }]), []);
  });
});

describe('tool policy through the hub (judikaty)', () => {
  let introspection, pool, hub, identity;
  const logs = [];
  before(async () => {
    introspection = await startIntrospection();
    pool = fakePool();
    hub = await startHub({ issuer: introspection.issuer, pool, log: line => logs.push(line) });
    identity = introspection.issue('token', 'judikaty');
  });
  after(async () => {
    await hub.close();
    await pool.close();
    await introspection.close();
  });
  const call = (name, args) => rpc(hub.port, 'judikaty', 'token', 'tools/call', { name, arguments: args });
  const untouched = async (fn) => {
    const clients = pool.clientCalls.length;
    const runtime = pool.runtimeCalls.length;
    const result = await fn();
    assert.equal(pool.clientCalls.length, clients, 'the pool is not asked for a runtime');
    assert.equal(pool.runtimeCalls.length, runtime, 'the runtime is not called');
    return result;
  };

  it('tools/list hides deny-remote tools and tools absent from the manifest', async () => {
    const response = await rpc(hub.port, 'judikaty', 'token', 'tools/list');
    assert.equal(response.status, 200);
    assert.deepEqual(response.message.result.tools.map(tool => tool.name).sort(), ['get_decision_full_text', 'search_decisions']);
  });

  it('calling a deny-remote tool returns isError with text "Tento nástroj je dostupný len v lokálnom plugine."', async () => {
    for (const name of ['manage_watchlist', 'brand_new_tool']) {
      const response = await untouched(() => call(name, { action: 'list' }));
      assert.deepEqual(response.message.result, { content: [{ type: 'text', text: DENY_TEXT }], isError: true }, name);
    }
  });

  it('allow-without tool is listed without savePath and saveToDefaultPath in its input schema', async () => {
    const response = await rpc(hub.port, 'judikaty', 'token', 'tools/list');
    const tool = response.message.result.tools.find(entry => entry.name === 'get_decision_full_text');
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
    assert.deepEqual(tool.inputSchema.required, ['id']);
    const original = RUNTIME_TOOLS.find(entry => entry.name === 'get_decision_full_text');
    assert.deepEqual(Object.keys(original.inputSchema.properties), ['id', 'savePath', 'saveToDefaultPath'], 'runtime schema unchanged');
  });

  it('allow-without tool called with savePath returns isError with text "Ukladanie súborov na server nie je dostupné; výsledok dostanete v odpovedi." and the runtime is not called', async () => {
    for (const args of [{ id: '1', savePath: '/etc/x' }, { id: '1', saveToDefaultPath: false }]) {
      const response = await untouched(() => call('get_decision_full_text', args));
      assert.deepEqual(response.message.result, { content: [{ type: 'text', text: SAVE_TEXT }], isError: true });
    }
  });

  it('allowed calls reach the runtime of the verified principal with their arguments', async () => {
    const before = pool.runtimeCalls.length;
    for (const [name, args] of [['search_decisions', { query: 'nájom' }], ['get_decision_full_text', { id: '1' }]]) {
      const response = await call(name, args);
      assert.deepEqual(response.message.result, { content: [{ type: 'text', text: `runtime:${name}` }] });
    }
    assert.deepEqual(pool.runtimeCalls.slice(before), [
      { principal: principalKey(identity), id: 'judikaty', name: 'search_decisions', arguments: { query: 'nájom' } },
      { principal: principalKey(identity), id: 'judikaty', name: 'get_decision_full_text', arguments: { id: '1' } },
    ]);
  });

  it('logs one line per tools/call without arguments, results, tokens or names', async () => {
    logs.length = 0;
    await call('search_decisions', { query: 'tajné-heslo' });
    await call('manage_watchlist', {});
    await call('brand_new_tool', {});
    await rpc(hub.port, 'judikaty', 'token', 'tools/list');
    assert.equal(logs.length, 3);
    const hash = createHash('sha256').update(principalKey(identity)).digest('hex').slice(0, 16);
    const entries = logs.map(line => JSON.parse(line));
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'principal', 'service', 'status', 'time', 'tool']);
      assert.equal(entry.principal, hash);
      assert.equal(entry.service, 'judikaty');
      assert.ok(Number.isInteger(entry.durationMs) && entry.durationMs >= 0);
      assert.ok(!Number.isNaN(Date.parse(entry.time)));
    }
    assert.deepEqual(entries.map(entry => [entry.tool, entry.status]),
      [['search_decisions', 'ok'], ['manage_watchlist', 'denied'], ['(unlisted)', 'denied']]);
    const all = logs.join('\n');
    for (const secret of ['tajné-heslo', 'token', 'user-1', 'runtime:', 'brand_new_tool']) assert.ok(!all.includes(secret), secret);
  });
});
