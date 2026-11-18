#!/usr/bin/env node
// release-record.mjs: writes releases/<version>.json to stdout for a checkout, as the release
// workflow publishes it: the commit, the image digests (auth and hub as built and pushed, the proxy
// pinned in deploy/.env.example) and the SHA-256 of every host file of deploy/host-files.mjs.
//   node deploy/release-record.mjs --src DIR --version V --commit SHA --auth REF@sha256:.. --hub REF@sha256:.. --note TEXT
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hostFileSources } from './host-files.mjs';

const IMAGE = /^[a-z0-9][a-z0-9._\/:-]{0,254}@sha256:[0-9a-f]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function releaseRecord({ src, version, commit, auth, hub, note }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version ?? '')) throw new Error('--version is invalid');
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('--commit must be a full commit hash');
  for (const [name, ref] of Object.entries({ auth, hub })) if (!IMAGE.test(ref ?? '')) throw new Error(`--${name} must be pinned by digest`);
  const proxy = /^LAWOSS_PROXY_IMAGE=(.*)$/m.exec(readFileSync(join(src, 'deploy', '.env.example'), 'utf8'))?.[1];
  if (!IMAGE.test(proxy ?? '')) throw new Error('deploy/.env.example has no proxy image pinned by digest');
  if (typeof note !== 'string' || note.length > 4000) throw new Error('--note must be text of at most 4000 characters');
  const files = Object.fromEntries(Object.entries(hostFileSources(src)).sort(([a], [b]) => a.localeCompare(b))
    .map(([host, from]) => [host, sha256(readFileSync(join(src, from)))]));
  return { version, commit, images: { auth, hub, proxy }, files, note };
}

const { values } = parseArgs({
  options: Object.fromEntries(['src', 'version', 'commit', 'auth', 'hub', 'note'].map(name => [name, { type: 'string' }])),
  strict: true,
});
try {
  process.stdout.write(`${JSON.stringify(releaseRecord({ ...values, src: values.src ?? '.' }), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`release-record: ${error.message}\n`);
  process.exitCode = 1;
}
