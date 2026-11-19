// restore --dry-run [--private-key PATH] [DIR]: decrypts and checks a backup (the auth part in a
// throwaway container whose destination is a tmpfs) and writes nothing.
// restore --apply --record-sha256 HEX [--private-key PATH] DIR: puts a backup back, also on a fresh
// server with no .env. A host part can be sealed by anyone holding the public key, so nothing in it
// is trusted for what it installs: its release record must hash to HEX (the value pinned in the
// catalog for that release), its .env must name exactly that record's images, the images' build
// attestations must verify (when gh is installed), and its kept host files must match the record.
// The host part must also decrypt and name only allowlisted paths, and the auth part must pass
// auth's own check in a throwaway container. Only then does it stop the stack, write brand/, the
// pinned release's record and host files, .env and a Caddyfile rendered from the pinned template,
// restore auth's database into auth-data with auth's own restore script and hub-data from its
// archive (one-off containers, the pinned auth image), start the stack and run doctor. caddy-data is
// not in a backup; certificates are issued again.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  DNS_NAME, Failure, UsageError, VERSION, deployment, proxyProblem, options, parseEnv, paths, randomKey, readEnvFile, requireImage, sha256,
  validateRecord, verifyAttestations, writeCaddyfile, writePrivateFile,
} from '../lib.mjs';
import {
  WRITER, ensureVolume, extractVolume, installFile, installRelease, startAndCheck, stopStack,
} from '../host.mjs';
import { BACKUP_NAME, keyPaths, unseal } from './backup.mjs';

/**
 * Runs auth's restore into a tmpfs (it refuses an existing destination and checks the database),
 * then replaces auth.sqlite in the volume as the container user, dropping a stale WAL.
 */
const AUTH_RESTORE = [
  'set -eu',
  'node scripts/backup.mjs restore --input /backup/auth.enc.json --private-key /keys/private.pem --destination /tmp/restore > /dev/null',
  'rm -f /data/auth.sqlite-wal /data/auth.sqlite-shm /data/.auth.sqlite.restore',
  'cp /tmp/restore/auth.sqlite /data/.auth.sqlite.restore',
  'chown 1000:1000 /data/.auth.sqlite.restore',
  'chmod 600 /data/.auth.sqlite.restore',
  'mv /data/.auth.sqlite.restore /data/auth.sqlite',
].join('; ');

function latestBackup(root) {
  const dir = paths(root).backups;
  const names = existsSync(dir) ? readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(name)).sort() : [];
  if (!names.length) throw new Failure(`no backup in ${dir}`);
  return join(dir, names.at(-1));
}

const absolute = path => isAbsolute(path) && resolve(path) === path && !/[:,\n]/.test(path);

export async function restore(args, ctx) {
  const { values, positionals } = options(args, {
    'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, 'private-key': { type: 'string' }, 'record-sha256': { type: 'string' },
  }, { positionals: [0, 1] });
  if (Boolean(values['dry-run']) === Boolean(values.apply)) throw new UsageError('restore takes --dry-run or --apply');
  if (values.apply && !positionals[0]) throw new UsageError('restore --apply needs the backup directory');
  const pin = values['record-sha256'];
  if (values.apply && !/^[0-9a-f]{64}$/.test(pin ?? ''))
    throw new UsageError('restore --apply needs --record-sha256, the catalog\'s SHA-256 of the backup\'s release record');
  if (!values.apply && pin !== undefined) throw new UsageError('--record-sha256 goes with --apply');
  if (positionals[0] && !absolute(positionals[0])) throw new UsageError('BACKUP_DIR must be an absolute path');
  const dir = positionals[0] ?? latestBackup(ctx.root);
  const privateKey = values['private-key'] ?? keyPaths(ctx.root).private;
  if (!absolute(privateKey)) throw new UsageError('--private-key must be an absolute path');
  return values.apply ? apply(ctx, dir, privateKey, pin) : dryRun(ctx, dir, privateKey);
}

/** auth's own restore into a throwaway tmpfs: decrypts and checks the auth part, writes nothing. */
async function checkAuthPart(ctx, dir, privateKey, image) {
  const result = await ctx.run(['docker', 'run', '--rm', '--read-only', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp',
    '-v', `${join(dir, 'auth.enc.json')}:/backup/auth.enc.json:ro`, '-v', `${privateKey}:/keys/private.pem:ro`,
    '--entrypoint', 'node', image, 'scripts/backup.mjs', 'restore',
    '--input', '/backup/auth.enc.json', '--private-key', '/keys/private.pem', '--destination', '/tmp/restore-check']);
  return result.code === 0;
}

async function dryRun(ctx, dir, privateKey) {
  const p = paths(ctx.root);
  const image = requireImage(existsSync(p.env) ? readEnvFile(p.env).LAWOSS_AUTH_IMAGE : undefined, 'auth');
  let ok = false;
  try {
    unseal(JSON.parse(readFileSync(join(dir, 'host.enc.json'), 'utf8')), readFileSync(privateKey));
    ok = await checkAuthPart(ctx, dir, privateKey, image);
  } catch {
    ok = false;
  }
  ctx.out(`${ok ? 'PASS' : 'FAIL'} backup ${dir}`);
  return ok ? 0 : 1;
}

/** Decrypts and checks the host part; returns the files by name. Nothing is written. */
function readBackup(dir, privateKey) {
  let content;
  try {
    content = unseal(JSON.parse(readFileSync(join(dir, 'host.enc.json'), 'utf8')), readFileSync(privateKey));
  } catch (error) {
    throw error instanceof Failure ? error : new Failure(`${join(dir, 'host.enc.json')} cannot be decrypted with ${privateKey}`);
  }
  const names = Object.keys(content.files ?? {});
  const outside = names.filter(name => !BACKUP_NAME.test(name));
  if (outside.length) throw new Failure('the backup names a file outside .env, Caddyfile, hub-data.tar, brand/ and releases/; refusing it');
  for (const name of ['.env', 'Caddyfile', 'hub-data.tar']) if (!names.includes(name)) throw new Failure(`the backup has no ${name}`);
  if (!existsSync(join(dir, 'auth.enc.json'))) throw new Failure(`${join(dir, 'auth.enc.json')} is missing`);
  return new Map(names.map(name => [name, Buffer.from(content.files[name], 'base64')]));
}

const IMAGE_VARS = { auth: 'LAWOSS_AUTH_IMAGE', hub: 'LAWOSS_HUB_IMAGE', proxy: 'LAWOSS_PROXY_IMAGE' };

/**
 * The backup's release, trusted only through the pinned record: the record must hash to `pin`, the
 * .env must name its images, and the kept host files must match it.
 */
function backupRelease(files, pin) {
  const vars = parseEnv(files.get('.env').toString('utf8'));
  if (!DNS_NAME.test(vars.LAWOSS_BASE ?? '')) throw new Failure('the backup\'s .env has no valid LAWOSS_BASE');
  const badProxy = proxyProblem({ http: vars.LAWOSS_HTTP_PORT, https: vars.LAWOSS_HTTPS_PORT, bind: vars.LAWOSS_PROXY_BIND });
  if (badProxy) throw new Failure(`the backup's .env has an invalid ${badProxy}; refusing it`);
  const version = vars.LAWOSS_RELEASE;
  if (!VERSION.test(version ?? '')) throw new Failure('the backup\'s .env has no valid LAWOSS_RELEASE');
  const recordFile = files.get(`host/releases/${version}.json`);
  if (!recordFile) throw new Failure(`the backup holds no record of release ${version}`);
  if (sha256(recordFile) !== pin) throw new Failure(`the backup's record of release ${version} does not match the pinned value; refusing it`);
  let record;
  try { record = JSON.parse(recordFile.toString('utf8')); } catch { throw new Failure(`the backup's record of release ${version} is not valid JSON`); }
  validateRecord(record, version);
  for (const [name, key] of Object.entries(IMAGE_VARS))
    if (vars[key] !== record.images[name]) throw new Failure(`the backup's ${name} image is not the one its pinned record names; refusing it`);
  const image = requireImage(vars.LAWOSS_AUTH_IMAGE, 'backup auth');
  const prefix = `host/releases/${version}/`;
  const wrong = Object.entries(record.files).filter(([path, digest]) => {
    const data = files.get(`${prefix}${path}`);
    return !data || sha256(data) !== digest;
  }).map(([path]) => path);
  for (const name of files.keys())
    if (name.startsWith(`${prefix}bin/`) && !Object.hasOwn(record.files, name.slice(prefix.length))) wrong.push(name.slice(prefix.length));
  if (wrong.length) throw new Failure(`the backup's host files of release ${version} differ from its record: ${wrong.sort().join(', ')}`);
  return { version, image, record };
}

/**
 * Replaces <root>/<name> with the backup's tree under `prefix`: built next to it, then swapped in.
 * Root-owned, 0755/0644. `keep` selects the entries (relative to the tree) that are written.
 */
function restoreTree(ctx, files, name, keep = () => true) {
  const target = join(ctx.root, name);
  const staging = join(ctx.root, `.${name}.${randomKey(9)}.tmp`);
  const old = join(ctx.root, `.${name}.${randomKey(9)}.old`);
  try {
    mkdirSync(staging, { mode: 0o755 });
    chmodSync(staging, 0o755);
    ctx.chown(staging, 0, 0);
    const prefix = `host/${name}/`;
    for (const [file, data] of files)
      if (file.startsWith(prefix) && keep(file.slice(prefix.length))) installFile(ctx, join(staging, file.slice(prefix.length)), data);
    if (existsSync(target)) renameSync(target, old);
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

async function apply(ctx, dir, privateKey, pin) {
  const p = paths(ctx.root);
  const files = readBackup(dir, privateKey);
  const { version, image, record } = backupRelease(files, pin);
  // Every check runs before the stack is stopped or any file is replaced.
  await verifyAttestations(ctx, record.images);
  if (!await checkAuthPart(ctx, dir, privateKey, image))
    throw new Failure(`the auth part of ${dir} did not pass auth's own check; nothing was changed`);

  await stopStack(ctx);
  // Of releases/, only the pinned release is restored: other kept releases are unverified here.
  restoreTree(ctx, files, 'brand');
  restoreTree(ctx, files, 'releases', path => path === `${version}.json` || path.startsWith(`${version}/`));
  installRelease(ctx, version);
  writePrivateFile(ctx, p.env, files.get('.env'));
  // Rendered from the pinned template, not taken from the backup.
  writeCaddyfile(ctx, deployment(ctx.root));

  const authData = await ensureVolume(ctx, 'auth-data');
  const auth = await ctx.run(['docker', 'run', ...WRITER, '--tmpfs', '/tmp', '-v', `${authData}:/data`,
    '-v', `${join(dir, 'auth.enc.json')}:/backup/auth.enc.json:ro`, '-v', `${privateKey}:/keys/private.pem:ro`,
    '--entrypoint', 'sh', image, '-c', AUTH_RESTORE]);
  if (auth.code !== 0) throw new Failure(`restoring auth-data failed (exit ${auth.code}); the stack is stopped`);

  // The clear hub-data archive exists only for the extraction, in a root-only directory.
  mkdirSync(p.backups, { recursive: true, mode: 0o700 });
  const staging = join(p.backups, `.restore-${randomKey(9)}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    ctx.chown(staging, 0, 0);
    const archive = join(staging, 'hub-data.tar');
    writePrivateFile(ctx, archive, files.get('hub-data.tar'), { exclusive: true });
    await extractVolume(ctx, image, 'hub-data', archive);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const failed = await startAndCheck(ctx);
  ctx.out(`${failed ? 'FAIL' : 'PASS'} restore ${dir}`);
  if (failed) ctx.err(`lawoss-selfhost: ${failed} failed after the restore; the files and volumes are restored`);
  return failed ? 1 : 0;
}
