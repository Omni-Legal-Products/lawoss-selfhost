// rotate introspection|cookies|signing: replaces secrets in .env (through the atomic writer) when one
// may have been exposed, then recreates the containers that read them. Nothing is printed but the
// kind rotated.
//   introspection: a new secret per enabled service, in the hub's config and its SHA-256 in auth's,
//                  together; auth and hub are recreated.
//   cookies:       a new cookie key first; only the previous one is kept, so running it twice drops
//                  every older key (and signs everyone out). auth is recreated.
//   signing:       a new signing key first; only the previous one is kept, second, so tokens it signed
//                  stay valid until they expire (60 minutes); run it again after that to drop it.
import { readFileSync } from 'node:fs';
import {
  Failure, UsageError, compose, deployment, options, paths, randomKey, readConfigs, resourceUrl, sha256, withConfigs, writePrivateFile,
} from '../lib.mjs';
import { signingKey } from './init.mjs';

const KINDS = {
  introspection(auth, hub, base) {
    for (const id of hub.services) {
      const secret = randomKey(32);
      hub.secrets[id] = secret;
      const resource = auth.resources?.[resourceUrl(id, base)];
      if (!resource) throw new Failure(`AUTH_CONFIG_JSON has no resource for ${id}; nothing changed`);
      resource.secretHash = sha256(secret);
    }
    return ['auth', 'hub'];
  },
  cookies(auth) {
    auth.cookieKeys = [randomKey(32), ...(Array.isArray(auth.cookieKeys) ? auth.cookieKeys.slice(0, 1) : [])];
    return ['auth'];
  },
  signing(auth, _hub, _base, ctx) {
    const keys = Array.isArray(auth.jwks?.keys) ? auth.jwks.keys : [];
    auth.jwks = { ...auth.jwks, keys: [signingKey(), ...keys.slice(0, 1)] };
    ctx.err('The previous signing key stays second so that tokens it signed keep working; run rotate signing again after 60 minutes to drop it.');
    return ['auth'];
  },
};

/** Recreates `services` so they read the new .env; the same bounded wait as update. */
export async function recreate(ctx, services) {
  const result = await ctx.run([...compose(ctx.root), 'up', '-d', '--wait', '--wait-timeout', '300', '--force-recreate', ...services]);
  if (result.code !== 0) throw new Failure(`${services.join(' and ') || 'the stack'} did not restart (exit ${result.code}); .env already holds the change; run doctor`);
}

export async function rotate(args, ctx) {
  const { positionals } = options(args, {}, { positionals: 1 });
  const [kind] = positionals;
  if (!Object.hasOwn(KINDS, kind)) throw new UsageError('rotate takes introspection, cookies or signing');
  const { base } = deployment(ctx.root);
  const env = paths(ctx.root).env;
  const text = readFileSync(env, 'utf8');
  const configs = readConfigs(text);
  const services = KINDS[kind](configs.auth, configs.hub, base, ctx);
  writePrivateFile(ctx, env, withConfigs(text, configs));
  await recreate(ctx, services);
  ctx.out(`rotated ${kind}`);
  return 0;
}
