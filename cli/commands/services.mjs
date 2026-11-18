// services add ID / services remove ID: enables or disables one service of the installed manifest in
// both configurations (a new introspection secret in the hub's, its resource with the SHA-256 in
// auth's), LAWOSS_SERVICES and the Caddyfile, then recreates the stack so that the proxy reads the
// new Caddyfile. add prints the host name to create in DNS. Grants of a removed service stay in the
// auth database but name a resource auth no longer serves.
import { readFileSync } from 'node:fs';
import {
  Failure, SERVICE_NAMES, UsageError, deployment, loadManifest, options, paths, randomKey, readConfigs, renderCaddyfile, resourceUrl, sha256, withConfigs, writeCaddyfile, writePrivateFile,
} from '../lib.mjs';
import { recreate } from './rotate.mjs';

export async function services(args, ctx) {
  const { positionals } = options(args, {}, { positionals: 2 });
  const [action, id] = positionals;
  if (!['add', 'remove'].includes(action)) throw new UsageError('services takes add ID or remove ID');
  const current = deployment(ctx.root);
  const manifest = loadManifest(ctx.root);
  if (!Object.hasOwn(manifest.services ?? {}, id)) throw new UsageError('ID must be a service of services.json');
  const enabled = current.services.includes(id);
  if (action === 'add' && enabled) throw new UsageError(`${id} is already enabled`);
  if (action === 'remove' && !enabled) throw new UsageError(`${id} is not enabled`);
  if (action === 'remove' && current.services.length === 1) throw new Failure(`${id} is the last enabled service; a deployment keeps at least one`);

  const env = paths(ctx.root).env;
  const text = readFileSync(env, 'utf8');
  const { auth, hub } = readConfigs(text);
  const url = resourceUrl(id, current.base);
  const list = action === 'add' ? [...current.services, id] : current.services.filter(name => name !== id);
  if (action === 'add') {
    const secret = randomKey(32);
    hub.secrets = { ...hub.secrets, [id]: secret };
    auth.resources = { ...auth.resources, [url]: { name: SERVICE_NAMES[id] ?? id, scope: 'mcp:tools', secretHash: sha256(secret) } };
  } else {
    delete hub.secrets?.[id];
    delete auth.resources?.[url];
  }
  hub.services = list;
  const settings = { ...current, services: list };
  // Rendered before the first write, so that a template problem changes nothing.
  renderCaddyfile(readFileSync(paths(ctx.root).template, 'utf8'), settings);
  writePrivateFile(ctx, env, withConfigs(text, { auth, hub }, { LAWOSS_SERVICES: list.join(',') }));
  writeCaddyfile(ctx, settings);
  await recreate(ctx, []);
  ctx.out(action === 'add' ? `${id}.${current.base}` : `removed ${id}`);
  if (action === 'remove') ctx.err(`The DNS record of ${id}.${current.base} is no longer needed.`);
  return 0;
}
