// Shared helpers of the host-side CLI. Every message written by these helpers is a fixed string or
// names a path, host, service or field; values read from .env or produced by containers never are.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
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
// A certificate contact e-mail that Caddy reads as one token: no whitespace, braces or quotes.
export const ACME_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
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
  // A trailing backslash could escape the closing quote in Compose's dotenv reader.
  if (/['\n\r]/.test(value) || value.endsWith('\\')) throw new Failure('a configuration value cannot be written to .env');
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

/** Every provider variable some manifest entry allowlists, sorted; the only names set-key accepts. */
export function providerKeys(manifest) {
  return [...new Set(Object.values(manifest.services ?? {}).flatMap(service => Array.isArray(service?.env) ? service.env : []))]
    .filter(name => /^[A-Z][A-Z0-9_]{0,63}$/.test(name)).sort();
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
  const acmeEmail = vars.LAWOSS_ACME_EMAIL;
  return {
    base,
    services,
    acmeEmail: typeof acmeEmail === 'string' && ACME_EMAIL.test(acmeEmail) ? acmeEmail : undefined,
    issuer: `https://auth.${base}`,
    release: vars.LAWOSS_RELEASE ?? 'unknown',
    images: { auth: vars.LAWOSS_AUTH_IMAGE, hub: vars.LAWOSS_HUB_IMAGE, proxy: vars.LAWOSS_PROXY_IMAGE },
  };
}

export const resourceUrl = (id, base) => `https://${id}.${base}/mcp`;

/**
 * The Caddyfile: the global options with the certificate contact, the auth site and one copy of
 * the SERVICES section per enabled service.
 */
export function renderCaddyfile(template, { base, services, acmeEmail }) {
  if (!ACME_EMAIL.test(acmeEmail ?? '')) throw new Failure('.env has no valid LAWOSS_ACME_EMAIL for the Caddyfile');
  const section = /^# \{\{#SERVICES\}\}\n([\s\S]*?)^# \{\{\/SERVICES\}\}\n/m;
  const match = section.exec(template);
  if (!match) throw new Failure('Caddyfile.template has no SERVICES section');
  const blocks = services.map(id => match[1].replaceAll('{{SERVICE_HOST}}', `${id}.${base}`)).join('');
  return (template.slice(0, match.index) + blocks + template.slice(match.index + match[0].length))
    .replaceAll('{{AUTH_HOST}}', `auth.${base}`).replaceAll('{{ACME_EMAIL}}', acmeEmail);
}

/** Renders <root>/Caddyfile from <root>/Caddyfile.template; root-owned 0644, replaced atomically. */
export function writeCaddyfile(ctx, settings) {
  const p = paths(ctx.root);
  const text = renderCaddyfile(readFileSync(p.template, 'utf8'), settings);
  const temp = join(ctx.root, `.Caddyfile.${randomKey(9)}.tmp`);
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: 0o644 });
    chmodSync(temp, 0o644);
    ctx.chown(temp, 0, 0);
    renameSync(temp, p.caddyfile);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function requireImage(ref, name) {
  if (typeof ref !== 'string' || !IMAGE.test(ref)) throw new Failure(`.env has no ${name} image pinned by digest`);
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Release records: releases/<version>.json, pinned by its SHA-256 in a reviewed catalog commit.

export const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const RECORD_FIELDS = new Set(['version', 'commit', 'images', 'files', 'note']);
const IMAGE_FIELDS = ['auth', 'hub', 'proxy'];
/**
 * Host files a release installs under <root> from its commit: the deployment files and the CLI in
 * bin/. A record lists each with its SHA-256; these must always be among them.
 */
export const REQUIRED_HOST_FILES = ['compose.yaml', 'services.json', 'Caddyfile.template', 'bin/lawoss-selfhost.mjs', 'bin/lib.mjs'];
const HOST_FILE = /^(?:compose\.yaml|services\.json|Caddyfile\.template|bin\/package\.json|bin\/(?:commands\/)?[a-z0-9-]{1,64}\.mjs)$/;

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
  const files = record.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) throw new Failure('release record files must map host files to their sha256');
  for (const [path, digest] of Object.entries(files)) {
    if (!HOST_FILE.test(path)) throw new Failure('release record names a host file outside the installed set');
    if (typeof digest !== 'string' || !SHA256.test(digest)) throw new Failure(`release record sha256 of ${path} is invalid`);
  }
  for (const path of REQUIRED_HOST_FILES)
    if (!Object.hasOwn(files, path)) throw new Failure(`release record files must include ${path}`);
  if (typeof record.note !== 'string' || record.note.length > 4000) throw new Failure('release record note must be text');
  return record;
}

/** The host files under <root> that a record must cover: the fixed files and everything in bin/. */
export function installedHostFiles(root) {
  const found = [];
  const walk = relative => {
    const dir = join(root, relative);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk('bin');
  return found;
}

/**
 * Refuses a release until its host files are installed: every file the record lists must exist
 * under <root> as a regular file with the recorded SHA-256, and bin/ must hold nothing else.
 * Nothing is downloaded; the skill installs the files from the record's commit.
 */
export function verifyHostFiles(root, record) {
  const wrong = hostFileDifferences(root, record);
  if (wrong.length)
    throw new Failure(`host files of release ${record.version} must be installed first: ${wrong.join(', ')} differ from its record`);
}

/** The record's host files that are missing or changed under `dir`, and the bin/ files it does not list; sorted. */
export function hostFileDifferences(dir, record) {
  const wrong = [];
  for (const [path, digest] of Object.entries(record.files)) {
    const full = join(dir, path);
    const info = lstatSync(full, { throwIfNoEntry: false });
    if (!info?.isFile() || sha256(readFileSync(full)) !== digest) wrong.push(path);
  }
  for (const path of installedHostFiles(dir)) if (!Object.hasOwn(record.files, path)) wrong.push(path);
  return wrong.sort();
}

/** Keeps the accepted record (no secret) as <root>/releases/<version>.json, for rollback. */
export function keepRecord(ctx, record) {
  const dir = join(ctx.root, 'releases');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const path = join(dir, `${record.version}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  chmodSync(path, 0o644);
  ctx.chown(path, 0, 0);
}

/** A record kept by keepRecord, re-validated. */
export function keptRecord(root, version) {
  const path = join(root, 'releases', `${version}.json`);
  if (!VERSION.test(version ?? '') || !existsSync(path)) throw new Failure(`the record of release ${version} is not kept in ${join(root, 'releases')}`);
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Failure(`${path} is not valid JSON`); }
  return validateRecord(record, version);
}


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

/** gh accepts --owner or --repo, not both; the repository is the narrower binding. */
export const ATTESTATION_REPO = 'Omni-Legal-Products/lawoss-selfhost';
export const ATTESTED_IMAGES = ['auth', 'hub'];

/** Refuses the release when an attestation does not verify; without gh, prints one notice. */
export async function verifyAttestations(ctx, images) {
  if (!ctx.which('gh')) {
    ctx.err('lawoss-selfhost: notice: gh is not installed, so build attestations were not verified; images are still pinned by digest');
    return;
  }
  for (const name of ATTESTED_IMAGES) {
    const result = await ctx.run(['gh', 'attestation', 'verify', `oci://${images[name]}`, '--repo', ATTESTATION_REPO]);
    if (result.code !== 0) {
      ctx.err('hint: gh must be logged in as root to verify attestations (sudo gh auth login, or GH_TOKEN for root)');
      throw new Failure(`build attestation of the ${name} image did not verify; refusing the release`);
    }
    ctx.err(`PASS attestation ${name}`);
  }
}
