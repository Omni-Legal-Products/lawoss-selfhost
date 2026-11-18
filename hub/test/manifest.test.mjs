import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../dist/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const servicesPath = join(here, '..', 'services.json');
const fetchScript = join(here, '..', 'scripts', 'fetch-runtimes.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'lawoss-hub-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = text => createHash('sha256').update(text).digest('hex');

// Version 1 lists, copied from the Global Constraints on purpose (not derived from services.json).
const VERSION_1_SERVICES = ['crz', 'disq', 'eurlex', 'fs', 'judikaty', 'kalkulacky', 'orsr', 'ov', 'rpo', 'rpvs', 'ru', 'ruz', 'slovlex', 'uvo'];
const DENIED_TOOLS = ['manage_watchlist', 'export_decision_markdown', 'export_decision_markdown_by_reference',
  'download_decision_document', 'save_law_markdown', 'save_explanatory_report_markdown', 'read_saved_markdown',
  'crz_download_attachment', 'ruz_download_attachment', 'eurlex_document_export'];
const ALLOW_WITHOUT = {
  get_decision_full_text: ['savePath', 'saveToDefaultPath'],
  get_decision_full_text_by_reference: ['savePath', 'saveToDefaultPath'],
  crz_contract_to_markdown: ['save_to_dir'],
};

const COMMIT = 'a'.repeat(40);
function writeServices(name, services, text) {
  const path = join(scratch, name);
  writeFileSync(path, text ?? JSON.stringify({ catalogCommit: COMMIT, services }));
  return path;
}
const minimal = { plugin: 'p', tools: { t: 'allow' }, env: [] };

function allTools(manifest) {
  const found = new Map();
  for (const [id, service] of Object.entries(manifest.services))
    for (const [tool, policy] of Object.entries(service.tools)) found.set(`${id}/${tool}`, { tool, policy });
  return found;
}

describe('service manifest', () => {
  it('service ids equal the Global Constraints version 1 list', () => {
    const manifest = loadManifest(servicesPath);
    assert.deepEqual(Object.keys(manifest.services).sort(), VERSION_1_SERVICES);
  });

  it('rejects a service id that is not a DNS label', () => {
    for (const id of ['Bad', 'a_b', '-a', 'a-', 'a.b', '', 'x'.repeat(64)])
      assert.throws(() => loadManifest(writeServices('bad-id.json', { [id]: minimal })), /service id/i, id);
    assert.doesNotThrow(() => loadManifest(writeServices('ok-id.json', { 'a-1': minimal })));
  });

  it('rejects duplicate tool policy keys', () => {
    const text = `{"catalogCommit":"${COMMIT}","services":{"a":{"plugin":"p","tools":{"t":"allow","t":"deny-remote"},"env":[]}}}`;
    assert.throws(() => loadManifest(writeServices('dup.json', null, text)), /duplicate key "t"/);
  });

  it('rejects malformed policies, environment names and commits', () => {
    const bad = [
      { ...minimal, tools: { t: 'maybe' } },
      { ...minimal, tools: { t: { 'allow-without': [] } } },
      { ...minimal, tools: { t: { 'allow-without': ['a'], extra: 1 } } },
      { ...minimal, tools: {} },
      { ...minimal, env: ['lower'] },
      { ...minimal, plugin: '../x' },
    ];
    for (const service of bad) assert.throws(() => loadManifest(writeServices('bad.json', { a: service })));
    assert.throws(() => loadManifest(writeServices('commit.json', null,
      JSON.stringify({ catalogCommit: 'abc', services: { a: minimal } }))), /catalogCommit/);
  });

  it('every Global Constraints denied tool is deny-remote', () => {
    const tools = allTools(loadManifest(servicesPath));
    const denied = [...tools.values()].filter(entry => entry.policy === 'deny-remote').map(entry => entry.tool).sort();
    assert.deepEqual(denied, [...DENIED_TOOLS].sort());
  });

  it('allow-without entries equal the Global Constraints list', () => {
    const tools = allTools(loadManifest(servicesPath));
    const actual = {};
    for (const { tool, policy } of tools.values())
      if (typeof policy === 'object') actual[tool] = policy['allow-without'];
    assert.deepEqual(actual, ALLOW_WITHOUT);
  });

  it('lists 109 tools in total', () => {
    assert.equal(allTools(loadManifest(servicesPath)).size, 109);
  });

  const runtimes = process.env.LAWOSS_RUNTIMES_DIR;
  it('every tool reported by each runtime has a policy entry', {
    skip: runtimes ? false : 'set LAWOSS_RUNTIMES_DIR to a fetch-runtimes output directory to run this integration test',
  }, () => {
    const manifest = loadManifest(servicesPath);
    const cache = process.env.LAWOSS_CACHE_DIR || join(scratch, 'cache');
    for (const [id, service] of Object.entries(manifest.services)) {
      const launcher = join(runtimes, service.plugin, 'scripts', 'run.mjs');
      const state = join(scratch, 'state');
      const result = spawnSync(process.execPath, [launcher, 'tools'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
        env: { ...process.env, LAWOSS_CACHE_DIR: cache, LAWOSS_STATE_DIR: state },
      });
      assert.equal(result.status, 0, `${id}: launcher failed: ${result.stderr}`);
      const reported = JSON.parse(result.stdout).tools.map(tool => tool.name).sort();
      assert.deepEqual(reported, Object.keys(service.tools).sort(), `${id}: runtime tools differ from the manifest`);
    }
  });
});

describe('fetch-runtimes', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

  // Builds a one-plugin catalog in a throwaway git repo; `mutate` may change files before they are committed.
  function fixture(label, mutate = () => {}) {
    const repo = join(scratch, `catalog-${label}`);
    const plugin = join(repo, 'plugins', 'demo');
    mkdirSync(join(plugin, 'runtime', 'dist'), { recursive: true });
    mkdirSync(join(plugin, 'scripts'), { recursive: true });
    const config = '{"name":"demo","entrypoint":"dist/index.js","minimumNode":"22.14.0"}\n';
    const index = 'console.log("demo");\n';
    writeFileSync(join(plugin, 'runtime-config.json'), config);
    writeFileSync(join(plugin, 'scripts', 'run.mjs'), '// launcher\n');
    writeFileSync(join(plugin, 'runtime', 'dist', 'index.js'), index);
    writeFileSync(join(plugin, 'runtime', 'package.json'), '{}\n');
    writeFileSync(join(plugin, 'runtime', 'provenance.json'), JSON.stringify({
      configSha256: sha256(config),
      files: { 'dist/index.js': sha256(index), 'package.json': sha256('{}\n') },
    }));
    mutate(plugin);
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const services = join(scratch, `services-${label}.json`);
    writeFileSync(services, JSON.stringify({ catalogCommit: sha, services: { demo: { plugin: 'demo' } } }));
    return { repo, sha, services, out: join(scratch, `out-${label}`) };
  }
  const run = ({ repo, sha, services, out }) => spawnSync(process.execPath,
    [fetchScript, '--catalog', repo, '--catalog-commit', sha, '--out', out, '--services', services], { encoding: 'utf8' });

  it('fetch copies a verified runtime bundle', () => {
    const f = fixture('good');
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.out, 'demo', 'runtime', 'dist', 'index.js'), 'utf8'), 'console.log("demo");\n');
    assert.ok(existsSync(join(f.out, 'demo', 'runtime-config.json')));
    assert.ok(existsSync(join(f.out, 'demo', 'scripts', 'run.mjs')));
  });

  it('fetch fails when a runtime file digest differs', () => {
    const f = fixture('digest', plugin => writeFileSync(join(plugin, 'runtime', 'dist', 'index.js'), 'tampered\n'));
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dist\/index\.js/);
    assert.equal(existsSync(join(f.out, 'demo')), false, 'no partial output is left behind');
  });

  it('fetch fails when the runtime config digest differs', () => {
    const f = fixture('config', plugin => writeFileSync(join(plugin, 'runtime-config.json'), '{"name":"demo2"}\n'));
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime-config\.json/);
  });

  it('fetch fails on an extra or a missing runtime file', () => {
    const extra = run(fixture('extra', plugin => writeFileSync(join(plugin, 'runtime', 'dist', 'extra.js'), 'x\n')));
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /dist\/extra\.js/);
    const missing = run(fixture('missing', plugin => rmSync(join(plugin, 'runtime', 'package.json'))));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /package\.json/);
  });

  it('fetch fails when the commit differs from services.json', () => {
    const f = fixture('commit');
    writeFileSync(f.services, JSON.stringify({ catalogCommit: 'b'.repeat(40), services: { demo: { plugin: 'demo' } } }));
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /catalogCommit/);
  });
});
