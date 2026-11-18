// The one map from repository paths to the host files a release installs under /opt/lawoss. The
// release workflow (release-record.mjs) hashes these files into releases/<version>.json and
// install-host-files.sh installs them; the CLI's record schema (cli/lib.mjs HOST_FILE) accepts
// exactly these host paths. Node standard library only.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** [repository path, host path]; a `*.mjs` source names every module in that directory. */
export const HOST_FILE_MAP = Object.freeze([
  ['deploy/compose.yaml', 'compose.yaml'],
  ['deploy/Caddyfile.template', 'Caddyfile.template'],
  ['hub/services.json', 'services.json'],
  ['cli/lawoss-selfhost', 'bin/lawoss-selfhost'],
  ['cli/package.json', 'bin/package.json'],
  ['cli/*.mjs', 'bin/'],
  ['cli/commands/*.mjs', 'bin/commands/'],
]);

/** Host path -> repository path for a checkout at `src`; every listed file must be a regular file. */
export function hostFileSources(src) {
  const sources = {};
  for (const [from, to] of HOST_FILE_MAP) {
    if (from.endsWith('/*.mjs')) {
      const dir = from.slice(0, -'/*.mjs'.length);
      for (const entry of readdirSync(join(src, dir), { withFileTypes: true }))
        if (entry.isFile() && entry.name.endsWith('.mjs')) sources[`${to}${entry.name}`] = `${dir}/${entry.name}`;
    } else {
      if (!lstatSync(join(src, from), { throwIfNoEntry: false })?.isFile()) throw new Error(`${from} is not a regular file`);
      sources[to] = from;
    }
  }
  return sources;
}
