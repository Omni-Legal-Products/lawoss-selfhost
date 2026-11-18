#!/usr/bin/env node
// Copies plugin runtimes from a local checkout of the public catalog at one recorded commit and
// verifies each against the runtime's own provenance manifest. Output layout (what the launcher expects):
//   OUT/<plugin>/{runtime/**, runtime-config.json, scripts/run.mjs}
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node fetch-runtimes.mjs --catalog DIR --catalog-commit SHA --out DIR [--services FILE]';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

function parseArgs(argv) {
  const known = new Set(['--catalog', '--catalog-commit', '--out', '--services']);
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i + 1] === undefined) fail(usage);
    values[argv[i]] = argv[i + 1];
  }
  if (!values['--catalog'] || !values['--catalog-commit'] || !values['--out']) fail(usage);
  if (!/^[0-9a-f]{40}$/.test(values['--catalog-commit'])) fail('--catalog-commit must be a full 40-character commit id');
  return {
    catalog: resolve(values['--catalog']),
    commit: values['--catalog-commit'],
    out: resolve(values['--out']),
    services: resolve(values['--services'] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'services.json')),
  };
}

const git = (catalog, args) => execFileSync('git', ['-C', catalog, ...args], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });

function listFiles(catalog, commit, prefix) {
  const lines = git(catalog, ['ls-tree', '-r', '-z', commit, '--', prefix]).toString('utf8').split('\0').filter(Boolean);
  return lines.map(line => {
    const [meta, path] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)];
    const [mode, type] = meta.split(' ');
    if (type !== 'blob' || mode === '120000') fail(`Not a regular file in the catalog: ${path}`);
    return path;
  });
}

const read = (catalog, commit, path) => git(catalog, ['show', `${commit}:${path}`]);

function fetchPlugin(args, plugin) {
  const base = `plugins/${plugin}`;
  const runtimePrefix = `${base}/runtime/`;
  const files = new Map(); // output path relative to the plugin -> bytes
  const provenancePath = `${runtimePrefix}provenance.json`;
  let provenance;
  try { provenance = JSON.parse(read(args.catalog, args.commit, provenancePath)); }
  catch (error) { fail(`${plugin}: cannot read runtime/provenance.json (${error.message.split('\n')[0]})`); }
  if (!provenance || typeof provenance.files !== 'object' || provenance.files === null ||
      !/^[0-9a-f]{64}$/.test(provenance.configSha256 ?? ''))
    fail(`${plugin}: runtime/provenance.json must contain files and configSha256`);

  const actual = listFiles(args.catalog, args.commit, runtimePrefix)
    .map(path => path.slice(runtimePrefix.length)).filter(name => name !== 'provenance.json');
  for (const name of actual)
    if (!Object.hasOwn(provenance.files, name)) fail(`${plugin}: runtime contains an unlisted file: ${name}`);
  for (const name of Object.keys(provenance.files))
    if (!actual.includes(name)) fail(`${plugin}: runtime provenance lists a missing file: ${name}`);
  for (const name of actual) {
    const bytes = read(args.catalog, args.commit, `${runtimePrefix}${name}`);
    if (sha256(bytes) !== provenance.files[name]) fail(`${plugin}: runtime file digest mismatch: ${name}`);
    files.set(`runtime/${name}`, bytes);
  }
  files.set('runtime/provenance.json', read(args.catalog, args.commit, provenancePath));

  const config = read(args.catalog, args.commit, `${base}/runtime-config.json`);
  if (sha256(config) !== provenance.configSha256) fail(`${plugin}: runtime-config.json digest mismatch`);
  files.set('runtime-config.json', config);
  files.set('scripts/run.mjs', read(args.catalog, args.commit, `${base}/scripts/run.mjs`));
  return files;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.services, 'utf8'));
  if (manifest.catalogCommit !== undefined && manifest.catalogCommit !== args.commit)
    fail(`--catalog-commit ${args.commit} differs from catalogCommit ${manifest.catalogCommit} in ${args.services}`);
  const plugins = [...new Set(Object.values(manifest.services ?? {}).map(service => service.plugin))].sort();
  if (plugins.length === 0) fail('No services listed');
  // Verify everything first so a failure leaves no partial output.
  const bundles = plugins.map(plugin => [plugin, fetchPlugin(args, plugin)]);
  for (const [plugin, files] of bundles) {
    const target = join(args.out, plugin);
    rmSync(target, { recursive: true, force: true });
    for (const [name, bytes] of files) {
      const path = join(target, ...name.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  }
  process.stdout.write(`Fetched ${plugins.length} verified runtimes from ${args.commit} into ${args.out}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`fetch-runtimes: ${error.message}\n`);
  process.exitCode = 1;
}
