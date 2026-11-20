// callbacks [list] | callbacks add URI|claude | callbacks remove URI: the web callbacks auth's
// dynamic client registration accepts besides loopback ones (AUTH_CONFIG_JSON redirectUris).
// Each entry is one exact https URL, matched byte for byte; there are no wildcards. `claude` names
// the callbacks of Claude's hosted apps, which init allows. A change recreates auth only; clients
// registered before keep their callbacks, a removed one just cannot register again.
import { readFileSync } from 'node:fs';
import { CLAUDE_CALLBACKS, Failure, UsageError, options, paths, readConfigs, withConfigs, writePrivateFile } from '../lib.mjs';
import { recreate } from './rotate.mjs';

/** One exact https callback in the form the URL parser gives back, or a usage error. */
function exactCallback(uri) {
  let url;
  try { url = new URL(uri); } catch { throw new UsageError('a callback must be one https URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname.includes('*') || url.href !== uri)
    throw new UsageError('a callback must be one exact https URL in canonical form, without user, query, fragment or wildcard');
  return uri;
}

export async function callbacks(args, ctx) {
  const { positionals } = options(args, {}, { positionals: [0, 2] });
  const [action = 'list', target] = positionals;
  const env = paths(ctx.root).env;
  const text = readFileSync(env, 'utf8');
  const configs = readConfigs(text);
  const current = Array.isArray(configs.auth.redirectUris) ? configs.auth.redirectUris : [];

  if (action === 'list') {
    if (target !== undefined) throw new UsageError('callbacks list takes no argument');
    for (const uri of current) ctx.out(uri);
    return 0;
  }
  if (action !== 'add' && action !== 'remove') throw new UsageError('callbacks takes list, add URI|claude or remove URI');
  if (target === undefined) throw new UsageError(`callbacks ${action} needs a callback URL${action === 'add' ? ' or claude' : ''}`);
  const uris = action === 'add' && target === 'claude' ? [...CLAUDE_CALLBACKS] : [exactCallback(target)];

  let next;
  let lines;
  if (action === 'add') {
    const missing = uris.filter(uri => !current.includes(uri));
    if (!missing.length) {
      for (const uri of uris) ctx.out(`already allowed ${uri}`);
      return 0;
    }
    next = [...current, ...missing];
    lines = missing.map(uri => `allowed ${uri}`);
  } else {
    if (!current.includes(uris[0])) throw new Failure(`${uris[0]} is not an allowed callback; nothing changed`);
    next = current.filter(uri => uri !== uris[0]);
    lines = [`removed ${uris[0]}`];
  }
  configs.auth.redirectUris = next;
  writePrivateFile(ctx, env, withConfigs(text, configs));
  await recreate(ctx, ['auth']);
  for (const line of lines) ctx.out(line);
  return 0;
}
