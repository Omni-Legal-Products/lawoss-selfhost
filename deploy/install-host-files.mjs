// install-host-files.mjs RECORD SRC_DIR ROOT: run by install-host-files.sh with the Node binary it
// took from the pinned auth image, after it checked RECORD's SHA-256. Checks that the source files of
// deploy/host-files.mjs are exactly the record's host files with the recorded SHA-256, before
// anything is written; then installs each into ROOT (a temporary file and a rename; the wrapper
// 0755, every other file 0644), removes CLI files the record does not list and checks ROOT again.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostFileSources } from './host-files.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { process.stderr.write(`install-host-files: ${message}\n`); process.exit(1); };

const [recordPath, src, root] = process.argv.slice(2);
let record;
try { record = JSON.parse(readFileSync(recordPath, 'utf8')); } catch { fail('the release record is not valid JSON'); }
const files = record?.files;
if (files === null || typeof files !== 'object' || Array.isArray(files) ||
    Object.values(files).some(digest => typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)))
  fail('the release record has no valid files map');

let sources;
try { sources = hostFileSources(src); } catch (error) { fail(`the source tree is incomplete: ${error.message}`); }
const wrong = [...new Set([...Object.keys(files), ...Object.keys(sources)])].filter(path =>
  !Object.hasOwn(files, path) || !Object.hasOwn(sources, path) || sha256(readFileSync(join(src, sources[path]))) !== files[path]).sort();
if (wrong.length) fail(`the source tree does not match the release record: ${wrong.join(', ')}; nothing was installed`);

const binFiles = dir => {
  const found = [];
  const walk = relative => {
    if (!lstatSync(join(dir, relative), { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path); else found.push(path);
    }
  };
  walk('bin');
  return found;
};

for (const [path, from] of Object.entries(sources)) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  const temp = join(dirname(target), `.${randomBytes(9).toString('base64url')}.tmp`);
  const mode = path === 'bin/lawoss-selfhost' ? 0o755 : 0o644;
  writeFileSync(temp, readFileSync(join(src, from)), { flag: 'wx', mode });
  chmodSync(temp, mode);
  renameSync(temp, target);
}
for (const path of binFiles(root)) if (!Object.hasOwn(files, path)) rmSync(join(root, path));
const left = Object.entries(files).filter(([path, digest]) => !existsSync(join(root, path)) || sha256(readFileSync(join(root, path))) !== digest);
if (left.length) fail(`installed files differ from the record: ${left.map(([path]) => path).join(', ')}`);
process.stdout.write(`installed the host files of release ${typeof record.version === 'string' ? record.version.replace(/[^0-9A-Za-z.+-]/g, '') : '?'} into ${root}\n`);
