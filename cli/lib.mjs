// Shared helpers of the host-side CLI. Every message written by these helpers is a fixed string or
// names a path, host, service or field; values read from .env or produced by containers never are.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

/** Wrong arguments: exit code 2. */
export class UsageError extends Error {}
/** A failed operation: exit code 1. The message must be safe to print. */
export class Failure extends Error {}

/** uid and gid of the `node` user that the auth and hub images run as (official Node images). */
export const CONTAINER_UID = 1000;
/** Compose project name from compose.yaml; named volumes are `<project>_<volume>`. */
export const PROJECT = 'lawoss';
export const VOLUMES = ['auth-data', 'hub-data', 'caddy-data'];

/** Display names shown on the consent screen, per service id of the manifest. */
export const SERVICE_NAMES = Object.freeze({
  crz: 'Centrálny register zmlúv',
  disq: 'Register diskvalifikácií',
  eurlex: 'EUR-Lex',
  fs: 'Finančná správa',
  judikaty: 'Judikáty',
  kalkulacky: 'Právne kalkulačky',
  orsr: 'Obchodný register',
  ov: 'Obchodný vestník',
  rpo: 'Register právnických osôb',
  rpvs: 'Register partnerov verejného sektora',
  ru: 'Register úpadcov',
  ruz: 'Register účtovných závierok',
  slovlex: 'Slov-Lex',
  uvo: 'Úrad pre verejné obstarávanie',
});

// The hub's rule for the base domain (hub/src/main.ts).
export const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// An account name that auth accepts both as a user name and as a tenant, and that is a safe file name.
export const ACCOUNT = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SERVICE_ID = /^[a-z0-9]{1,32}$/;
const IMAGE = /^[a-z0-9][a-z0-9._\/:-]{0,254}@sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function paths(root) {
  return {
    root,
    env: join(root, '.env'),
    envPrevious: join(root, '.env.previous'),
    compose: join(root, 'compose.yaml'),
    caddyfile: join(root, 'Caddyfile'),
    template: join(root, 'Caddyfile.template'),
    services: join(root, 'services.json'),
    handoff: join(root, 'handoff'),
    snapshots: join(root, 'snapshots'),
    backups: join(root, 'backups'),
    keys: join(root, 'keys'),
  };
}

/** `docker compose` against the installed stack; secrets reach containers only through the env file. */
export const compose = root => ['docker', 'compose', '-f', join(root, 'compose.yaml'), '--env-file', join(root, '.env')];

/** Parses options strictly; any unknown or malformed option is a usage error. `positionals`: a count or [min, max]. */
export function options(args, spec, { positionals = 0 } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: spec, allowPositionals: positionals !== 0, strict: true });
  } catch {
    throw new UsageError('invalid options');
  }
  const [min, max] = Array.isArray(positionals) ? positionals : [positionals, positionals];
  if (parsed.positionals.length < min || parsed.positionals.length > max) throw new UsageError('wrong number of arguments');
  return parsed;
}

export const randomKey = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------------------------
// .env files in the Compose format: KEY=value, KEY='literal'; comments and blank lines are kept.

export function parseEnv(text) {
  const vars = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))))
      value = value.slice(1, -1);
    vars[match[1]] = value;
  }
  return vars;
}

export const readEnvFile = path => parseEnv(readFileSync(path, 'utf8'));

/** One value as Compose reads it back unchanged: bare when plain, else single-quoted (literal). */
export function formatEnvValue(value) {
  if (/^[A-Za-z0-9_.:@/,=+-]*$/.test(value)) return value;
  if (/['\n\r]/.test(value)) throw new Failure('a configuration value cannot be written to .env');
  return `'${value}'`;
}

/** Replaces (or appends) the given variables, keeping every other line as it is. */
export function setEnvVars(text, vars) {
  const pending = new Map(Object.entries(vars));
  const lines = text.split('\n').map(line => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${formatEnvValue(value)}`;
  });
  if (pending.size) {
    if (lines.at(-1) === '') lines.pop();
    for (const [key, value] of pending) lines.push(`${key}=${formatEnvValue(value)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Writes a root-owned 0600 file: a new file next to `path`, then a rename, so a reader sees the old
 * or the new content and never a partial one. `exclusive` refuses an existing `path` instead.
 */
export function writePrivateFile(ctx, path, content, { exclusive = false } = {}) {
  if (exclusive) {
    const fd = openSync(path, 'wx', 0o600);
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    ctx.chown(path, 0, 0);
    return;
  }
  const temp = join(dirname(path), `.${randomKey(9)}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    ctx.chown(temp, 0, 0);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The installed manifest and the deployment's own non-secret settings.

export function loadManifest(root) {
  const path = paths(root).services;
  if (!existsSync(path)) throw new Failure(`${path} is missing; install the release files first`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Failure(`${path} is not valid JSON`); }
  return manifest;
}

/** A comma-separated service list: distinct ids, each in `allowed`. */
export function parseServiceList(list, allowed) {
  const ids = String(list ?? '').split(',').map(id => id.trim());
  if (ids.length === 0 || ids.some(id => !SERVICE_ID.test(id) || !allowed.includes(id)) || new Set(ids).size !== ids.length)
    throw new UsageError('services must be a comma-separated list of distinct enabled service ids');
  return ids;
}

/** The deployment settings every command after init needs; never returns secret values. */
export function deployment(root) {
  const p = paths(root);
  if (!existsSync(p.env)) throw new Failure(`${p.env} does not exist; run init first`);
  const vars = readEnvFile(p.env);
  const base = vars.LAWOSS_BASE;
  if (!base || !DNS_NAME.test(base)) throw new Failure('.env has no valid LAWOSS_BASE; run init again on a new server');
  const services = String(vars.LAWOSS_SERVICES ?? '').split(',').filter(Boolean);
  if (!services.length || services.some(id => !SERVICE_ID.test(id))) throw new Failure('.env has no valid LAWOSS_SERVICES');
  return {
    base,
    services,
    issuer: `https://auth.${base}`,
    release: vars.LAWOSS_RELEASE ?? 'unknown',
    images: { auth: vars.LAWOSS_AUTH_IMAGE, hub: vars.LAWOSS_HUB_IMAGE, proxy: vars.LAWOSS_PROXY_IMAGE },
  };
}

export const resourceUrl = (id, base) => `https://${id}.${base}/mcp`;

export function requireImage(ref, name) {
  if (typeof ref !== 'string' || !IMAGE.test(ref)) throw new Failure(`.env has no ${name} image pinned by digest`);
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Release records: releases/<version>.json, pinned by its SHA-256 in a reviewed catalog commit.

const RECORD_FIELDS = new Set(['version', 'commit', 'images', 'note']);
const IMAGE_FIELDS = ['auth', 'hub', 'proxy'];

export function validateRecord(record, version) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Failure('release record must be a JSON object');
  for (const key of Object.keys(record)) if (!RECORD_FIELDS.has(key)) throw new Failure('release record has an unknown field');
  if (typeof record.version !== 'string' || record.version !== version) throw new Failure('release record version does not match --to');
  if (typeof record.commit !== 'string' || !/^[0-9a-f]{40}$/.test(record.commit)) throw new Failure('release record commit must be a full commit hash');
  const images = record.images;
  if (images === null || typeof images !== 'object' || Array.isArray(images) ||
      Object.keys(images).length !== IMAGE_FIELDS.length || IMAGE_FIELDS.some(name => !Object.hasOwn(images, name)))
    throw new Failure('release record images must name exactly auth, hub and proxy');
  for (const name of IMAGE_FIELDS)
    if (typeof images[name] !== 'string' || !IMAGE.test(images[name])) throw new Failure(`release record ${name} image is not pinned by digest`);
  if (typeof record.note !== 'string' || record.note.length > 4000) throw new Failure('release record note must be text');
  return record;
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** Reads a record and accepts it only when its bytes hash to the pinned value (and name `version`, if given). */
export function readRecord(path, pinnedSha, version) {
  if (!SHA256.test(pinnedSha ?? '')) throw new UsageError('--record-sha256 must be 64 lowercase hex characters');
  if (version !== undefined && !VERSION.test(version)) throw new UsageError('invalid release version');
  let bytes;
  try { bytes = readFileSync(path); } catch { throw new Failure('release record cannot be read'); }
  if (sha256(bytes) !== pinnedSha) throw new Failure('release record digest does not match the pinned value; refusing it');
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { throw new Failure('release record is not valid JSON'); }
  return validateRecord(record, version ?? (VERSION.test(record?.version ?? '') ? record.version : ''));
}

/** Text from a release note without control characters, for the terminal. */
export const printable = text => text.replace(/[^\P{C}\n]/gu, '');

/** A timestamp usable as a directory name. */
export const stamp = date => date.toISOString().replace(/[:.]/g, '-');

// ---------------------------------------------------------------------------------------------
// Build provenance (spec 5.7): the organization's CI attests the images it builds; the CLI checks
// them whenever gh is installed. The proxy is the official Caddy image, which carries no such
// attestation, so it is trusted through its pinned digest alone.

export const ATTESTATION_OWNER = 'Omni-Legal-Products';
export const ATTESTED_IMAGES = ['auth', 'hub'];

/** Refuses the release when an attestation does not verify; without gh, prints one notice. */
export async function verifyAttestations(ctx, images) {
  if (!ctx.which('gh')) {
    ctx.err('lawoss-selfhost: notice: gh is not installed, so build attestations were not verified; images are still pinned by digest');
    return;
  }
  for (const name of ATTESTED_IMAGES) {
    const result = await ctx.run(['gh', 'attestation', 'verify', `oci://${images[name]}`, '--owner', ATTESTATION_OWNER]);
    if (result.code !== 0) throw new Failure(`build attestation of the ${name} image did not verify; refusing the release`);
    ctx.err(`PASS attestation ${name}`);
  }
}
