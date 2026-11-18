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

const principalHash = (principal: string): string =>
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

/** One MCP server per request, proxying tools/list and tools/call to the principal's runtime under the policy. */
function createMcpServer(service: Service, principal: string, pool: RuntimePool, log: (line: string) => void): Server {
  const server = new Server({ name: `lawoss-${service.id}`, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    try {
      const client = await pool.client(principal, service.id);
      const cursor = request.params?.cursor;
      const result = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
        ListToolsResultSchema, { signal: extra.signal });
      return { ...result, tools: listedTools(service.tools, result.tools) };
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
      const client = await pool.client(principal, service.id);
      const without = withoutArgumentsOf(service.tools, name);
      if (without.length > 0) {
        // Fail closed when the manifest names an argument the runtime schema does not have.
        const tool = await runtimeTool(client, name, extra.signal);
        if (!tool || !schemaCovers(tool, without)) return refuse(DENY_TEXT);
      }
      // Only name and arguments are forwarded; client _meta (for example progress tokens) stays here.
      const result = await client.request({ method: 'tools/call', params: { name, arguments: args } },
        CallToolResultSchema, { signal: extra.signal });
      write(result.isError ? 'tool-error' : 'ok');
      return result;
    } catch (error) {
      write('failed');
      throw publicError(error);
    }
  });
  return server;
}

export function createHub(opts: HubOptions): express.Express {
  const services = createServices(opts);
  const ids = new Set(services.keys());
  const log = opts.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
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
      res.status(401).set('WWW-Authenticate', service.auth.challenge).end();
      return;
    }
    // Stateless transport: no standalone SSE stream (GET) and no session to delete.
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').end();
      return;
    }
    res.locals.identity = identity;
    next();
  }, express.json({ limit: BODY_LIMIT }), async (req: Request, res: Response) => {
    const service = res.locals.service as Service;
    const identity = res.locals.identity as VerifiedIdentity;
    await runWithIdentity(identity, async () => {
      const server = createMcpServer(service, principalKey(identity), opts.pool, log);
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
