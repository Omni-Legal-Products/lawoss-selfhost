// backup init-key: creates the backup key pair once, an RSA-3072 private key (0600) the human must
// copy off the server and its public half (0644). It never replaces an existing public key.
// backup: an encrypted backup of both data volumes and the configuration, into
// <root>/backups/<time>/ (0700). The auth part is auth's own scripts/backup.mjs snapshot; the host
// part (.env, Caddyfile, a tar of hub-data) is sealed here the same way (AES-256-GCM, key wrapped
// with RSA-OAEP-SHA256). Both use keys/backup-public.pem only; the private key is never read, so it
// can live off the server.
// restore --dry-run [DIR]: decrypts and checks a backup (the auth part in a throwaway container
// whose destination is a tmpfs) and writes nothing.
import {
  constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  Failure, PROJECT, UsageError, deployment, options, paths, readEnvFile, requireImage, sha256, stamp, writePrivateFile,
} from '../lib.mjs';

const LABEL = Buffer.from('lawoss-selfhost-backup:v1:host');
const FORMAT = 'lawoss-selfhost-backup-v1';
const oaep = key => ({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: LABEL });
/** One-off containers: no network, read-only root, root with only the right to read every file. */
const READER = ['--rm', '--read-only', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
  '--security-opt', 'no-new-privileges:true'];

function keyPaths(root) {
  const dir = paths(root).keys;
  return { dir, private: join(dir, 'backup-private.pem'), public: join(dir, 'backup-public.pem') };
}

/** keys/, root-only. */
function keyDir(ctx) {
  const keys = keyPaths(ctx.root);
  mkdirSync(keys.dir, { recursive: true, mode: 0o700 });
  chmodSync(keys.dir, 0o700);
  ctx.chown(keys.dir, 0, 0);
  return keys;
}

/** Creates the pair once; an existing public key is never replaced (backups are sealed to it). */
function initKey(ctx) {
  const keys = keyPaths(ctx.root);
  if (existsSync(keys.public)) throw new Failure(`${keys.public} already exists; the backup key is created once and never regenerated`);
  if (existsSync(keys.private)) throw new Failure(`${keys.private} already exists without its public key; restore the public key or move the private key away first`);
  keyDir(ctx);
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  writePrivateFile(ctx, keys.private, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { exclusive: true });
  writeFileSync(keys.public, pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 });
  chmodSync(keys.public, 0o644);
  ctx.chown(keys.public, 0, 0);
  ctx.out(keys.private);
  ctx.out(keys.public);
  ctx.err('Copy the backup private key (first path) to a safe place off this server and delete it here; backups cannot be restored without it.');
  return 0;
}

/** The public key every backup is sealed to; a missing or weak key is a loud failure, never a new pair. */
function backupPublicKey(root) {
  const keys = keyPaths(root);
  if (!existsSync(keys.public)) throw new Failure(`${keys.public} does not exist; run backup init-key once`);
  let key;
  try { key = createPublicKey(readFileSync(keys.public)); } catch { throw new Failure(`${keys.public} is not a public key`); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072)
    throw new Failure(`${keys.public} must be an RSA key of at least 3072 bits`);
  return keys.public;
}

export function seal(content, publicPem) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(LABEL);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
  return {
    format: FORMAT,
    part: 'host',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    key: publicEncrypt(oaep(createPublicKey(publicPem)), key).toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function unseal(envelope, privatePem) {
  if (envelope?.format !== FORMAT || envelope.part !== 'host') throw new Failure('not a host backup');
  const key = privateDecrypt(oaep(createPrivateKey(privatePem)), Buffer.from(envelope.key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(LABEL);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const content = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  for (const [name, data] of Object.entries(content.files ?? {}))
    if (sha256(Buffer.from(data, 'base64')) !== content.manifest?.[name]) throw new Failure('checksum mismatch');
  return content;
}

export async function backup(args, ctx) {
  const { positionals } = options(args, {}, { positionals: [0, 1] });
  if (positionals[0] !== undefined && positionals[0] !== 'init-key') throw new UsageError('backup takes no argument or init-key');
  if (positionals[0] === 'init-key') return initKey(ctx);
  const p = paths(ctx.root);
  const { release } = deployment(ctx.root);
  const env = readFileSync(p.env);
  const image = requireImage(readEnvFile(p.env).LAWOSS_AUTH_IMAGE, 'auth');
  const publicKey = backupPublicKey(ctx.root);

  mkdirSync(p.backups, { recursive: true, mode: 0o700 });
  chmodSync(p.backups, 0o700);
  const dir = join(p.backups, stamp(ctx.now()));
  mkdirSync(dir, { mode: 0o700 });
  ctx.chown(dir, 0, 0);
  const config = join(dir, 'auth-config.json');
  const archive = join(dir, 'hub-data.tar');
  try {
    // Auth reads its config from this 0600 file, never from argv or the container environment.
    writePrivateFile(ctx, config, readEnvFile(p.env).AUTH_CONFIG_JSON ?? '', { exclusive: true });
    const auth = await ctx.run(['docker', 'run', ...READER, '--tmpfs', '/tmp',
      '-v', `${PROJECT}_auth-data:/data:ro`, '-v', `${dir}:/backup`, '-v', `${publicKey}:/keys/public.pem:ro`,
      '--entrypoint', 'node', image, 'scripts/backup.mjs', 'snapshot',
      '--config', '/backup/auth-config.json', '--public-key', '/keys/public.pem', '--output', '/backup/auth.enc.json']);
    if (auth.code !== 0) throw new Failure(`auth backup failed (exit ${auth.code})`);
    const hub = await ctx.run(['docker', 'run', ...READER,
      '-v', `${PROJECT}_hub-data:/source/hub-data:ro`, '-v', `${dir}:/backup`,
      '--entrypoint', 'tar', image, '-cf', '/backup/hub-data.tar', '-C', '/source', 'hub-data']);
    if (hub.code !== 0) throw new Failure(`hub-data backup failed (exit ${hub.code})`);

    const files = { '.env': env, Caddyfile: existsSync(p.caddyfile) ? readFileSync(p.caddyfile) : Buffer.alloc(0), 'hub-data.tar': readFileSync(archive) };
    const content = {
      createdAt: ctx.now().toISOString(),
      release,
      files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, data.toString('base64')])),
      manifest: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha256(data)])),
    };
    writePrivateFile(ctx, join(dir, 'host.enc.json'), `${JSON.stringify(seal(content, readFileSync(publicKey)))}\n`, { exclusive: true });
    const authFile = join(dir, 'auth.enc.json');
    if (!existsSync(authFile)) throw new Failure('auth backup wrote no file');
    ctx.chown(authFile, 0, 0);
    chmodSync(authFile, 0o600);
  } finally {
    rmSync(config, { force: true });
    rmSync(archive, { force: true });
  }
  ctx.out(dir);
  return 0;
}

function latestBackup(root) {
  const dir = paths(root).backups;
  const names = existsSync(dir) ? readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(name)).sort() : [];
  if (!names.length) throw new Failure(`no backup in ${dir}`);
  return join(dir, names.at(-1));
}

export async function restore(args, ctx) {
  const { values, positionals } = options(args, { 'dry-run': { type: 'boolean' }, 'private-key': { type: 'string' } }, { positionals: [0, 1] });
  if (!values['dry-run']) throw new UsageError('only restore --dry-run is available in version 1');
  const dir = positionals[0] ? resolve(positionals[0]) : latestBackup(ctx.root);
  if (positionals[0] && (!isAbsolute(positionals[0]) || /[:,\n]/.test(dir))) throw new UsageError('BACKUP_DIR must be an absolute path');
  const privateKey = values['private-key'] ?? keyPaths(ctx.root).private;
  if (!isAbsolute(privateKey) || /[:,\n]/.test(privateKey)) throw new UsageError('--private-key must be an absolute path');
  const p = paths(ctx.root);
  const image = requireImage(existsSync(p.env) ? readEnvFile(p.env).LAWOSS_AUTH_IMAGE : undefined, 'auth');

  let ok = false;
  try {
    unseal(JSON.parse(readFileSync(join(dir, 'host.enc.json'), 'utf8')), readFileSync(privateKey));
    const result = await ctx.run(['docker', 'run', '--rm', '--read-only', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp',
      '-v', `${join(dir, 'auth.enc.json')}:/backup/auth.enc.json:ro`, '-v', `${privateKey}:/keys/private.pem:ro`,
      '--entrypoint', 'node', image, 'scripts/backup.mjs', 'restore',
      '--input', '/backup/auth.enc.json', '--private-key', '/keys/private.pem', '--destination', '/tmp/restore-check']);
    ok = result.code === 0;
  } catch {
    ok = false;
  }
  ctx.out(`${ok ? 'PASS' : 'FAIL'} backup ${dir}`);
  return ok ? 0 : 1;
}
