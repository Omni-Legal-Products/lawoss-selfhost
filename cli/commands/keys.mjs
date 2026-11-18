// set-key NAME / unset-key NAME: provider keys for the hub's runtimes (for example FS_API_KEY).
// NAME must be a variable some manifest entry allowlists; compose.yaml passes exactly those names to
// the hub as ${NAME:-}, and the hub hands each runtime only its own. The value is read from stdin
// (without echo on a terminal), never from argv; it is written with the atomic .env writer and
// never printed. The hub is then recreated so that it sees the change.
import { readFileSync } from 'node:fs';
import {
  Failure, UsageError, compose, deployment, loadManifest, options, paths, providerKeys, setEnvVars, writePrivateFile,
} from '../lib.mjs';

const MAX_VALUE = 4096;

function keyName(args, ctx) {
  const { positionals } = options(args, {}, { positionals: 1 });
  const [name] = positionals;
  if (!providerNames(ctx).includes(name)) throw new UsageError('NAME must be a provider key that a service allowlists in services.json');
  return name;
}

const providerNames = ctx => providerKeys(loadManifest(ctx.root));

async function write(ctx, name, value) {
  const env = paths(ctx.root).env;
  writePrivateFile(ctx, env, setEnvVars(readFileSync(env, 'utf8'), { [name]: value }));
  const result = await ctx.run([...compose(ctx.root), 'up', '-d', 'hub']);
  if (result.code !== 0) throw new Failure(`the hub did not restart (exit ${result.code}); .env already holds the change`);
}

export async function setKey(args, ctx) {
  const name = keyName(args, ctx);
  deployment(ctx.root);
  const value = await ctx.readSecret(`Value for ${name} (input hidden): `);
  if (typeof value !== 'string' || value.length === 0) throw new Failure('no value was given; nothing changed');
  // A backslash may be read as an escape by Compose's dotenv parser, even inside single quotes.
  if (value.length > MAX_VALUE || /[\p{Cc}'\\]/u.test(value))
    throw new Failure('the value must be one line without control characters, single quotes or backslashes; nothing changed');
  await write(ctx, name, value);
  ctx.out(`set ${name}`);
  return 0;
}

export async function unsetKey(args, ctx) {
  const name = keyName(args, ctx);
  deployment(ctx.root);
  await write(ctx, name, '');
  ctx.out(`unset ${name}`);
  return 0;
}
