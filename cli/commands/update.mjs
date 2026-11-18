// update --to VERSION --record PATH --record-sha256 HEX: accepts only a release record whose bytes
// hash to the value pinned in the catalog and whose host files (compose.yaml, services.json,
// Caddyfile.template, the CLI in bin/) are installed under <root> already, verifies the images'
// build attestations, shows its note and the image change, and takes a snapshot: .env, the
// Caddyfile and the outgoing release's host files (from its kept copy in releases/<version>/), and
// every volume with auth stopped. It then switches the image variables in .env atomically, renders
// the Caddyfile from the new template, starts the stack and runs doctor. If the start or doctor
// fails, .env, the Caddyfile and the outgoing release's host files are restored together and the
// stack is started again; the volumes stay as they are, and restore-snapshot DIR puts them back too.
// A release refused before the switch also puts the outgoing release's host files back in place.
// rollback: the same switch to the release saved in .env.previous by the last update: its kept host
// files are installed again and only the image variables of .env change (secrets rotated since stay);
// a failed check is reported, not reverted.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  Failure, UsageError, VERSION, deployment, options, paths, printable, readEnvFile, readRecord, requireImage, setEnvVars,
  verifyAttestations, verifyHostFiles, writeCaddyfile, writePrivateFile,
} from '../lib.mjs';
import { copyHostFiles, installFile, installRelease, keepRelease, keptRelease, startAndCheck, startStack, takeSnapshot } from '../host.mjs';

const IMAGE_VARS = { auth: 'LAWOSS_AUTH_IMAGE', hub: 'LAWOSS_HUB_IMAGE', proxy: 'LAWOSS_PROXY_IMAGE' };

/** Puts the outgoing release's kept host files back after a refusal; never hides the refusal itself. */
function putBack(ctx, version) {
  try {
    installRelease(ctx, version);
    ctx.err(`lawoss-selfhost: the host files of ${version} are back in place`);
  } catch (error) {
    ctx.err(`lawoss-selfhost: the host files of ${version} could not be put back${error instanceof Failure ? `: ${error.message}` : ''}`);
  }
}

/**
 * Snapshots, switches .env to `target` (release and images), renders the Caddyfile, starts and
 * checks. `install` first installs the target's kept host files (rollback). With `revert`, a
 * failure restores .env, the Caddyfile and the outgoing host files (update); without it, the failure
 * is reported and the operator decides (rollback, which is itself the way back).
 */
async function switchRelease(ctx, target, { revert, install }) {
  const p = paths(ctx.root);
  const current = deployment(ctx.root);
  const outgoing = keptRelease(ctx.root, current.release);
  let snapshot;
  try {
    snapshot = await takeSnapshot(ctx, { release: current.release, image: requireImage(current.images.auth, 'current auth') });
  } catch (error) {
    if (revert) putBack(ctx, current.release);
    throw error;
  }
  ctx.out(snapshot);

  const before = readFileSync(p.env);
  const previousBefore = existsSync(p.envPrevious) ? readFileSync(p.envPrevious) : undefined;
  if (install) installRelease(ctx, target.version);
  writePrivateFile(ctx, p.envPrevious, before);
  writePrivateFile(ctx, p.env, setEnvVars(before.toString('utf8'), {
    LAWOSS_RELEASE: target.version,
    ...Object.fromEntries(Object.entries(IMAGE_VARS).map(([name, key]) => [key, target.images[name]])),
  }));
  let failed;
  try {
    writeCaddyfile(ctx, deployment(ctx.root));
    failed = await startAndCheck(ctx);
  } catch {
    failed = 'render';
  }
  if (failed === undefined) {
    ctx.out(`switched to ${target.version}`);
    return 0;
  }
  if (!revert) {
    ctx.out(`FAIL rollback ${target.version}`);
    ctx.err(`lawoss-selfhost: ${failed} failed after rolling back; .env names ${target.version}; fix the cause and run doctor, ` +
      `or return to the state before with restore-snapshot ${snapshot}`);
    return 1;
  }
  const host = join(snapshot, 'host');
  writePrivateFile(ctx, p.env, before);
  if (previousBefore === undefined) rmSync(p.envPrevious, { force: true });
  else writePrivateFile(ctx, p.envPrevious, previousBefore);
  copyHostFiles(ctx, host, ctx.root, outgoing, `the snapshot's host files of ${current.release}`);
  if (existsSync(join(host, 'Caddyfile'))) installFile(ctx, p.caddyfile, readFileSync(join(host, 'Caddyfile')));
  const restarted = await startStack(ctx).then(result => result.code === 0, () => false);
  ctx.err(`lawoss-selfhost: ${failed} failed after the switch; rolled back to ${current.release}` +
    (restarted ? '' : ', but the stack did not start again; run docker compose up -d and doctor') +
    `; if ${current.release} does not work on the data the new release left, run restore-snapshot ${snapshot}`);
  return 1;
}

export async function update(args, ctx) {
  const { values } = options(args, { to: { type: 'string' }, record: { type: 'string' }, 'record-sha256': { type: 'string' } });
  if (!values.to || !values.record || !values['record-sha256']) throw new UsageError('--to, --record and --record-sha256 are required');
  const record = readRecord(values.record, values['record-sha256'], values.to);
  const current = deployment(ctx.root);
  // The way back must exist before anything changes.
  keptRelease(ctx.root, current.release);
  try {
    verifyHostFiles(ctx.root, record);
    await verifyAttestations(ctx, record.images);
  } catch (error) {
    putBack(ctx, current.release);
    throw error;
  }
  ctx.out(`release ${current.release} -> ${record.version}`);
  for (const name of Object.keys(IMAGE_VARS)) ctx.out(`${name} ${current.images[name] ?? '(none)'} -> ${record.images[name]}`);
  for (const line of printable(record.note).split('\n')) ctx.out(`note: ${line}`);
  const code = await switchRelease(ctx, { version: record.version, images: record.images }, { revert: true, install: false });
  if (code === 0) keepRelease(ctx, record);
  return code;
}

export async function rollback(args, ctx) {
  options(args, {});
  const p = paths(ctx.root);
  deployment(ctx.root);
  if (!existsSync(p.envPrevious)) throw new Failure('no previous release to roll back to');
  const previous = readEnvFile(p.envPrevious);
  const images = Object.fromEntries(Object.entries(IMAGE_VARS).map(([name, key]) => [name, requireImage(previous[key], `previous ${name}`)]));
  const version = previous.LAWOSS_RELEASE;
  if (!version || !VERSION.test(version)) throw new Failure('.env.previous has no valid LAWOSS_RELEASE');
  // The previous release's record and host files must be kept; nothing changes otherwise.
  keptRelease(ctx.root, version);
  return switchRelease(ctx, { version, images }, { revert: false, install: true });
}
