import type { ServiceId } from './manifest.js';

/** Over a limit or cap: the call is refused (not queued) and the client may retry shortly. */
export class RetryableError extends Error {
  constructor(message = 'Limit reached') {
    super(message);
    this.name = 'RetryableError';
  }
}

export interface LimitOptions {
  /** Calls per principal and service in any sliding 60-second window. */
  ratePerMinute: number;
  /** Concurrent calls per principal and service. */
  perPrincipalConcurrency: number;
  /** Concurrent outbound calls per service across all principals. */
  perServiceConcurrency: number;
  /** Clock in milliseconds; tests may replace it. */
  now?: () => number;
}

export const DEFAULT_LIMITS = Object.freeze({ ratePerMinute: 30, perPrincipalConcurrency: 2, perServiceConcurrency: 4 });

const WINDOW_MS = 60_000;

const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

export class Limits {
  private readonly rate: number;
  private readonly perPrincipal: number;
  private readonly perService: number;
  private readonly now: () => number;
  /** Start times of recent calls per (principal, service), oldest first. */
  private readonly calls = new Map<string, number[]>();
  private readonly running = new Map<string, number>();
  private readonly runningPerService = new Map<ServiceId, number>();

  constructor(opts: LimitOptions) {
    this.rate = positive('ratePerMinute', opts.ratePerMinute);
    this.perPrincipal = positive('perPrincipalConcurrency', opts.perPrincipalConcurrency);
    this.perService = positive('perServiceConcurrency', opts.perServiceConcurrency);
    this.now = opts.now ?? Date.now;
  }

  /** Runs `fn` if every limit allows it; otherwise throws RetryableError without running it. */
  async run<T>(principal: string, id: ServiceId, fn: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([principal, id]);
    const now = this.now();
    const recent = (this.calls.get(key) ?? []).filter(time => time > now - WINDOW_MS);
    if (recent.length >= this.rate || (this.running.get(key) ?? 0) >= this.perPrincipal ||
        (this.runningPerService.get(id) ?? 0) >= this.perService) {
      this.store(key, recent);
      throw new RetryableError();
    }
    recent.push(now);
    this.store(key, recent);
    adjust(this.running, key, 1);
    adjust(this.runningPerService, id, 1);
    try {
      return await fn();
    } finally {
      adjust(this.running, key, -1);
      adjust(this.runningPerService, id, -1);
    }
  }

  private store(key: string, recent: number[]): void {
    if (recent.length === 0) this.calls.delete(key);
    else this.calls.set(key, recent);
  }
}

function adjust<K>(counts: Map<K, number>, key: K, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
}
