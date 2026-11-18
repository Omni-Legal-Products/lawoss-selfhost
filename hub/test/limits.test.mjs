import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_LIMITS, Limits, RetryableError } from '../dist/limits.js';
import { RETRY_CODE, RETRY_TEXT, TIMEOUT_TEXT } from '../dist/server.js';
import { fakePool, rpc, startHub, startIntrospection } from './harness.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const ok = () => Promise.resolve('ok');

describe('limits', () => {
  it('defaults are 30 calls a minute, 2 concurrent per principal and 4 per service', () => {
    assert.deepEqual(DEFAULT_LIMITS, { ratePerMinute: 30, perPrincipalConcurrency: 2, perServiceConcurrency: 4 });
  });

  it('31st call within a minute is refused', async () => {
    let now = 1_000_000;
    const limits = new Limits({ ...DEFAULT_LIMITS, now: () => now });
    for (let i = 0; i < 30; i++) {
      now += 1000;
      assert.equal(await limits.run('alice', 'crz', ok), 'ok');
    }
    let ran = false;
    await assert.rejects(limits.run('alice', 'crz', async () => { ran = true; }), RetryableError);
    assert.equal(ran, false);
    // The window is per principal and service.
    assert.equal(await limits.run('bob', 'crz', ok), 'ok');
    assert.equal(await limits.run('alice', 'orsr', ok), 'ok');
    // Sliding: the first call leaves the window one minute after it was made.
    now = 1_000_000 + 1000 + 60_000;
    assert.equal(await limits.run('alice', 'crz', ok), 'ok');
    await assert.rejects(limits.run('alice', 'crz', ok), RetryableError);
  });

  it('third concurrent call for one principal is refused', async () => {
    const limits = new Limits(DEFAULT_LIMITS);
    const first = deferred();
    const second = deferred();
    const running = [limits.run('alice', 'crz', () => first.promise), limits.run('alice', 'crz', () => second.promise)];
    await assert.rejects(limits.run('alice', 'crz', ok), RetryableError);
    assert.equal(await limits.run('alice', 'orsr', ok), 'ok');
    first.resolve('one');
    assert.equal(await running[0], 'one');
    assert.equal(await limits.run('alice', 'crz', ok), 'ok');
    second.resolve('two');
    await running[1];
  });

  it('fifth concurrent call across principals for one service waits or is refused', async () => {
    const limits = new Limits(DEFAULT_LIMITS);
    const gate = deferred();
    const running = ['p1', 'p2', 'p3', 'p4'].map(p => limits.run(p, 'crz', () => gate.promise));
    // Refused (no queue), per the ruling.
    await assert.rejects(limits.run('p5', 'crz', ok), RetryableError);
    assert.equal(await limits.run('p5', 'orsr', ok), 'ok');
    gate.resolve('done');
    await Promise.all(running);
    assert.equal(await limits.run('p5', 'crz', ok), 'ok');
  });

  it('a failed call releases its slots', async () => {
    const limits = new Limits({ ratePerMinute: 30, perPrincipalConcurrency: 1, perServiceConcurrency: 1 });
    await assert.rejects(limits.run('alice', 'crz', async () => { throw new Error('runtime'); }), /runtime/);
    assert.equal(await limits.run('alice', 'crz', ok), 'ok');
  });
});

describe('hub limits and timeouts', () => {
  let introspection;
  before(async () => { introspection = await startIntrospection(); });
  after(async () => { await introspection.close(); });

  async function withHub(options, body) {
    const pool = options.pool ?? fakePool();
    const hub = await startHub({ issuer: introspection.issuer, pool, log: () => {}, ...options });
    try { await body(pool, hub); } finally {
      await hub.close();
      await pool.close();
    }
  }
  const search = { name: 'search_decisions', arguments: { query: 'nájom' } };

  it('a call over the limit returns the fixed retry text without reaching the runtime', async () => {
    introspection.issue('limit-token', 'judikaty');
    const limits = new Limits({ ratePerMinute: 1, perPrincipalConcurrency: 2, perServiceConcurrency: 4 });
    await withHub({ limits }, async (pool, hub) => {
      const first = await rpc(hub.port, 'judikaty', 'limit-token', 'tools/call', search);
      assert.equal(first.message.result.content[0].text, 'runtime:search_decisions');
      const second = await rpc(hub.port, 'judikaty', 'limit-token', 'tools/call', search);
      assert.equal(second.status, 200);
      assert.equal(second.message.result, undefined);
      assert.equal(second.message.error.message, RETRY_TEXT);
      assert.equal(RETRY_TEXT, 'Príliš veľa požiadaviek. Skúste to o chvíľu znova.');
      // A server-error code of its own, so clients can tell a retryable refusal from an internal error.
      assert.equal(second.message.error.code, RETRY_CODE);
      assert.equal(pool.runtimeCalls.length, 1);
      // The hub holds a lease on the runtime for the whole call, and releases it.
      assert.equal(pool.leaseCalls, 1);
      assert.equal(pool.activeLeases, 0);
    });
  });

  it('the retry code is a server error of its own, never one the SDK client reinterprets', () => {
    assert.equal(RETRY_CODE, -32029);
    assert.ok(RETRY_CODE <= -32000 && RETRY_CODE >= -32099, 'implementation-defined server-error range');
    for (const taken of [ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed, ErrorCode.InternalError, -32002])
      assert.notEqual(RETRY_CODE, taken);
  });

  it('a pool without an idle process maps to the same retry text on tools/list', async () => {
    introspection.issue('full-token', 'judikaty');
    const pool = { ...fakePool(), client: async () => { throw new RetryableError(); } };
    await withHub({ pool }, async (_pool, hub) => {
      const response = await rpc(hub.port, 'judikaty', 'full-token', 'tools/list');
      assert.equal(response.message.error.message, RETRY_TEXT);
      assert.equal(response.message.error.code, RETRY_CODE);
    });
  });

  it('runtime tools/call uses the configured timeout', async () => {
    introspection.issue('slow-token', 'judikaty');
    const pool = fakePool({ onCall: () => new Promise(resolve => setTimeout(resolve, 500)) });
    await withHub({ pool, callTimeoutMs: 50 }, async (_pool, hub) => {
      const response = await rpc(hub.port, 'judikaty', 'slow-token', 'tools/call', search);
      assert.equal(response.message.error.message, TIMEOUT_TEXT);
      assert.equal(pool.activeLeases, 0, 'the lease is released after a timed-out call');
    });
  });

  it('tools/list counts against the per-principal rate limit and never reaches the runtime over it', async () => {
    introspection.issue('list-limit-token', 'judikaty');
    const limits = new Limits({ ratePerMinute: 1, perPrincipalConcurrency: 2, perServiceConcurrency: 4 });
    await withHub({ limits }, async (pool, hub) => {
      const first = await rpc(hub.port, 'judikaty', 'list-limit-token', 'tools/list');
      assert.ok(Array.isArray(first.message.result.tools));
      const second = await rpc(hub.port, 'judikaty', 'list-limit-token', 'tools/list');
      assert.equal(second.message.error.message, RETRY_TEXT);
      assert.equal(second.message.error.code, RETRY_CODE);
      assert.equal(pool.leaseCalls, 1, 'the refused tools/list leased no runtime');
    });
  });

  it('tools/list is bounded by per-principal concurrency', async () => {
    introspection.issue('list-busy-token', 'judikaty');
    const gate = deferred();
    const limits = new Limits({ ratePerMinute: 30, perPrincipalConcurrency: 1, perServiceConcurrency: 4 });
    const pool = fakePool({ onList: () => gate.promise });
    await withHub({ pool, limits }, async (_pool, hub) => {
      const slow = rpc(hub.port, 'judikaty', 'list-busy-token', 'tools/list');
      await new Promise(resolve => setTimeout(resolve, 100));
      const refused = await rpc(hub.port, 'judikaty', 'list-busy-token', 'tools/list');
      assert.equal(refused.message.error.message, RETRY_TEXT);
      gate.resolve();
      assert.ok(Array.isArray((await slow).message.result.tools));
    });
  });

  it('runtime tools/list uses the configured call timeout, not the SDK default', async () => {
    introspection.issue('list-slow-token', 'judikaty');
    const pool = fakePool({ onList: () => new Promise(resolve => setTimeout(resolve, 500)) });
    await withHub({ pool, callTimeoutMs: 50 }, async (_pool, hub) => {
      const started = Date.now();
      const response = await rpc(hub.port, 'judikaty', 'list-slow-token', 'tools/list');
      assert.equal(response.message.error.message, TIMEOUT_TEXT);
      assert.ok(Date.now() - started < 450, 'answered at the configured timeout');
      assert.equal(pool.activeLeases, 0);
    });
  });

  it('the allow-without schema check is bounded by the call timeout too', async () => {
    introspection.issue('schema-slow-token', 'judikaty');
    const pool = fakePool({ onList: () => new Promise(resolve => setTimeout(resolve, 500)) });
    await withHub({ pool, callTimeoutMs: 50 }, async (_pool, hub) => {
      const response = await rpc(hub.port, 'judikaty', 'schema-slow-token', 'tools/call',
        { name: 'get_decision_full_text', arguments: { id: '1' } });
      assert.equal(response.message.error.message, TIMEOUT_TEXT);
      assert.equal(pool.runtimeCalls.length, 0);
    });
  });
});
