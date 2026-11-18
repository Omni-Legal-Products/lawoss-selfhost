import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RetryableError } from './limits.js';
import type { Manifest, ServiceId } from './manifest.js';
import type { Lease, RuntimePool } from './types.js';

export interface PoolOptions {
  /** fetch-runtimes output: `<runtimesDir>/<plugin>/scripts/run.mjs`. */
  runtimesDir: string;
  /** Per-principal directories are created under it as `<sha256(principal)>/<service>/`. */
  dataDir: string;
  /** Resolves each service's plugin, launcher server and state variable. */
  manifest: Manifest;
  maxTotal: number;
  maxPerService: number;
  idleMs: number;
  /** The service's own variables (see allowlistedEnv); the pool's directory and cache keys override them. */
  envFor(id: ServiceId): Record<string, string>;
  /** Shared read-only dependency cache read by the launcher; defaults to the hub's LAWOSS_CACHE_DIR. */
  cacheDir?: string;
  /** PATH for runtimes; defaults to the hub's PATH. */
  path?: string;
}

export const DEFAULT_POOL = Object.freeze({ maxTotal: 40, maxPerService: 8, idleMs: 10 * 60_000 });

/** envFor that passes only the service's manifest-listed variables, taken from `source`. */
export function allowlistedEnv(manifest: Manifest, source: NodeJS.ProcessEnv = process.env) {
  return (id: ServiceId): Record<string, string> => {
    const env: Record<string, string> = {};
    const names = Object.hasOwn(manifest.services, id) ? manifest.services[id].env : [];
    for (const name of names) {
      const value = source[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  };
}

interface Entry {
  key: string;
  principal: string;
  id: ServiceId;
  ready: Promise<Client>;
  started: boolean;
  inFlight: number;
  /** Hub calls holding the process; a leased process is busy even between its requests. */
  leases: number;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
  gone: boolean;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

/**
 * One stdio runtime process per (principal, service), started on first use and stopped when idle.
 * Over a cap the least recently used idle process stops; with none idle the call is refused.
 */
export class ProcessPool implements RuntimePool {
  private readonly entries = new Map<string, Entry>();
  private readonly runtimesDir: string;
  private readonly dataDir: string;
  private readonly cacheDir: string;
  private readonly path: string | undefined;
  private readonly maxTotal: number;
  private readonly maxPerService: number;
  private readonly idleMs: number;
  private clock = 0;

  constructor(private readonly opts: PoolOptions) {
    const cacheDir = opts.cacheDir ?? process.env.LAWOSS_CACHE_DIR;
    // Without it the launcher would install dependencies into each principal's HOME.
    if (!cacheDir) throw new Error('LAWOSS_CACHE_DIR is required');
    this.cacheDir = resolve(cacheDir);
    this.runtimesDir = resolve(opts.runtimesDir);
    this.dataDir = resolve(opts.dataDir);
    this.path = opts.path ?? process.env.PATH;
    this.maxTotal = positive('maxTotal', opts.maxTotal);
    this.maxPerService = positive('maxPerService', opts.maxPerService);
    this.idleMs = positive('idleMs', opts.idleMs);
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Holds the principal's runtime for one hub call, starting it if needed. Until release() the
   * process is neither evicted nor idle-stopped, including between the call's requests.
   */
  async lease(principal: string, id: ServiceId): Promise<Lease> {
    const entry = this.entry(principal, id);
    // Taken before any await, so the process cannot be evicted while it starts.
    entry.leases++;
    clearTimeout(entry.timer);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.leases--;
      entry.lastUsed = ++this.clock;
      this.arm(entry);
    };
    try {
      return { client: await entry.ready, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** The runtime client without a lease: busy only while a request is in flight. */
  async client(principal: string, id: ServiceId): Promise<Client> {
    return this.entry(principal, id).ready;
  }

  /** The current entry, or a new starting one; synchronous, so concurrent calls neither double-start nor overfill. */
  private entry(principal: string, id: ServiceId): Entry {
    if (!Object.hasOwn(this.opts.manifest.services, id)) throw new Error(`Unknown service ${id}`);
    const key = JSON.stringify([principal, id]);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const evicted = this.makeRoom(id).map(entry => this.stop(entry));
    const entry: Entry = {
      key, principal, id, ready: undefined as never, started: false, inFlight: 0, leases: 0, lastUsed: ++this.clock, gone: false,
    };
    this.entries.set(key, entry);
    entry.ready = this.start(entry, evicted);
    return entry;
  }

  async stopPrincipal(principal: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter(entry => entry.principal === principal).map(entry => this.stop(entry)));
  }

  /** Picks the processes to stop so that one more fits; throws RetryableError if they are not idle. */
  private makeRoom(id: ServiceId): Entry[] {
    const victims: Entry[] = [];
    const remaining = (sameService: boolean) => [...this.entries.values()]
      .filter(entry => !victims.includes(entry) && (!sameService || entry.id === id));
    const evictFrom = (candidates: Entry[]) => {
      const idle = candidates.filter(entry => entry.started && entry.inFlight === 0 && entry.leases === 0);
      if (idle.length === 0) throw new RetryableError('No idle runtime process to stop');
      victims.push(idle.reduce((oldest, entry) => entry.lastUsed < oldest.lastUsed ? entry : oldest));
    };
    // Same service first: that eviction also counts toward the total, so nothing extra stops.
    while (remaining(true).length >= this.maxPerService) evictFrom(remaining(true));
    while (remaining(false).length >= this.maxTotal) evictFrom(remaining(false));
    return victims;
  }

  private async start(entry: Entry, evicted: Promise<void>[]): Promise<Client> {
    const service = this.opts.manifest.services[entry.id];
    // Hashed so that the principal string (which contains URLs) never becomes a path.
    const dir = join(this.dataDir, sha256(entry.principal), entry.id);
    const env: Record<string, string | undefined> = {
      ...this.opts.envFor(entry.id),
      HOME: dir,
      TMPDIR: dir,
      PATH: this.path,
      LAWOSS_CACHE_DIR: this.cacheDir,
      // The launcher's state and working directory (it chdirs to <LAWOSS_STATE_DIR>/<runtime name>).
      LAWOSS_STATE_DIR: dir,
      ...(service.stateEnv ? { [service.stateEnv]: dir } : {}),
    };
    // The SDK merges its default inherited variables (USER, SHELL, ...) under `env`; an undefined
    // value makes spawn drop the key, so the runtime sees only what is listed here.
    for (const name of DEFAULT_INHERITED_ENV_VARS) if (!(name in env)) env[name] = undefined;
    const launcher = join(this.runtimesDir, service.plugin, 'scripts', 'run.mjs');
    const client = new Client({ name: 'lawoss-hub', version: '0.1.0' });
    try {
      await Promise.all(evicted);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      client.onclose = () => this.forget(entry);
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [launcher, ...(service.server ? ['--server', service.server] : []), 'mcp'],
        cwd: dir,
        env: env as Record<string, string>,
        // Runtime output may contain arguments or results, which the hub never logs.
        stderr: 'ignore',
      }));
    } catch (error) {
      this.forget(entry);
      await client.close().catch(() => {});
      throw error;
    }
    this.track(entry, client);
    entry.started = true;
    this.arm(entry);
    return client;
  }

  /** Counts calls in flight and restarts the idle timer around every request the hub makes. */
  private track(entry: Entry, client: Client): void {
    const request = client.request.bind(client);
    client.request = ((...args: Parameters<typeof request>) => {
      entry.inFlight++;
      entry.lastUsed = ++this.clock;
      clearTimeout(entry.timer);
      return request(...args).finally(() => {
        entry.inFlight--;
        entry.lastUsed = ++this.clock;
        this.arm(entry);
      });
    }) as typeof client.request;
  }

  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    if (entry.gone || entry.inFlight > 0 || entry.leases > 0) return;
    entry.timer = setTimeout(() => { void this.stop(entry); }, this.idleMs);
    entry.timer.unref?.();
  }

  /** Removes the entry (if it is still the current one for its key) so the next client() starts afresh. */
  private forget(entry: Entry): void {
    entry.gone = true;
    clearTimeout(entry.timer);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  /** Never rejects: callers stop processes fire-and-forget (idle timer, eviction, disabled principal). */
  private async stop(entry: Entry): Promise<void> {
    this.forget(entry);
    const client = await entry.ready.catch(() => undefined);
    // The entry is already gone; a failed close leaves nothing for the caller to act on.
    await client?.close().catch(() => {});
  }
}
