// Shared test harness: a fake introspection endpoint, a fake runtime pool and an HTTP helper.
import { createServer, request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadManifest } from '../dist/manifest.js';
import { createHub } from '../dist/server.js';

const here = dirname(fileURLToPath(import.meta.url));
export const manifest = loadManifest(join(here, '..', 'services.json'));
export const BASE = 'example.test';
export const resourceOf = id => `https://${id}.${BASE}/mcp`;
// Distinct per-service secrets (at least 32 characters, no whitespace) so that a mixed-up secret fails.
export const secrets = Object.fromEntries(['orsr', 'crz', 'judikaty'].map(id => [id, `${id}-test-secret-`.padEnd(40, 'x')]));

// Tools exposed by the fake runtime, using real names from services.json (judikaty) plus one unlisted tool.
export const RUNTIME_TOOLS = [
  { name: 'search_decisions', description: 'allow', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'manage_watchlist', description: 'deny-remote', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
  {
    name: 'get_decision_full_text', description: 'allow-without',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, savePath: { type: 'string' }, saveToDefaultPath: { type: 'boolean' } },
      required: ['id', 'savePath'],
    },
  },
  { name: 'brand_new_tool', description: 'absent from the manifest', inputSchema: { type: 'object', properties: {} } },
];

/** Fake authorization server: checks the per-resource secret and returns stored claims as they are. */
export async function startIntrospection() {
  const tokens = new Map();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const resource = form.get('resource');
      const id = Object.keys(secrets).find(key => resourceOf(key) === resource);
      if (req.method !== 'POST' || req.url !== '/resource/introspect' || !id ||
          req.headers.authorization !== `Bearer ${secrets[id]}`) {
        res.writeHead(401).end();
        return;
      }
      const claims = tokens.get(form.get('token')) ?? { active: false };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(claims));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const issue = (token, id, sub = 'user-1') => {
    tokens.set(token, {
      active: true, iss: issuer, aud: resourceOf(id), sub, tenant: 'firm',
      scope: 'mcp:tools', exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return { issuer, resource: resourceOf(id), sub, tenant: 'firm' };
  };
  return { issuer, issue, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Fake pool: one in-memory MCP runtime per (principal, service); records every client() and runtime call. */
export function fakePool() {
  const clientCalls = [];
  const runtimeCalls = [];
  const clients = new Map();
  return {
    clientCalls,
    runtimeCalls,
    async client(principal, id) {
      clientCalls.push({ principal, id });
      const key = JSON.stringify([principal, id]);
      if (!clients.has(key)) {
        const runtime = new Server({ name: 'fake-runtime', version: '1.0.0' }, { capabilities: { tools: {} } });
        runtime.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: RUNTIME_TOOLS }));
        runtime.setRequestHandler(CallToolRequestSchema, async request => {
          runtimeCalls.push({ principal, id, name: request.params.name, arguments: request.params.arguments });
          return { content: [{ type: 'text', text: `runtime:${request.params.name}` }] };
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await runtime.connect(serverTransport);
        const client = new Client({ name: 'hub-test', version: '1.0.0' });
        await client.connect(clientTransport);
        clients.set(key, client);
      }
      return clients.get(key);
    },
    async stopPrincipal() {},
    async close() {
      for (const client of clients.values()) await client.close();
    },
  };
}

export async function startHub({ issuer, pool, log }) {
  const app = createHub({ base: BASE, issuer, manifest, secrets, pool, allowHttpForTests: true, log });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Plain node:http request so that the Host header is sent exactly as given. */
export function send(port, { host, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port, method, path, setHost: false,
      headers: {
        host,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** One JSON-RPC request over Streamable HTTP; returns the HTTP response and the parsed JSON-RPC message. */
export async function rpc(port, id, token, method, params = {}, headers = {}) {
  const response = await send(port, {
    host: `${id}.${BASE}`, method: 'POST', path: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', ...headers },
    body: { jsonrpc: '2.0', id: 1, method, params },
  });
  let message;
  if (response.status === 200) {
    const type = response.headers['content-type'] ?? '';
    const json = type.includes('text/event-stream')
      ? response.text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('')
      : response.text;
    message = JSON.parse(json);
  }
  return { ...response, message };
}
