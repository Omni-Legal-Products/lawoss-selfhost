import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServiceId } from './manifest.js';

/** A runtime client held for one hub call; the process is not stopped while a lease is held. */
export interface Lease {
  client: Client;
  /** Ends the lease; calling it again has no effect. */
  release(): void;
}

/** Runtime processes keyed by the verified principal; the hub never selects one from client input. */
export interface RuntimePool {
  lease(principal: string, id: ServiceId): Promise<Lease>;
  stopPrincipal(principal: string): Promise<void>;
}
