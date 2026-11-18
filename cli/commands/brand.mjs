// Brand packs. auth reads custom packs from <root>/brand, bind-mounted read-only at /brand
// (compose.yaml); the packs built into the auth image stay at /app/brand/<name>.
// A PACK argument is one of:
//   - an absolute host directory: brand.json and only the files it declares are copied, without
//     following symbolic links, into a staging directory <root>/brand/.incoming-*, and the pack is
//     seen by auth as /brand/<directory name>;
//   - the name of a pack installed in <root>/brand;
//   - the name of a pack built into the image (`default` is the LAWOSS pack auth uses without one).
// brand check PACK / brand preview PACK validate or preview (staged copy, nothing installed), with
// the auth image from .env or, before init, from the pinned release record.
// brand set PACK validates, installs the staged copy atomically, points auth's config at it through
// the atomic .env writer and recreates auth.
// Packs hold no secret: installed files are root-owned and world-readable (auth runs as `node`).
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  Failure, UsageError, compose, deployment, options, parseEnv, paths, randomKey, readEnvFile, readRecord, requireImage, setEnvVars,
  verifyAttestations, writePrivateFile,
} from '../lib.mjs';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HARDENING = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
/** Where compose.yaml mounts <root>/brand inside the auth container. */
export const BRAND_MOUNT = '/brand';
// auth's own limits (auth/src/brand.ts): 512 KiB per asset.
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_BRAND_JSON_BYTES = 64 * 1024;
const MAX_ASSETS = 64;
const ASSET = /^[A-Za-z0-9._/-]{1,200}$/;

/** <root>/brand, which compose bind-mounts and never creates itself. */
export function ensureBrandDir(ctx) {
  const dir = join(ctx.root, 'brand');
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Failure(`${dir} is not a directory`);
  chmodSync(dir, 0o755);
  ctx.chown(dir, 0, 0);
  return dir;
}

/** Root-owned, directories 0755 and files 0644. */
function own(ctx, path) {
  ctx.chown(path, 0, 0);
  if (lstatSync(path).isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) own(ctx, join(path, name));
  } else chmodSync(path, 0o644);
}

/** Reads one regular file of a pack without following a symbolic link at any level. */
function readPackFile(source, relative, limit) {
  const notFile = new Failure(`${relative} is not a regular file in the pack`);
  let dir = source;
  for (const part of relative.split('/').slice(0, -1)) {
    dir = join(dir, part);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw notFile;
  }
  let fd;
  try { fd = openSync(join(source, relative), constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw notFile; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw notFile;
    if (info.size > limit) throw new Failure(`${relative} is larger than auth accepts`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The asset paths brand.json declares (auth's rules: relative, inside the pack, no hidden parts). */
function declaredAssets(raw) {
  const assets = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw.assets : undefined;
  if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) throw new Failure('brand.json has no assets object');
  const values = [assets.logo, assets.logoDark, assets.mark, assets.artwork, assets.tokens,
    ...(Array.isArray(assets.fonts) ? assets.fonts.map(font => font?.file) : []),
    ...(Array.isArray(assets.extra) ? assets.extra : [])].filter(value => value !== undefined);
  const paths = new Set();
  for (const value of values) {
    const parts = typeof value === 'string' ? value.split('/') : [];
    if (typeof value !== 'string' || !ASSET.test(value) ||
        parts.some(part => part === '' || part === '.' || part === '..' || part.startsWith('.')) || value === 'brand.json')
      throw new Failure(`brand.json declares an asset outside the pack: ${typeof value === 'string' && ASSET.test(value) ? value : '(invalid path)'}`);
    paths.add(value);
  }
  if (paths.size > MAX_ASSETS) throw new Failure('brand.json declares too many assets');
  return [...paths].sort();
}

/** Copies brand.json and its declared files into <root>/brand/.incoming-*; returns the slug and staging path. */
function stagePack(ctx, source) {
  const slug = basename(source);
  if (!SLUG.test(slug)) throw new UsageError('the pack directory name must be a lowercase name (letters, digits, -)');
  if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new Failure(`${source} is not a directory`);
  const brandJson = readPackFile(source, 'brand.json', MAX_BRAND_JSON_BYTES);
  let raw;
  try { raw = JSON.parse(brandJson.toString('utf8')); } catch { throw new Failure('brand.json is not valid JSON'); }
  const files = new Map([['brand.json', brandJson]]);
  for (const path of declaredAssets(raw)) files.set(path, readPackFile(source, path, MAX_ASSET_BYTES));

  const staging = join(ensureBrandDir(ctx), `.incoming-${randomKey(9)}`);
  try {
    mkdirSync(staging);
    for (const [path, body] of files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      writeFileSync(join(staging, path), body, { flag: 'wx' });
    }
    own(ctx, staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { slug, staging };
}

/** Moves a validated staging copy to <root>/brand/<slug>, replacing an earlier copy only once it is in place. */
export function installStaged(ctx, staging, slug) {
  const brandDir = ensureBrandDir(ctx);
  const target = join(brandDir, slug);
  const old = join(brandDir, `.old-${randomKey(9)}`);
  const hadOld = existsSync(target);
  if (hadOld) renameSync(target, old);
  try {
    renameSync(staging, target);
  } catch (error) {
    if (hadOld) renameSync(old, target);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
  own(ctx, target);
}

const isPackDir = name => typeof name === 'string' && isAbsolute(name) && resolve(name) === name && !/[:,\n]/.test(name);

/** A usage error unless PACK is a pack name or an absolute directory. */
export function checkPackArg(name) {
  if (!SLUG.test(name ?? '') && !isPackDir(name)) throw new UsageError('PACK must be a pack name or an absolute directory');
}

/**
 * Resolves PACK: `config` is auth's `brand` value (undefined for the default pack), `dir` its path in
 * the container, `preview` the AUTH_BRAND value, `mounts` the docker run arguments that show it
 * there, and release() removes a staged copy that was not installed.
 */
export function resolvePack(ctx, name) {
  checkPackArg(name);
  if (isPackDir(name)) {
    const { slug, staging } = stagePack(ctx, name);
    const dir = `${BRAND_MOUNT}/${slug}`;
    return {
      label: slug, slug, staging, config: dir, dir, preview: dir, mounts: ['-v', `${staging}:${dir}:ro`],
      release: () => rmSync(staging, { recursive: true, force: true }),
    };
  }
  const installed = join(ctx.root, 'brand', name);
  if (lstatSync(installed, { throwIfNoEntry: false })?.isDirectory()) {
    const dir = `${BRAND_MOUNT}/${name}`;
    return { label: name, slug: name, config: dir, dir, preview: dir, mounts: ['-v', `${installed}:${dir}:ro`], release() {} };
  }
  return {
    label: name, slug: name, config: name === 'default' ? undefined : `brand/${name}`, dir: `/app/brand/${name}`,
    preview: `brand/${name}`, mounts: [], release() {},
  };
}

/** auth's own pack loader in the pinned image, offline and read-only; output is never passed on. */
export async function checkPack(ctx, image, pack) {
  const script = `import { loadBrand } from '/app/dist/brand.js'; loadBrand(${JSON.stringify(pack.dir)});`;
  const result = await ctx.run(['docker', 'run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', ...pack.mounts, '--entrypoint', 'node', image, '--input-type=module', '-e', script]);
  return result.code === 0;
}

/** The auth image: from the pinned record before init, else from .env. */
async function authImage(ctx, values) {
  if (values.record !== undefined || values['record-sha256'] !== undefined) {
    if (!values.record || !values['record-sha256']) throw new UsageError('--record and --record-sha256 go together');
    const record = readRecord(values.record, values['record-sha256']);
    await verifyAttestations(ctx, record.images);
    return record.images.auth;
  }
  const env = paths(ctx.root).env;
  if (!existsSync(env)) throw new Failure(`${env} does not exist; run init first or pass --record and --record-sha256`);
  return requireImage(readEnvFile(env).LAWOSS_AUTH_IMAGE, 'auth');
}

/** Sets or clears auth's `brand` in AUTH_CONFIG_JSON through the atomic .env writer. */
function configureBrand(ctx, value) {
  const env = paths(ctx.root).env;
  const text = readFileSync(env, 'utf8');
  let config;
  try { config = JSON.parse(parseEnv(text).AUTH_CONFIG_JSON); } catch { throw new Failure('.env has no readable AUTH_CONFIG_JSON'); }
  if (value === undefined) delete config.brand;
  else config.brand = value;
  writePrivateFile(ctx, env, setEnvVars(text, { AUTH_CONFIG_JSON: JSON.stringify(config) }));
}

export async function brand(args, ctx) {
  const { values, positionals } = options(args, { record: { type: 'string' }, 'record-sha256': { type: 'string' } }, { positionals: 2 });
  const [action, name] = positionals;
  if (!['check', 'preview', 'set'].includes(action)) throw new UsageError('brand takes check, preview or set');
  checkPackArg(name);
  if (action === 'set') {
    if (values.record !== undefined || values['record-sha256'] !== undefined) throw new UsageError('brand set uses the deployment\'s own auth image');
    deployment(ctx.root);
  }
  const image = await authImage(ctx, values);
  const pack = resolvePack(ctx, name);
  try {
    if (action === 'preview') {
      ctx.out('Preview on the server at http://127.0.0.1:4317 (loopback only). From your computer run:');
      ctx.out('  ssh -N -L 4317:127.0.0.1:4317 USER@SERVER');
      ctx.out('then open http://127.0.0.1:4317 and stop the preview with Ctrl-C.');
      // --init: node as PID 1 would ignore Ctrl-C.
      const result = await ctx.run(['docker', 'run', '--rm', '--init', '--network', 'host', ...HARDENING, '--tmpfs', '/tmp',
        '-e', `AUTH_BRAND=${pack.preview}`, ...pack.mounts, image, 'node', 'dist/preview.js'], { inherit: true });
      return result.code === 0 || result.code === 130 ? 0 : 1;
    }
    const passed = await checkPack(ctx, image, pack);
    ctx.out(`${passed ? 'PASS' : 'FAIL'} brand ${pack.label}`);
    if (!passed || action === 'check') return passed ? 0 : 1;

    if (pack.staging) installStaged(ctx, pack.staging, pack.slug);
    configureBrand(ctx, pack.config);
    const result = await ctx.run([...compose(ctx.root), 'up', '-d', '--force-recreate', 'auth']);
    if (result.code !== 0) throw new Failure(`auth did not restart (exit ${result.code}); .env already names brand ${pack.label}`);
    ctx.out(`auth uses brand ${pack.label}`);
    return 0;
  } finally {
    pack.release();
  }
}
