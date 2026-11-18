// Host state shared by update, rollback, restore-snapshot and restore: the host files each accepted
// release keeps in <root>/releases/<version>/, snapshots (.env, the rendered Caddyfile, the outgoing
// release's host files and a tar of every volume, taken with auth stopped), and the one-off
// containers that stop the stack and write archives back into the volumes. Every message names a
// path, a release or a volume; values from .env and container output are never printed.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Failure, PROJECT, VOLUMES, compose, hostFileDifferences, installedHostFiles, keepRecord, keptRecord, paths, randomKey, stamp,
  writePrivateFile,
} from './lib.mjs';
import { runDoctor } from './commands/doctor.mjs';

export const SNAPSHOT_FORMAT = 'lawoss-selfhost-snapshot-v1';

/** The wrapper is executable; every other host file is plain data or a module. */
const modeOf = path => path === 'bin/lawoss-selfhost' ? 0o755 : 0o644;

/** Writes one root-owned file atomically (a temporary file next to it, then a rename). */
export function installFile(ctx, path, bytes, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temp = join(dirname(path), `.${randomKey(9)}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    chmodSync(temp, mode);
    ctx.chown(temp, 0, 0);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Copies a record's host files from `from` to `to`, after checking `from` against the record, and
 * removes every file of `to`/bin that the record does not list; `to` then matches the record.
 */
export function copyHostFiles(ctx, from, to, record, what) {
  const wrong = hostFileDifferences(from, record);
  if (wrong.length) throw new Failure(`${what} do not match the record of release ${record.version}: ${wrong.join(', ')}`);
  for (const path of Object.keys(record.files)) installFile(ctx, join(to, path), readFileSync(join(from, path)), modeOf(path));
  for (const path of installedHostFiles(to)) if (!Object.hasOwn(record.files, path)) rmSync(join(to, path));
  const left = hostFileDifferences(to, record);
  if (left.length) throw new Failure(`host files under ${to} still differ from release ${record.version}: ${left.join(', ')}`);
}

const releaseDir = (root, version) => join(root, 'releases', version);

/**
 * Keeps an accepted release: its record as releases/<version>.json and a copy of its host files,
 * taken from <root> (where they were just verified), as releases/<version>/.
 */
export function keepRelease(ctx, record) {
  keepRecord(ctx, record);
  const target = releaseDir(ctx.root, record.version);
  const staging = join(ctx.root, 'releases', `.${record.version}.${randomKey(9)}.tmp`);
  const old = join(ctx.root, 'releases', `.${record.version}.${randomKey(9)}.old`);
  try {
    copyHostFiles(ctx, ctx.root, staging, record, `host files under ${ctx.root}`);
    chmodSync(staging, 0o755);
    if (existsSync(target)) renameSync(target, old);
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

/** The record of a kept release whose host-file copy is complete; checked before anything changes. */
export function keptRelease(root, version) {
  const record = keptRecord(root, version);
  const dir = releaseDir(root, version);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Failure(`the host files of release ${version} are not kept in ${dir}`);
  const wrong = hostFileDifferences(dir, record);
  if (wrong.length) throw new Failure(`the kept host files of release ${version} in ${dir} differ from its record: ${wrong.join(', ')}`);
  return record;
}

/** Installs a kept release's host files into <root>. */
export function installRelease(ctx, version) {
  const record = keptRelease(ctx.root, version);
  copyHostFiles(ctx, releaseDir(ctx.root, version), ctx.root, record, `the kept host files of release ${version}`);
  return record;
}

/** Ids of the project's running containers (optionally one service), by Compose label; no compose file needed. */
export async function runningContainers(ctx, service) {
  const result = await ctx.run(['docker', 'ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`,
    ...(service ? ['--filter', `label=com.docker.compose.service=${service}`] : [])]);
  if (result.code !== 0) throw new Failure(`docker ps failed (exit ${result.code})`);
  return result.stdout.split('\n').map(line => line.trim()).filter(line => /^[0-9a-f]{6,64}$/.test(line));
}

/** Starts containers stopped earlier (for example auth, stopped for a snapshot) exactly as they were. */
export const startContainers = (ctx, ids) => docker(ctx, 'start', ids);

async function docker(ctx, verb, ids) {
  if (!ids.length) return;
  const result = await ctx.run(['docker', verb, ...ids]);
  if (result.code !== 0) throw new Failure(`docker ${verb} failed (exit ${result.code})`);
}

/** Stops every running container of the stack (the label works whatever compose.yaml is installed). */
export async function stopStack(ctx) {
  await docker(ctx, 'stop', await runningContainers(ctx));
}

/** One-off containers: no network, read-only root, root with only the rights each one needs. */
const ONE_OFF = ['--rm', '--read-only', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL'];
const NO_NEW_PRIVILEGES = ['--security-opt', 'no-new-privileges:true'];
/** Writing into a volume owned by the container user, keeping owners and modes from the archive. */
export const WRITER = [...ONE_OFF, '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', ...NO_NEW_PRIVILEGES];
const READER = [...ONE_OFF, '--cap-add', 'DAC_READ_SEARCH', ...NO_NEW_PRIVILEGES];

/** The named volume, created with Compose's labels when it does not exist yet (a fresh server). */
export async function ensureVolume(ctx, volume) {
  const name = `${PROJECT}_${volume}`;
  if ((await ctx.run(['docker', 'volume', 'inspect', name])).code === 0) return name;
  const result = await ctx.run(['docker', 'volume', 'create', '--label', `com.docker.compose.project=${PROJECT}`,
    '--label', `com.docker.compose.volume=${volume}`, name]);
  if (result.code !== 0) throw new Failure(`volume ${name} could not be created (exit ${result.code})`);
  return name;
}

/** Replaces a volume's content with a tar made by snapshotVolumes or backup (entries under `<volume>/`). */
export async function extractVolume(ctx, image, volume, archive) {
  const name = await ensureVolume(ctx, volume);
  const result = await ctx.run(['docker', 'run', ...WRITER, '-v', `${name}:/target/${volume}`, '-v', `${archive}:/archive/${volume}.tar:ro`,
    '--entrypoint', 'sh', image, '-c', `find /target/${volume} -mindepth 1 -delete && tar -xpf /archive/${volume}.tar -C /target`]);
  if (result.code !== 0) throw new Failure(`restoring ${volume} failed (exit ${result.code}); the stack is stopped`);
}

/**
 * A snapshot in <root>/snapshots/<time>/ (0700): host/ holds .env, the rendered Caddyfile and the
 * host files of `release` (from its kept copy); <volume>.tar the volumes, archived with auth
 * stopped so that its database is consistent. If the archives fail, auth is started again.
 * Returns the directory and the ids of the auth containers it stopped.
 */
export async function takeSnapshot(ctx, { release, image }) {
  const p = paths(ctx.root);
  const record = keptRelease(ctx.root, release);
  mkdirSync(p.snapshots, { recursive: true, mode: 0o700 });
  chmodSync(p.snapshots, 0o700);
  const dir = join(p.snapshots, stamp(ctx.now()));
  mkdirSync(dir, { mode: 0o700 });
  ctx.chown(dir, 0, 0);
  const host = join(dir, 'host');
  mkdirSync(host, { mode: 0o700 });
  ctx.chown(host, 0, 0);
  writePrivateFile(ctx, join(host, '.env'), readFileSync(p.env), { exclusive: true });
  if (existsSync(p.caddyfile)) installFile(ctx, join(host, 'Caddyfile'), readFileSync(p.caddyfile));
  copyHostFiles(ctx, releaseDir(ctx.root, release), host, record, `the kept host files of release ${release}`);
  installFile(ctx, join(dir, 'snapshot.json'), `${JSON.stringify({
    format: SNAPSHOT_FORMAT, release, createdAt: ctx.now().toISOString(), volumes: VOLUMES,
  }, null, 2)}\n`, 0o600);

  const auth = await runningContainers(ctx, 'auth');
  await docker(ctx, 'stop', auth);
  try {
    for (const volume of VOLUMES) {
      const result = await ctx.run(['docker', 'run', ...READER, '-v', `${PROJECT}_${volume}:/source/${volume}:ro`, '-v', `${dir}:/snapshot`,
        '--entrypoint', 'tar', image, '-cf', `/snapshot/${volume}.tar`, '-C', '/source', volume]);
      if (result.code !== 0) throw new Failure(`snapshot of ${volume} failed (exit ${result.code}); nothing was switched`);
      // The archives hold the auth database and certificate keys: root-only like everything else here.
      const archive = join(dir, `${volume}.tar`);
      if (!existsSync(archive)) throw new Failure(`snapshot of ${volume} wrote no archive; nothing was switched`);
      ctx.chown(archive, 0, 0);
      chmodSync(archive, 0o600);
    }
  } catch (error) {
    await docker(ctx, 'start', auth).catch(() => ctx.err('lawoss-selfhost: auth did not start again; run docker compose up -d'));
    throw error;
  }
  return { dir, stopped: auth };
}

/** Bounded, so that a start that hangs still reaches the rollback branch. */
const WAIT_SECONDS = '300';

/**
 * Starts the stack, recreating every container so that the proxy reads a re-rendered Caddyfile (a
 * single-file bind mount keeps the old file otherwise), then runs doctor. Returns undefined when
 * both pass, else 'start' or 'doctor'; any error counts as a failed check.
 */
export async function startAndCheck(ctx) {
  try {
    if ((await startStack(ctx)).code !== 0) return 'start';
    return (await runDoctor(ctx)) ? undefined : 'doctor';
  } catch {
    return 'doctor';
  }
}

export const startStack = ctx => ctx.run([...compose(ctx.root), 'up', '-d', '--wait', '--wait-timeout', WAIT_SECONDS, '--force-recreate']);
