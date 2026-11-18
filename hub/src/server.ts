import { createHash } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_LIMITS, Limits, RetryableError } from './limits.js';
import type { Manifest, ServiceId, ToolPolicy } from './manifest.js';
import { DENY_TEXT, checkCall, listedTools, schemaCovers, withoutArgumentsOf } from './policy.js';
import { createSharedAuth, loadSharedAuthConfig, principalKey, runWithIdentity } from './resource-auth.js';
import type { VerifiedIdentity } from './resource-auth.js';
import { resourceUrl, routeHost } from './routing.js';
import type { RuntimePool } from './types.js';

export interface HubOptions {
  /** Deployment base domain; service `id` is served on `<id>.<base>`. */
  base: string;
  /** Bare origin of the authorization server. */
  issuer: string;
  manifest: Manifest;
  /** Introspection secret per enabled service; only these services are routed. */
  secrets: Record<ServiceId, string>;
  pool: RuntimePool;
  /** Passed to the adapter's config validation only; permits an HTTP issuer in tests. */
  allowHttpForTests?: boolean;
  /** Receives one JSON line per tools/call; defaults to stdout. */
  log?: (line: string) => void;
  /** Rate and concurrency limits for tools/call; defaults to DEFAULT_LIMITS. */
  limits?: Limits;
  /** Timeout of one runtime tools/call in milliseconds, reset by runtime progress; defaults to 120000. */
  callTimeoutMs?: number;
}

interface Service {
  id: ServiceId;
  tools: Readonly<Record<string, ToolPolicy>>;
  auth: ReturnType<typeof createSharedAuth>;
}

const METADATA_PATHS = ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'];
// Tool names absent from the manifest come from the client; they are not written to logs.
const UNLISTED_TOOL = '(unlisted)';
const BODY_LIMIT = '1mb';
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
// Bounds the token-hash → principal map used to stop a disabled principal's runtimes.
const MAX_REMEMBERED_TOKENS = 10_000;
// The adapter's bearer syntax; other headers never authenticate, so they are never remembered.
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

/** Short, stable, non-reversible principal label for logs. */
export const principalHash = (principal: string): string =>
  createHash('sha256').update(principal).digest('hex').slice(0, 16);

function createServices(opts: HubOptions): Map<ServiceId, Service> {
  const services = new Map<ServiceId, Service>();
  for (const id of Object.keys(opts.secrets)) {
    if (!Object.hasOwn(opts.manifest.services, id)) throw new Error(`Service ${id} has a secret but no manifest entry`);
    // The adapter's own validation: HTTPS issuer origin, exact /mcp resource, secret length.
    const config = loadSharedAuthConfig({
      MCP_AUTH_MODE: 'shared-oauth',
      SKALLARS_AUTH_ISSUER: opts.issuer,
      SKALLARS_AUTH_RESOURCE: resourceUrl(id, opts.base),
      SKALLARS_AUTH_SECRET: opts.secrets[id],
    }, { allowHttpForTests: opts.allowHttpForTests === true });
    if (!config) throw new Error(`Service ${id}: shared auth configuration missing`);
    services.set(id, { id, tools: opts.manifest.services[id].tools, auth: createSharedAuth({ ...config, allowedOrigins: [] }) });
  }
  return services;
}

// Client-facing texts for failures. Internal error text (paths, principals, runtime messages)
// never crosses the hub, which is the trust boundary.
export const INTERNAL_ERROR_TEXT = 'Služba je dočasne nedostupná. Skúste to znova neskôr.';
export const TIMEOUT_TEXT = 'Služba neodpovedala včas. Skúste to znova.';
export const INVALID_PARAMS_TEXT = 'Neplatné argumenty nástroja.';
export const RETRY_TEXT = 'Príliš veľa požiadaviek. Skúste to o chvíľu znova.';
/** JSON-RPC server-error code (implementation-defined range) of the retryable refusal. */
export const RETRY_CODE = -32001;
// Bounds the runtime tools/list pages read to check one allow-without schema.
const MAX_LIST_PAGES = 20;

/**
 * A JSON-RPC error whose message is sent as is. (McpError would prefix "MCP error <code>: ";
 * the SDK serializes any thrown error as { code, message }.)
 */
class PublicError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function publicError(error: unknown): PublicError {
  if (error instanceof RetryableError) return new PublicError(RETRY_CODE, RETRY_TEXT);
  const code = error instanceof McpError ? error.code : undefined;
  if (code === ErrorCode.RequestTimeout) return new PublicError(ErrorCode.RequestTimeout, TIMEOUT_TEXT);
  if (code === ErrorCode.InvalidParams) return new PublicError(ErrorCode.InvalidParams, INVALID_PARAMS_TEXT);
  return new PublicError(ErrorCode.InternalError, INTERNAL_ERROR_TEXT);
}

/** Reads the runtime's own listing of one tool, so an allow-without policy is checked against its real schema. */
async function runtimeTool(client: Client, name: string, signal: AbortSignal) {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
      ListToolsResultSchema, { signal });
    const tool = result.tools.find(entry => entry.name === name);
    if (tool || result.nextCursor === undefined) return tool;
    cursor = result.nextCursor;
  }
  return undefined;
}

interface Proxy {
  pool: RuntimePool;
  limits: Limits;
  callTimeoutMs: number;
  log: (line: string) => void;
}

/** One MCP server per request, proxying tools/list and tools/call to the principal's runtime under the policy. */
function createMcpServer(service: Service, principal: string, { pool, limits, callTimeoutMs, log }: Proxy): Server {
  const server = new Server({ name: `lawoss-${service.id}`, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    try {
      const { client, release } = await pool.lease(principal, service.id);
      try {
        const cursor = request.params?.cursor;
        const result = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
          ListToolsResultSchema, { signal: extra.signal });
        return { ...result, tools: listedTools(service.tools, result.tools) };
      } finally {
        release();
      }
    } catch (error) {
      throw publicError(error);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const started = performance.now();
    const { name, arguments: args } = request.params;
    const write = (status: string) => log(JSON.stringify({
      time: new Date().toISOString(),
      service: service.id,
      tool: Object.hasOwn(service.tools, name) ? name : UNLISTED_TOOL,
      durationMs: Math.round(performance.now() - started),
      status,
      principal: principalHash(principal),
    }));
    const refuse = (text: string) => {
      write('denied');
      return { content: [{ type: 'text' as const, text }], isError: true };
    };
    const decision = checkCall(service.tools, name, args);
    if (!decision.allowed) return refuse(decision.text);
    try {
      return await limits.run(principal, service.id, async () => {
        // Leased for the whole call, so the process cannot be evicted between the schema check and the call.
        const { client, release } = await pool.lease(principal, service.id);
        try {
          const without = withoutArgumentsOf(service.tools, name);
          if (without.length > 0) {
            // Fail closed when the manifest names an argument the runtime schema does not have.
            const tool = await runtimeTool(client, name, extra.signal);
            if (!tool || !schemaCovers(tool, without)) return refuse(DENY_TEXT);
          }
          // Only name and arguments are forwarded; client _meta (for example progress tokens) stays here.
          // The hub's own progress handler lets runtime progress reset the timeout.
          const result = await client.request({ method: 'tools/call', params: { name, arguments: args } },
            CallToolResultSchema, { signal: extra.signal, timeout: callTimeoutMs, resetTimeoutOnProgress: true, onprogress: () => {} });
          write(result.isError ? 'tool-error' : 'ok');
          return result;
        } finally {
          release();
        }
      });
    } catch (error) {
      write(error instanceof RetryableError ? 'limited' : 'failed');
      throw publicError(error);
    }
  });
  return server;
}

/**
 * Remembers which principal each accepted token (per service, by hash) belonged to. Introspection of a
 * disabled account answers only "inactive", without a subject, so a known token that turns inactive
 * before its expiry is the signal to stop that principal's runtimes.
 */
function rememberedTokens(pool: RuntimePool) {
  const known = new Map<string, { principal: string; exp: number }>();
  const keyOf = (id: ServiceId, authorization: string | undefined): string | undefined => {
    const token = typeof authorization === 'string' ? BEARER.exec(authorization)?.[1] : undefined;
    return token === undefined ? undefined : createHash('sha256').update(`${id}\0${token}`).digest('hex');
  };
  const live = (exp: number) => exp > Date.now() / 1000;
  return {
    accepted(id: ServiceId, authorization: string | undefined, identity: VerifiedIdentity): void {
      const key = keyOf(id, authorization);
      if (key === undefined) return;
      known.delete(key);
      if (known.size >= MAX_REMEMBERED_TOKENS)
        for (const [old, entry] of known) if (!live(entry.exp)) known.delete(old);
      // Still full: forget the oldest entry (Map keeps insertion order).
      if (known.size >= MAX_REMEMBERED_TOKENS) known.delete(known.keys().next().value as string);
      known.set(key, { principal: principalKey(identity), exp: identity.exp });
    },
    rejected(id: ServiceId, authorization: string | undefined): void {
      const key = keyOf(id, authorization);
      const entry = key === undefined ? undefined : known.get(key);
      if (!entry) return;
      known.delete(key as string);
      // An expired token is ordinary refresh, not a disabled account.
      if (live(entry.exp)) pool.stopPrincipal(entry.principal).catch(() => {});
    },
  };
}

export function createHub(opts: HubOptions): express.Express {
  const services = createServices(opts);
  const ids = new Set(services.keys());
  const log = opts.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1) throw new Error('callTimeoutMs must be a positive integer');
  const proxy: Proxy = { pool: opts.pool, limits: opts.limits ?? new Limits(DEFAULT_LIMITS), callTimeoutMs, log };
  const tokens = rememberedTokens(opts.pool);
  const app = express();
  app.disable('x-powered-by');

  // Route by the raw Host header (never X-Forwarded-Host), then apply the adapter's Host/Origin check.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = routeHost(req.headers.host, opts.base, ids);
    const service = id === undefined ? undefined : services.get(id);
    if (!service) { res.status(404).end(); return; }
    if (!service.auth.checkRequest(req)) { res.status(403).end(); return; }
    res.locals.service = service;
    next();
  });

  app.get(METADATA_PATHS, (_req: Request, res: Response) => {
    res.json((res.locals.service as Service).auth.metadata());
  });

  app.all('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    const service = res.locals.service as Service;
    const identity = await service.auth.authenticate(req);
    if (!identity) {
      tokens.rejected(service.id, req.headers.authorization);
      res.status(401).set('WWW-Authenticate', service.auth.challenge).end();
      return;
    }
    // Stateless transport: no standalone SSE stream (GET) and no session to delete.
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').end();
      return;
    }
    tokens.accepted(service.id, req.headers.authorization, identity);
    res.locals.identity = identity;
    next();
  }, express.json({ limit: BODY_LIMIT }), async (req: Request, res: Response) => {
    const service = res.locals.service as Service;
    const identity = res.locals.identity as VerifiedIdentity;
    await runWithIdentity(identity, async () => {
      const server = createMcpServer(service, principalKey(identity), proxy);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  });

  // Body parse and handler errors: status only, never the request or a stack trace.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: unknown })?.status;
    if (!res.headersSent) res.status(typeof status === 'number' && status >= 400 && status < 600 ? status : 500).end();
    else res.end();
  });

  return app;
}
