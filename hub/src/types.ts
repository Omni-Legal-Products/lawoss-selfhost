import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServiceId } from './manifest.js';

/** Runtime processes keyed by the verified principal; the hub never selects one from client input. */
export interface RuntimePool {
  client(principal: string, id: ServiceId): Promise<Client>;
  stopPrincipal(principal: string): Promise<void>;
}
