// Process entry point of the hub image: reads HUB_CONFIG_JSON, verifies the baked runtimes against
// their provenance, builds the process pool and limits, and serves the hub on PORT.
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { verifyRuntimeDir } from '../scripts/runtime-verify.mjs';
import { DEFAULT_LIMITS, Limits } from './limits.js';
import { loadManifest } from './manifest.js';
import type { Manifest, ServiceId } from './manifest.js';
import { DEFAULT_POOL, ProcessPool, allowlistedEnv } from './pool.js';
import type { RuntimeExit } from './pool.js';
import { DEFAULT_CALL_TIMEOUT_MS, createHub, principalHash } from './server.js';

/** The reviewed manifest baked into the image next to dist/; deliberately not configurable. */
const SERVICES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'services.json');

export const DEFAULT_HUB_LIMITS = Object.freeze({
  ratePerMinute: DEFAULT_LIMITS.ratePerMinute,
  perPrincipalConcurrency: DEFAULT_LIMITS.perPrincipalConcurrency,
  perServiceConcurrency: DEFAULT_LIMITS.perServiceConcurrency,
  maxTotal: DEFAULT_POOL.maxTotal,
  maxPerService: DEFAULT_POOL.maxPerService,
  idleMs: DEFAULT_POOL.idleMs,
  callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
});

export type HubLimits = { -readonly [K in keyof typeof DEFAULT_HUB_LIMITS]: number };

export interface HubConfig {
  /** Deployment base domain; service `id` is served on `<id>.<base>`. */
  base: string;
  /** Bare HTTPS origin of `auth.<base>`. */
  issuer: string;
  /** Enabled services; exactly the keys of `secrets`. */
  services: ServiceId[];
  /** Introspection secret per enabled service. */
  secrets: Record<ServiceId, string>;
  limits: HubLimits;
}

/** A configuration error. Messages name fields only, never values (the config holds secrets). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`HUB_CONFIG_JSON ${message}`);
    this.name = 'ConfigError';
  }
}

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The adapter's own rule for introspection secrets.
const SECRET = /^\S{32,}$/;
const CONFIG_FIELDS = new Set(['base', 'issuer', 'services', 'secrets', 'limits']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
// Field names are printed only when they look like identifiers, so a value pasted as a key is not echoed.
const fieldName = (key: string): string => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : '(unnamed)';

function onlyKnown(where: string, value: Record<string, unknown>, known: Set<string>): void {
  const unknown = Object.keys(value).find(key => !known.has(key));
  if (unknown !== undefined) throw new ConfigError(`${where}has an unknown field ${fieldName(unknown)}`);
}

function parseLimits(raw: unknown): HubLimits {
  if (raw === undefined) return { ...DEFAULT_HUB_LIMITS };
  if (!isObject(raw)) throw new ConfigError('limits must be an object');
  onlyKnown('limits ', raw, new Set(Object.keys(DEFAULT_HUB_LIMITS)));
  const limits: HubLimits = { ...DEFAULT_HUB_LIMITS };
  for (const name of Object.keys(DEFAULT_HUB_LIMITS) as (keyof HubLimits)[]) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw new ConfigError(`limits.${name} must be a positive integer`);
    limits[name] = value;
  }
  if (limits.maxPerService > limits.maxTotal) throw new ConfigError('limits.maxPerService must not exceed maxTotal');
  return limits;
}

/** Parses and validates HUB_CONFIG_JSON against the manifest. `allowHttpForTests` is never accepted. */
export function parseHubConfig(raw: string | undefined, manifest: Manifest): HubConfig {
  if (raw === undefined || raw.trim() === '') throw new ConfigError('is required');
  let value: unknown;
  // JSON.parse messages quote the input, so they are never passed on.
  try { value = JSON.parse(raw); } catch { throw new ConfigError('is not valid JSON'); }
  if (!isObject(value)) throw new ConfigError('must be a JSON object');
  onlyKnown('', value, CONFIG_FIELDS);

  const { base, issuer, services, secrets } = value;
  if (typeof base !== 'string' || !DNS_NAME.test(base)) throw new ConfigError('base must be a lowercase DNS name');
  if (issuer !== `https://auth.${base}`) throw new ConfigError('issuer must be the bare origin https://auth.<base>');
  if (!Array.isArray(services) || services.length === 0 ||
      services.some(id => typeof id !== 'string' || !Object.hasOwn(manifest.services, id)) ||
      new Set(services).size !== services.length)
    throw new ConfigError('services must be a non-empty list of distinct service ids from the manifest');
  if (!isObject(secrets)) throw new ConfigError('secrets must be an object');
  const ids = services as string[];
  if (Object.keys(secrets).length !== ids.length || ids.some(id => !Object.hasOwn(secrets, id)))
    throw new ConfigError('secrets must have exactly one entry per enabled service');
  for (const id of ids)
    if (typeof secrets[id] !== 'string' || !SECRET.test(secrets[id] as string))
      throw new ConfigError(`secrets.${id} must be at least 32 characters without whitespace`);
  return {
    base,
    issuer,
    services: [...ids],
    secrets: Object.fromEntries(ids.map(id => [id, secrets[id] as string])),
    limits: parseLimits(value.limits),
  };
}

/** Verifies the fetched runtime of every enabled service against its provenance (as at image build). */
export function verifyRuntimes(runtimesDir: string, manifest: Manifest, ids: ServiceId[]): void {
  const plugins = new Set(ids.map(id => manifest.services[id].plugin));
  for (const plugin of [...plugins].sort()) verifyRuntimeDir(runtimesDir, plugin);
}

/** One structured line per runtime exit: service, principal hash, exit code or signal. */
export function exitLogLine(event: RuntimeExit): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    event: 'runtime-exit',
    service: event.id,
    principal: principalHash(event.principal),
    code: event.code,
    signal: event.signal,
  });
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try { return LOOPBACK.has(new URL(`http://${host}`).hostname); } catch { return false; }
}

/**
 * Adds a status-only /health for the container healthcheck in front of the hub. It answers only a
 * loopback Host, which the proxy never forwards, so it is not reachable on a service hostname.
 */
export function withHealth(hub: express.Express): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (req: Request, res: Response, next: NextFunction) => {
    if (!isLoopbackHost(req.headers.host)) { next(); return; }
    res.json({ status: 'ok' });
  });
  app.use(hub);
  return app;
}

function requiredPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number');
  return port;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const manifest = loadManifest(SERVICES_PATH);
  const config = parseHubConfig(env.HUB_CONFIG_JSON, manifest);
  const runtimesDir = requiredPath(env, 'LAWOSS_RUNTIMES_DIR');
  const cacheDir = requiredPath(env, 'LAWOSS_CACHE_DIR');
  const dataDir = resolve(env.LAWOSS_DATA_DIR || '/data');
  const port = parsePort(env.PORT);
  verifyRuntimes(runtimesDir, manifest, config.services);

  const log = (line: string) => { process.stdout.write(`${line}\n`); };
  // Provider keys reach a runtime only through its manifest allowlist; empty values count as unset.
  const providerEnv = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const { limits } = config;
  const pool = new ProcessPool({
    runtimesDir, dataDir, cacheDir, manifest,
    maxTotal: limits.maxTotal,
    maxPerService: limits.maxPerService,
    idleMs: limits.idleMs,
    envFor: allowlistedEnv(manifest, providerEnv),
    path: env.PATH,
    onExit: event => log(exitLogLine(event)),
  });
  const hub = createHub({
    base: config.base,
    issuer: config.issuer,
    manifest,
    secrets: config.secrets,
    pool,
    limits: new Limits({
      ratePerMinute: limits.ratePerMinute,
      perPrincipalConcurrency: limits.perPrincipalConcurrency,
      perServiceConcurrency: limits.perServiceConcurrency,
    }),
    callTimeoutMs: limits.callTimeoutMs,
    log,
  });

  const server = withHealth(hub).listen(port, '0.0.0.0');
  await once(server, 'listening');
  log(JSON.stringify({ time: new Date().toISOString(), event: 'listening', port: (server.address() as AddressInfo).port }));
  // Shutdown: stop accepting, let calls in flight finish briefly, then stop every runtime process
  // before exiting (within Docker's default 10 s stop grace period).
  let draining: Promise<void> | undefined;
  const drain = () => { draining ??= pool.stopAll().finally(() => process.exit(0)); };
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      server.close(drain);
      server.closeIdleConnections();
      setTimeout(drain, 4_000).unref();
      setTimeout(() => process.exit(0), 9_000).unref();
    });
  return server;
}

const invokedDirectly = (): boolean => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
};

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    // Config errors carry no values; other start-up errors name files or variables only.
    process.stderr.write(`hub: ${error instanceof Error ? error.message : 'start-up failed'}\n`);
    process.exit(1);
  });
}
