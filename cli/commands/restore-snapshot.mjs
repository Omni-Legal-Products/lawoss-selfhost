// restore-snapshot DIR: puts a snapshot taken by update or rollback back in place: stops the stack,
// writes every volume archive back with one-off containers (the snapshot's own auth image), installs
// the snapshot's host files, .env and Caddyfile, starts the stack and runs doctor. The snapshot's host
// files must match the kept record of its release; nothing changes before every check has passed.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  Failure, UsageError, VERSION, VOLUMES, hostFileDifferences, keptRecord, options, parseEnv, paths, requireImage, writePrivateFile,
} from '../lib.mjs';
import { SNAPSHOT_FORMAT, copyHostFiles, extractVolume, installFile, startAndCheck, stopStack } from '../host.mjs';

/** Everything restore-snapshot needs from DIR, checked before the first change. */
function readSnapshot(root, dir) {
  let meta;
  try { meta = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')); } catch { throw new Failure(`${dir} holds no readable snapshot.json`); }
  if (meta?.format !== SNAPSHOT_FORMAT || typeof meta.release !== 'string' || !VERSION.test(meta.release))
    throw new Failure(`${dir} is not a lawoss-selfhost snapshot`);
  const record = keptRecord(root, meta.release);
  const host = join(dir, 'host');
  const wrong = hostFileDifferences(host, record);
  if (wrong.length) throw new Failure(`the snapshot's host files differ from the record of release ${meta.release}: ${wrong.join(', ')}`);
  let env;
  try { env = readFileSync(join(host, '.env')); } catch { throw new Failure(`${join(host, '.env')} is missing`); }
  const vars = parseEnv(env.toString('utf8'));
  if (vars.LAWOSS_RELEASE !== meta.release) throw new Failure('the snapshot\'s .env names another release than its snapshot.json');
  const image = requireImage(vars.LAWOSS_AUTH_IMAGE, 'snapshot auth');
  for (const volume of VOLUMES)
    if (!lstatSync(join(dir, `${volume}.tar`), { throwIfNoEntry: false })?.isFile()) throw new Failure(`${join(dir, `${volume}.tar`)} is missing`);
  return { record, host, env, image };
}

export async function restoreSnapshot(args, ctx) {
  const { positionals } = options(args, {}, { positionals: 1 });
  const [dir] = positionals;
  if (!isAbsolute(dir) || resolve(dir) !== dir || /[:,\n]/.test(dir)) throw new UsageError('SNAPSHOT_DIR must be an absolute path');
  const { record, host, env, image } = readSnapshot(ctx.root, dir);
  const p = paths(ctx.root);

  await stopStack(ctx);
  for (const volume of VOLUMES) await extractVolume(ctx, image, volume, join(dir, `${volume}.tar`));
  copyHostFiles(ctx, host, ctx.root, record, 'the snapshot\'s host files');
  writePrivateFile(ctx, p.env, env);
  if (existsSync(join(host, 'Caddyfile'))) installFile(ctx, p.caddyfile, readFileSync(join(host, 'Caddyfile')));
  const failed = await startAndCheck(ctx);
  ctx.out(`${failed ? 'FAIL' : 'PASS'} restore-snapshot ${dir}`);
  if (failed) ctx.err(`lawoss-selfhost: ${failed} failed after restoring the snapshot; the files and volumes are restored`);
  return failed ? 1 : 0;
}
