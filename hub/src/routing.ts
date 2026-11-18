import type { ServiceId } from './manifest.js';

/** The OAuth resource of a service: one hostname per service under the deployment base domain. */
export const resourceUrl = (id: ServiceId, base: string): string => `https://${id}.${base}/mcp`;

/**
 * Selects the enabled service named by a Host header: exactly the host of `resourceUrl(id, base)`,
 * compared byte for byte like the adapter's Host check (so no case folding, and a port only where
 * the resource URL has one). Anything else selects nothing.
 */
export function routeHost(host: string | undefined, base: string, ids: ReadonlySet<ServiceId>): ServiceId | undefined {
  if (!host) return undefined;
  const suffix = `.${base}`;
  if (!host.endsWith(suffix)) return undefined;
  const id = host.slice(0, -suffix.length);
  if (!ids.has(id)) return undefined;
  let expected: string;
  try {
    expected = new URL(resourceUrl(id, base)).host;
  } catch {
    return undefined;
  }
  return expected === host ? id : undefined;
}
