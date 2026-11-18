import type { ServiceId } from './manifest.js';

/** The OAuth resource of a service: one hostname per service under the deployment base domain. */
export const resourceUrl = (id: ServiceId, base: string): string => `https://${id}.${base}/mcp`;

/**
 * Selects the enabled service named by a Host header: exactly `<id>.<base>`, compared
 * case-insensitively. A port is accepted only where the resource URL itself has one, which is
 * the adapter's Host rule; anything else selects nothing.
 */
export function routeHost(host: string | undefined, base: string, ids: ReadonlySet<ServiceId>): ServiceId | undefined {
  if (!host) return undefined;
  const lower = host.toLowerCase();
  const suffix = `.${base.toLowerCase()}`;
  if (!lower.endsWith(suffix)) return undefined;
  const id = lower.slice(0, -suffix.length);
  if (!ids.has(id)) return undefined;
  let expected: string;
  try {
    expected = new URL(resourceUrl(id, base)).host;
  } catch {
    return undefined;
  }
  return expected === lower ? id : undefined;
}
