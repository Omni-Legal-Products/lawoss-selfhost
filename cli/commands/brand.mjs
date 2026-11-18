// Brand packs. auth reads custom packs from <root>/brand, bind-mounted read-only at /brand
// (compose.yaml); the packs built into the auth image stay at /app/brand/<name>. A PACK argument is
// a pack name (a copy in <root>/brand first, else a built-in pack) or an absolute host directory,
// which is copied to <root>/brand/<directory name> (regular files only, root-owned, world-readable:
// a pack holds no secret, and auth runs as the node user).
// brand check PACK: auth's own pack loader in the pinned image, offline and read-only; PASS or FAIL.
// brand preview PACK: auth's preview server, which listens on 127.0.0.1:4317; with host networking
// that is the host's loopback and nothing else, reached over an SSH tunnel.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Failure, UsageError, options, paths, randomKey, readEnvFile, requireImage } from '../lib.mjs';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HARDENING = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
/** Where compose.yaml mounts <root>/brand inside the auth container. */
export const BRAND_MOUNT = '/brand';
const MAX_PACK_BYTES = 20 * 1024 * 1024;
const MAX_PACK_FILES = 200;

/** <root>/brand, which compose bind-mounts and never creates itself. */
export function ensureBrandDir(ctx) {
  const dir = join(ctx.root, 'brand');
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Failure(`${dir} is not a directory`);
  chmodSync(dir, 0o755);
  ctx.chown(dir, 0, 0);
  return dir;
}

/** Lists a pack's files; refuses anything but plain directories and regular files, and oversized packs. */
function packFiles(source) {
  const files = [];
  let bytes = 0;
  const walk = relative => {
    for (const name of readdirSync(join(source, relative)).sort()) {
      const path = join(relative, name);
      const info = lstatSync(join(source, path));
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) {
        bytes += info.size;
        files.push(path);
      } else throw new Failure(`a brand pack may contain only directories and regular files: ${path}`);
      if (files.length > MAX_PACK_FILES || bytes > MAX_PACK_BYTES) throw new Failure('the brand pack is too large');
    }
  };
  walk('');
  if (!files.includes('brand.json')) throw new Failure('the brand pack has no brand.json');
  return files;
}

/** Copies a host directory to <root>/brand/<slug> (replacing an earlier copy) and returns the slug. */
function installPack(ctx, source) {
  const slug = basename(source);
  if (!SLUG.test(slug)) throw new UsageError('the pack directory name must be a lowercase name (letters, digits, -)');
  if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new Failure(`${source} is not a directory`);
  const brandDir = ensureBrandDir(ctx);
  const target = join(brandDir, slug);
  if (resolve(source) === target) { packFiles(source); return slug; }
  const files = packFiles(source);
  const incoming = join(brandDir, `.incoming-${randomKey(9)}`);
  // Root-owned and world-readable once complete: the auth container reads it as `node`.
  const own = path => {
    ctx.chown(path, 0, 0);
    if (lstatSync(path).isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) own(join(path, name));
    } else chmodSync(path, 0o644);
  };
  try {
    mkdirSync(incoming);
    for (const file of files) {
      mkdirSync(dirname(join(incoming, file)), { recursive: true });
      writeFileSync(join(incoming, file), readFileSync(join(source, file)), { flag: 'wx' });
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(incoming, target);
    own(target);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
  return slug;
}

/**
 * Resolves PACK. `config` is auth's `brand` value (undefined for the default pack), `dir` the pack's
 * path inside the container, `mounts` the extra docker run arguments that make it visible there.
 */
const isPackDir = name => typeof name === 'string' && isAbsolute(name) && resolve(name) === name && !/[:,\n]/.test(name);

/** A usage error unless PACK is a pack name or an absolute directory. */
export function checkPackArg(name) {
  if (!SLUG.test(name ?? '') && !isPackDir(name)) throw new UsageError('PACK must be a pack name or an absolute directory');
}

export function resolvePack(ctx, name) {
  checkPackArg(name);
  const slug = SLUG.test(name) ? name : installPack(ctx, name);
  const mounted = join(ctx.root, 'brand', slug);
  if (existsSync(mounted) && lstatSync(mounted).isDirectory()) {
    const dir = `${BRAND_MOUNT}/${slug}`;
    return { label: slug, config: dir, dir, preview: dir, mounts: ['-v', `${join(ctx.root, 'brand')}:${BRAND_MOUNT}:ro`] };
  }
  return { label: slug, config: slug === 'default' ? undefined : `brand/${slug}`, dir: `/app/brand/${slug}`, preview: `brand/${slug}`, mounts: [] };
}

function authImage(ctx) {
  const env = paths(ctx.root).env;
  if (!existsSync(env)) throw new Failure(`${env} does not exist; run init first`);
  return requireImage(readEnvFile(env).LAWOSS_AUTH_IMAGE, 'auth');
}

export async function brand(args, ctx) {
  const { positionals } = options(args, {}, { positionals: 2 });
  const [action, name] = positionals;
  if (action !== 'check' && action !== 'preview') throw new UsageError('brand takes check or preview');
  checkPackArg(name);
  const image = authImage(ctx);
  const selected = resolvePack(ctx, name);
  if (action === 'check') {
    const script = `import { loadBrand } from '/app/dist/brand.js'; loadBrand(${JSON.stringify(selected.dir)});`;
    const result = await ctx.run(['docker', 'run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', ...selected.mounts, '--entrypoint', 'node', image, '--input-type=module', '-e', script]);
    ctx.out(`${result.code === 0 ? 'PASS' : 'FAIL'} brand ${selected.label}`);
    return result.code === 0 ? 0 : 1;
  }
  ctx.out('Preview on the server at http://127.0.0.1:4317 (loopback only). From your computer run:');
  ctx.out('  ssh -N -L 4317:127.0.0.1:4317 USER@SERVER');
  ctx.out('then open http://127.0.0.1:4317 and stop the preview with Ctrl-C.');
  // --init: node as PID 1 would ignore Ctrl-C.
  const result = await ctx.run(['docker', 'run', '--rm', '--init', '--network', 'host', ...HARDENING, '--tmpfs', '/tmp',
    '-e', `AUTH_BRAND=${selected.preview}`, ...selected.mounts, image, 'node', 'dist/preview.js'], { inherit: true });
  return result.code === 0 || result.code === 130 ? 0 : 1;
}
