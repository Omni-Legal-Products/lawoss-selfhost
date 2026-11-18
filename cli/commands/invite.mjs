// invite USER SERVICES: creates the account with a one-time activation link for the first service
// and grants the others; the tenant is the account name. The auth container (user `node`) writes the
// link into a staging directory bind-mounted only for this command; the host then moves it to
// <root>/handoff/<USER>.link as root:root 0600 and prints only that path.
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_UID, Failure, deployment, options, parseServiceList, paths, randomKey, resourceUrl } from '../lib.mjs';
import { account, runAdmin } from './admin.mjs';

/** The 0700 root-owned handoff directory. */
function handoffDir(ctx) {
  const dir = paths(ctx.root).handoff;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Failure(`${dir} is not a directory`);
  chmodSync(dir, 0o700);
  ctx.chown(dir, 0, 0);
  return dir;
}

export async function invite(args, ctx) {
  const { positionals } = options(args, {}, { positionals: 2 });
  const user = account(positionals[0]);
  const { base, services } = deployment(ctx.root);
  const [first, ...rest] = parseServiceList(positionals[1], services);

  const dir = handoffDir(ctx);
  const file = join(dir, `${user}.link`);
  if (existsSync(file)) throw new Failure(`${file} is still pending; the person must use or the operator must delete it first`);

  // Writable for the container's user only for the duration of this command.
  const staging = join(dir, `.staging-${user}-${randomKey(9)}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    ctx.chown(staging, CONTAINER_UID, CONTAINER_UID);
    await runAdmin(ctx, ['invite', user, resourceUrl(first, base), user, '/handoff/link'], [`${staging}:/handoff`], `invite ${first}`);
    const written = join(staging, 'link');
    const info = lstatSync(written, { throwIfNoEntry: false });
    if (!info?.isFile()) throw new Failure('the auth container wrote no activation file');
    // Inside the root-only handoff directory; the file is the container user's until chowned here.
    renameSync(written, file);
    ctx.chown(file, 0, 0);
    chmodSync(file, 0o600);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  for (const id of rest) {
    try {
      await runAdmin(ctx, ['grant-resource', user, resourceUrl(id, base), user], [], `grant ${id}`);
    } catch (error) {
      if (error instanceof Failure) throw new Failure(`${error.message}; the account and ${file} exist, retry with grant`);
      throw error;
    }
  }
  ctx.out(file);
  return 0;
}
