// update --to VERSION --record PATH --record-sha256 HEX: accepts only a release record whose bytes
// hash to the value pinned in the catalog, shows its note and the image change, snapshots the
// volumes, switches the image variables in .env atomically, starts the stack and runs doctor. If
// the start or doctor fails, the previous .env is restored and the stack started again.
// rollback: the same switch back to the images saved in .env.previous by the last update.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  Failure, PROJECT, UsageError, VOLUMES, compose, deployment, options, paths, printable, readEnvFile, readRecord, requireImage,
  setEnvVars, stamp, verifyAttestations, writePrivateFile,
} from '../lib.mjs';
import { runDoctor } from './doctor.mjs';

const IMAGE_VARS = { auth: 'LAWOSS_AUTH_IMAGE', hub: 'LAWOSS_HUB_IMAGE', proxy: 'LAWOSS_PROXY_IMAGE' };

/** Archives every volume read-only into <root>/snapshots/<time>/ with one-off containers. */
async function snapshotVolumes(ctx, image) {
  const p = paths(ctx.root);
  mkdirSync(p.snapshots, { recursive: true, mode: 0o700 });
  chmodSync(p.snapshots, 0o700);
  const dir = join(p.snapshots, stamp(ctx.now()));
  mkdirSync(dir, { mode: 0o700 });
  ctx.chown(dir, 0, 0);
  for (const volume of VOLUMES) {
    const result = await ctx.run(['docker', 'run', '-v', `${PROJECT}_${volume}:/source/${volume}:ro`, '-v', `${dir}:/snapshot`,
      '--rm', '--read-only', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
      '--security-opt', 'no-new-privileges:true', '--entrypoint', 'tar', image, '-cf', `/snapshot/${volume}.tar`, '-C', '/source', volume]);
    if (result.code !== 0) throw new Failure(`snapshot of ${volume} failed (exit ${result.code}); nothing was switched`);
    // The archives hold the auth database and certificate keys: root-only like everything else here.
    const archive = join(dir, `${volume}.tar`);
    if (!existsSync(archive)) throw new Failure(`snapshot of ${volume} wrote no archive; nothing was switched`);
    ctx.chown(archive, 0, 0);
    chmodSync(archive, 0o600);
  }
  return dir;
}

/** Bounded, so that a start that hangs still reaches the rollback branch. */
const WAIT_SECONDS = '300';
const up = ctx => ctx.run([...compose(ctx.root), 'up', '-d', '--wait', '--wait-timeout', WAIT_SECONDS]);

/** True when the stack started and doctor passed; any error counts as a failed check. */
async function startAndCheck(ctx) {
  try {
    if ((await up(ctx)).code !== 0) return 'start';
    return (await runDoctor(ctx)) ? undefined : 'doctor';
  } catch {
    return 'doctor';
  }
}

/** Switches .env to `target` (release and images), starts and checks; restores everything on failure. */
async function switchRelease(ctx, target) {
  const p = paths(ctx.root);
  const current = deployment(ctx.root);
  const snapshot = await snapshotVolumes(ctx, requireImage(current.images.auth, 'current auth'));
  ctx.out(snapshot);

  const before = readFileSync(p.env);
  const previousBefore = existsSync(p.envPrevious) ? readFileSync(p.envPrevious) : undefined;
  writePrivateFile(ctx, p.envPrevious, before);
  writePrivateFile(ctx, p.env, setEnvVars(before.toString('utf8'), {
    LAWOSS_RELEASE: target.version,
    ...Object.fromEntries(Object.entries(IMAGE_VARS).map(([name, key]) => [key, target.images[name]])),
  }));

  const failed = await startAndCheck(ctx);
  if (failed === undefined) {
    ctx.out(`switched to ${target.version}`);
    return 0;
  }
  writePrivateFile(ctx, p.env, before);
  if (previousBefore === undefined) rmSync(p.envPrevious, { force: true });
  else writePrivateFile(ctx, p.envPrevious, previousBefore);
  const restarted = await up(ctx).then(result => result.code === 0, () => false);
  ctx.err(`lawoss-selfhost: ${failed} failed after the switch; rolled back to ${current.release}` +
    (restarted ? '' : ', but the stack did not start again; run docker compose up -d and doctor'));
  return 1;
}

export async function update(args, ctx) {
  const { values } = options(args, { to: { type: 'string' }, record: { type: 'string' }, 'record-sha256': { type: 'string' } });
  if (!values.to || !values.record || !values['record-sha256']) throw new UsageError('--to, --record and --record-sha256 are required');
  const record = readRecord(values.record, values['record-sha256'], values.to);
  const current = deployment(ctx.root);
  await verifyAttestations(ctx, record.images);
  ctx.out(`release ${current.release} -> ${record.version}`);
  for (const name of Object.keys(IMAGE_VARS)) ctx.out(`${name} ${current.images[name] ?? '(none)'} -> ${record.images[name]}`);
  for (const line of printable(record.note).split('\n')) ctx.out(`note: ${line}`);
  return switchRelease(ctx, { version: record.version, images: record.images });
}

export async function rollback(args, ctx) {
  options(args, {});
  const p = paths(ctx.root);
  deployment(ctx.root);
  if (!existsSync(p.envPrevious)) throw new Failure('no previous release to roll back to');
  const previous = readEnvFile(p.envPrevious);
  const images = Object.fromEntries(Object.entries(IMAGE_VARS).map(([name, key]) => [name, requireImage(previous[key], `previous ${name}`)]));
  const version = previous.LAWOSS_RELEASE;
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version)) throw new Failure('.env.previous has no valid LAWOSS_RELEASE');
  return switchRelease(ctx, { version, images });
}
