// brand check PACK / brand preview PACK, run in the pinned auth image. PACK is a pack built into the
// image (brand/<name>) or an absolute host directory, mounted read-only at /app/brand/custom.
// check: auth's own pack loader, offline and read-only; prints PASS or FAIL only.
// preview: auth's preview server, which listens on 127.0.0.1:4317; with host networking that is the
// host's loopback and nothing else, reached over an SSH tunnel.
import { isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { Failure, UsageError, options, paths, readEnvFile, requireImage } from '../lib.mjs';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HARDENING = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];

function pack(name) {
  if (SLUG.test(name ?? '')) return { label: name, dir: `brand/${name}`, mounts: [] };
  if (typeof name === 'string' && isAbsolute(name) && resolve(name) === name && !/[:,\n]/.test(name)) {
    if (!existsSync(name) || !statSync(name).isDirectory()) throw new Failure(`${name} is not a directory`);
    return { label: name, dir: 'brand/custom', mounts: ['-v', `${name}:/app/brand/custom:ro`] };
  }
  throw new UsageError('PACK must be a pack name or an absolute directory');
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
  const selected = pack(name);
  const image = authImage(ctx);
  if (action === 'check') {
    const script = `import { loadBrand } from '/app/dist/brand.js'; loadBrand(${JSON.stringify(`/app/${selected.dir}`)});`;
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
    '-e', `AUTH_BRAND=${selected.dir}`, ...selected.mounts, image, 'node', 'dist/preview.js'], { inherit: true });
  return result.code === 0 || result.code === 130 ? 0 : 1;
}
