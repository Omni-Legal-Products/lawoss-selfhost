import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { checkCall, listedTools } from '../dist/policy.js';
import { principalKey } from '../dist/resource-auth.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { BASE, RUNTIME_TOOLS, fakePool, manifest, rpc, send, startHub, startIntrospection } from './harness.mjs';

const DENY_TEXT = 'Tento nástroj je dostupný len v lokálnom plugine.';
const SAVE_TEXT = 'Ukladanie súborov na server nie je dostupné; výsledok dostanete v odpovedi.';
const INTERNAL_TEXT = 'Služba je dočasne nedostupná. Skúste to znova neskôr.';
const TIMEOUT_TEXT = 'Služba neodpovedala včas. Skúste to znova.';
const INVALID_TEXT = 'Neplatné argumenty nástroja.';

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

  it('hides an allow-without tool whose listed argument is missing from the runtime schema', () => {
    const typo = { partial: { 'allow-without': ['savepath'] } };
    assert.deepEqual(listedTools(typo, [{ name: 'partial', inputSchema: { type: 'object', properties: { savePath: {} } } }]), []);
    assert.deepEqual(listedTools(policies, [{ name: 'partial', inputSchema: { type: 'object' } }]), []);
    assert.equal(listedTools(policies, [{ name: 'open', inputSchema: { type: 'object' } }]).length, 1);
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

/** Starts a hub with its own introspection, pool and judikaty token, runs `fn`, then shuts everything down. */
async function withHub({ pool = fakePool(), manifest: override, logs = [] } = {}, fn) {
  const introspection = await startIntrospection();
  const hub = await startHub({ issuer: introspection.issuer, pool, manifest: override, log: line => logs.push(line) });
  introspection.issue('token', 'judikaty');
  try {
    await fn({ hub, pool, logs, call: (method, params) => rpc(hub.port, 'judikaty', 'token', method, params) });
  } finally {
    await hub.close();
    await pool.close?.();
    await introspection.close();
  }
}

describe('tool policy regressions', () => {
  it('a manifest argument typo hides the allow-without tool and refuses it without a runtime call', async () => {
    const typo = structuredClone(manifest);
    typo.services.judikaty.tools.get_decision_full_text = { 'allow-without': ['savepath', 'saveToDefaultPath'] };
    await withHub({ manifest: typo }, async ({ pool, call }) => {
      const listed = await call('tools/list');
      assert.deepEqual(listed.message.result.tools.map(tool => tool.name), ['search_decisions']);
      const response = await call('tools/call', { name: 'get_decision_full_text', arguments: { id: '1' } });
      assert.deepEqual(response.message.result, { content: [{ type: 'text', text: DENY_TEXT }], isError: true });
      assert.equal(pool.runtimeCalls.length, 0);
    });
  });

  it('a JSON-RPC batch lets only the allowed call reach the runtime', async () => {
    await withHub({}, async ({ hub, pool }) => {
      const batch = [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'manage_watchlist', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_decision_full_text', arguments: { id: '1', savePath: '/x' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_decisions', arguments: { query: 'q' } } },
      ];
      const response = await send(hub.port, {
        host: `judikaty.${BASE}`, method: 'POST', path: '/mcp', body: batch,
        headers: { authorization: 'Bearer token', accept: 'application/json, text/event-stream' },
      });
      assert.equal(response.status, 200);
      const byId = Object.fromEntries(JSON.parse(response.text).map(message => [message.id, message.result]));
      assert.deepEqual(byId[1], { content: [{ type: 'text', text: DENY_TEXT }], isError: true });
      assert.deepEqual(byId[2], { content: [{ type: 'text', text: SAVE_TEXT }], isError: true });
      assert.deepEqual(byId[3], { content: [{ type: 'text', text: 'runtime:search_decisions' }] });
      assert.deepEqual(pool.runtimeCalls.map(entry => entry.name), ['search_decisions']);
    });
  });

  it('non-tool methods never reach the pool', async () => {
    await withHub({}, async ({ pool, call }) => {
      for (const method of ['resources/list', 'prompts/list', 'resources/read', 'completion/complete']) {
        const response = await call(method, {});
        assert.equal(response.message.error.code, ErrorCode.MethodNotFound, method);
      }
      assert.equal(pool.clientCalls.length, 0);
    });
  });

  it('tool name variants of a denied tool get the deny text without reaching the pool', async () => {
    await withHub({}, async ({ pool, call }) => {
      for (const name of ['Manage_Watchlist', 'MANAGE_WATCHLIST', 'manage_watchlist ', ' manage_watchlist', 'Get_Decision_Full_Text']) {
        const response = await call('tools/call', { name, arguments: {} });
        assert.deepEqual(response.message.result, { content: [{ type: 'text', text: DENY_TEXT }], isError: true }, name);
      }
      assert.equal(pool.clientCalls.length, 0);
    });
  });
});

describe('error texts', () => {
  const INTERNAL = 'spawn /srv/lawoss/runtimes/judikaty ENOENT principal=["https://judikaty.example.test/mcp","user-1"]';
  const leaks = text => ['/srv/', 'ENOENT', 'principal', 'user-1', 'secret-detail'].filter(part => text.includes(part));

  it('a failing pool returns the fixed internal error text for tools/list and tools/call', async () => {
    const pool = {
      clientCalls: [], runtimeCalls: [],
      async client() { throw new Error(INTERNAL); },
      async stopPrincipal() {},
    };
    const logs = [];
    await withHub({ pool, logs }, async ({ call }) => {
      for (const [method, params] of [['tools/list', {}], ['tools/call', { name: 'search_decisions', arguments: { query: 'q' } }]]) {
        const response = await call(method, params);
        assert.deepEqual(response.message.error, { code: ErrorCode.InternalError, message: INTERNAL_TEXT }, method);
        assert.deepEqual(leaks(response.text), [], method);
      }
      assert.deepEqual(logs.map(line => JSON.parse(line).status), ['failed']);
    });
  });

  it('runtime JSON-RPC errors are replaced by fixed texts per code', async () => {
    const cases = {
      search_decisions: [new Error('secret-detail /srv/x'), ErrorCode.InternalError, INTERNAL_TEXT],
      get_decision_text: [new McpError(ErrorCode.InvalidParams, 'secret-detail /srv/x'), ErrorCode.InvalidParams, INVALID_TEXT],
      get_decision_detail: [new McpError(ErrorCode.RequestTimeout, 'secret-detail /srv/x'), ErrorCode.RequestTimeout, TIMEOUT_TEXT],
      get_case_chain: [new McpError(ErrorCode.MethodNotFound, 'secret-detail /srv/x'), ErrorCode.InternalError, INTERNAL_TEXT],
    };
    const pool = fakePool({ onCall: ({ name }) => { throw cases[name][0]; } });
    await withHub({ pool }, async ({ call }) => {
      for (const [name, [, code, text]] of Object.entries(cases)) {
        const response = await call('tools/call', { name, arguments: {} });
        assert.deepEqual(response.message.error, { code, message: text }, name);
        assert.deepEqual(leaks(response.text), [], name);
      }
      assert.equal(pool.runtimeCalls.length, 4, 'the runtime was reached and its error replaced');
    });
  });
});
