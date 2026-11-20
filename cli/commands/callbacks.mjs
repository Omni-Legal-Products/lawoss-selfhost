// callbacks [list] | callbacks add URL|claude | callbacks remove URL: the web callbacks auth's
// dynamic client registration accepts besides loopback ones (AUTH_CONFIG_JSON redirectUris).
// Each entry is one exact https URL, matched byte for byte; there are no wildcards, at most
// CALLBACK_LIMITS.count entries of CALLBACK_LIMITS.length characters. `claude` names the callback of
// Claude's hosted apps, which init allows. A change recreates auth only. auth checks the list at
// every authorization, so a removed callback also stops clients registered with it before: their
// next sign-in fails until it is added again.
import { readFileSync } from 'node:fs';
import {
  CALLBACK_LIMITS, CLAUDE_CALLBACKS, Failure, UsageError, callbackProblem, options, paths, readConfigs, withConfigs, writePrivateFile,
} from '../lib.mjs';
import { recreate } from './rotate.mjs';

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
  if (action !== 'add' && action !== 'remove') throw new UsageError('callbacks takes list, add URL|claude or remove URL');
  if (target === undefined) throw new UsageError(`callbacks ${action} needs a callback URL${action === 'add' ? ' or claude' : ''}`);
  const uris = action === 'add' && target === 'claude' ? [...CLAUDE_CALLBACKS] : [target];
  const problem = callbackProblem(uris[0]);
  if (problem) throw new UsageError(problem);

  let next;
  let lines;
  if (action === 'add') {
    const missing = uris.filter(uri => !current.includes(uri));
    if (!missing.length) {
      for (const uri of uris) ctx.out(`already allowed ${uri}`);
      return 0;
    }
    next = [...current, ...missing];
    if (next.length > CALLBACK_LIMITS.count)
      throw new Failure(`auth allows at most ${CALLBACK_LIMITS.count} web callbacks; remove one first; nothing changed`);
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
