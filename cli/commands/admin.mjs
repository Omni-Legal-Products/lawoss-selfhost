// Account administration: each step is a one-off `docker compose run --rm --no-deps auth node
// dist/admin.js ...` container. The auth service mounts only auth-data, and --no-deps starts nothing
// else. The container's own output is never passed on: it is replaced by fixed messages.
import { ACCOUNT, Failure, UsageError, compose, deployment, options, parseServiceList, resourceUrl } from '../lib.mjs';

/** The argument vector of one admin.js call, with optional extra `-v` mounts before the service. */
export const adminArgv = (root, args, mounts = []) =>
  [...compose(root), 'run', '--rm', '--no-deps', ...mounts.flatMap(mount => ['-v', mount]), 'auth', 'node', 'dist/admin.js', ...args];

export function account(name) {
  if (!ACCOUNT.test(name ?? '')) throw new UsageError('USER must be 3 to 64 lowercase letters, digits, - or _ (it is also the tenant)');
  return name;
}

export async function runAdmin(ctx, args, mounts, what) {
  const result = await ctx.run(adminArgv(ctx.root, args, mounts));
  if (result.code !== 0) throw new Failure(`${what} failed in the auth container (exit ${result.code})`);
  return result;
}

async function forEachService(args, ctx, command) {
  const { positionals } = options(args, {}, { positionals: 2 });
  const user = account(positionals[0]);
  const { base, services } = deployment(ctx.root);
  const ids = parseServiceList(positionals[1], services);
  for (const id of ids) await command(user, id, resourceUrl(id, base));
  return 0;
}

export const grant = (args, ctx) => forEachService(args, ctx, async (user, id, url) => {
  await runAdmin(ctx, ['grant-resource', user, url, user], [], `grant ${id}`);
  ctx.out(`granted ${user} ${id}`);
});

export const revoke = (args, ctx) => forEachService(args, ctx, async (user, id, url) => {
  await runAdmin(ctx, ['revoke-resource', user, url], [], `revoke ${id}`);
  ctx.out(`revoked ${user} ${id}`);
});

export async function disable(args, ctx) {
  const { positionals } = options(args, {}, { positionals: 1 });
  const user = account(positionals[0]);
  deployment(ctx.root);
  await runAdmin(ctx, ['disable', user], [], 'disable');
  ctx.out(`disabled ${user}`);
  return 0;
}

/** Prints one line per account: name, status and the enabled services it is granted. */
export async function list(args, ctx) {
  options(args, {});
  const { base, services } = deployment(ctx.root);
  const result = await runAdmin(ctx, ['list'], [], 'list');
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { throw new Failure('list returned unreadable output'); }
  if (!Array.isArray(rows)) throw new Failure('list returned unreadable output');
  const byUrl = new Map(services.map(id => [resourceUrl(id, base), id]));
  for (const row of rows) {
    const name = typeof row?.username === 'string' ? row.username : '';
    const status = typeof row?.status === 'string' ? row.status : '';
    if (!/^[^\s]{1,254}$/.test(name) || !/^[a-z]{1,16}$/.test(status)) throw new Failure('list returned an unexpected row');
    const granted = Object.keys(row.resources ?? {}).map(url => byUrl.get(url)).filter(Boolean).sort();
    ctx.out(`${name} ${status} ${granted.join(',') || '-'}`);
  }
  return 0;
}
