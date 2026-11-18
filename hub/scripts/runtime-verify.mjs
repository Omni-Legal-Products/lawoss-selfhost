// Runtime provenance checks shared by fetch-runtimes (reading the catalog's git objects at image
// build) and the hub entry point (reading the fetched directory again at every start).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Checks one runtime against its own provenance manifest: the runtime files are exactly the listed
 * ones, each with its digest, and runtime-config.json has the recorded digest. `names` are the
 * runtime file names relative to runtime/, without provenance.json. Errors name files, never content.
 */
export function checkRuntime(plugin, { provenance: provenanceBytes, config, names, read }) {
  let provenance;
  try { provenance = JSON.parse(provenanceBytes); }
  catch { throw new Error(`${plugin}: runtime/provenance.json is not valid JSON`); }
  if (!provenance || typeof provenance.files !== 'object' || provenance.files === null ||
      !/^[0-9a-f]{64}$/.test(provenance.configSha256 ?? ''))
    throw new Error(`${plugin}: runtime/provenance.json must contain files and configSha256`);
  for (const name of names)
    if (!Object.hasOwn(provenance.files, name)) throw new Error(`${plugin}: runtime contains an unlisted file: ${name}`);
  for (const name of Object.keys(provenance.files))
    if (!names.includes(name)) throw new Error(`${plugin}: runtime provenance lists a missing file: ${name}`);
  for (const name of names)
    if (sha256(read(name)) !== provenance.files[name]) throw new Error(`${plugin}: runtime file digest mismatch: ${name}`);
  if (sha256(config) !== provenance.configSha256) throw new Error(`${plugin}: runtime-config.json digest mismatch`);
  return provenance;
}

/** Regular files under `dir` as slash-separated relative names; symbolic links and special files fail. */
function listRegularFiles(plugin, dir, relative = '') {
  const found = [];
  for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listRegularFiles(plugin, dir, name));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`${plugin}: not a regular file in the runtime: ${name}`);
  }
  return found;
}

function requireRegularFile(plugin, path, label) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info || !info.isFile()) throw new Error(`${plugin}: ${label} is missing or not a regular file`);
}

/** Verifies one fetch-runtimes output directory `<runtimesDir>/<plugin>` against its provenance. */
export function verifyRuntimeDir(runtimesDir, plugin) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin)) throw new Error('Invalid plugin slug');
  const base = join(runtimesDir, plugin);
  const runtime = join(base, 'runtime');
  const info = lstatSync(runtime, { throwIfNoEntry: false });
  if (!info || !info.isDirectory()) throw new Error(`${plugin}: runtime directory is missing`);
  requireRegularFile(plugin, join(runtime, 'provenance.json'), 'runtime/provenance.json');
  requireRegularFile(plugin, join(base, 'runtime-config.json'), 'runtime-config.json');
  requireRegularFile(plugin, join(base, 'scripts', 'run.mjs'), 'scripts/run.mjs');
  return checkRuntime(plugin, {
    provenance: readFileSync(join(runtime, 'provenance.json')),
    config: readFileSync(join(base, 'runtime-config.json')),
    names: listRegularFiles(plugin, runtime).filter(name => name !== 'provenance.json'),
    read: name => readFileSync(join(runtime, ...name.split('/'))),
  });
}
