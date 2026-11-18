// deploy/install-host-files.sh with a stub `docker` (and `gh`) on PATH and a temporary root: the
// repository -> host map, the record check, the Node binary taken from the pinned auth image and
// the bin/lawoss-selfhost wrapper that runs the CLI with it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REQUIRED_HOST_FILES, validateRecord, verifyHostFiles } from '../lib.mjs';
import { hostFileSources } from '../../deploy/host-files.mjs';
import { repo, sha256 } from './helpers.mjs';

const AUTH = `ghcr.io/omni-legal-products/lawoss-auth@sha256:${'a'.repeat(64)}`;
const HUB = `ghcr.io/omni-legal-products/lawoss-hub@sha256:${'b'.repeat(64)}`;
const scratch = mkdtempSync(join(tmpdir(), 'lawoss-install-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = name => { const dir = join(scratch, `${name}-${counter++}`); mkdirSync(dir, { recursive: true }); return dir; };

/** A release record for the repository as checked out, written by the release workflow's generator. */
function generate(src = repo, extra = []) {
  const result = spawnSync(process.execPath, [join(repo, 'deploy', 'release-record.mjs'), '--src', src, '--version', '0.1.0',
    '--commit', 'c'.repeat(40), '--auth', AUTH, '--hub', HUB, '--note', 'Test release.', ...extra], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const path = join(fresh('record'), 'release-0.1.0.json');
  writeFileSync(path, result.stdout);
  return { path, sha: sha256(readFileSync(path)), record: JSON.parse(result.stdout) };
}

/**
 * Stubs: `docker create` prints an id, `docker cp` writes a small "node" that runs this test's
 * Node, `docker rm` succeeds; `gh` succeeds unless GH_FAIL is set. Every call is logged.
 */
function stubs() {
  const dir = fresh('stubs');
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh
echo "docker $*" >> "${log}"
case "$1" in
  create) echo 0123456789ab ;;
  cp) printf '#!/bin/sh\\nexec "%s" "$@"\\n' "${process.execPath}" > "$3" ;;
  rm) ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "gh $*" >> "${log}"\n[ -z "\${GH_FAIL:-}" ]\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  chmodSync(join(dir, 'gh'), 0o755);
  return { dir, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

function install({ record, sha, src = repo, env = {} }) {
  const root = fresh('root');
  const stub = stubs();
  const result = spawnSync('sh', [join(repo, 'deploy', 'install-host-files.sh'), record, sha, src], {
    encoding: 'utf8',
    env: { PATH: `${stub.dir}:/usr/bin:/bin:/usr/sbin:/sbin`, LAWOSS_ROOT: root, ...env },
  });
  return { root, result, calls: stub.calls() };
}

describe('repository -> host map', () => {
  it('maps every shipped file to a host path the record schema accepts, including the required ones', () => {
    const sources = hostFileSources(repo);
    for (const path of REQUIRED_HOST_FILES) assert.ok(Object.hasOwn(sources, path), path);
    assert.ok(Object.hasOwn(sources, 'bin/lawoss-selfhost'), 'the wrapper');
    assert.equal(sources['compose.yaml'], 'deploy/compose.yaml');
    assert.equal(sources['services.json'], 'hub/services.json');
    assert.equal(sources['bin/commands/update.mjs'], 'cli/commands/update.mjs');
    // Every CLI module is shipped, and nothing from the tests.
    const modules = readdirSync(join(repo, 'cli', 'commands')).map(name => `bin/commands/${name}`);
    for (const path of modules) assert.ok(Object.hasOwn(sources, path), path);
    assert.ok(Object.values(sources).every(source => !source.startsWith('cli/test/')));
    const { record } = generate();
    assert.deepEqual(validateRecord(record, '0.1.0'), record);
    assert.deepEqual(Object.keys(record.files).sort(), Object.keys(sources).sort());
    for (const [path, source] of Object.entries(sources)) assert.equal(record.files[path], sha256(readFileSync(join(repo, source))), path);
    assert.equal(record.images.proxy, /^LAWOSS_PROXY_IMAGE=(.*)$/m.exec(readFileSync(join(repo, 'deploy', '.env.example'), 'utf8'))[1]);
  });
});

describe('install-host-files.sh', () => {
  it('installs the host files and the auth image\'s Node, and the wrapper runs the CLI with it', () => {
    const { path, sha, record } = generate();
    const { root, result, calls } = install({ record: path, sha });
    assert.equal(result.status, 0, result.stderr);
    verifyHostFiles(root, record);
    assert.equal(statSync(join(root, 'bin', 'lawoss-selfhost')).mode & 0o777, 0o755);
    assert.equal(statSync(join(root, 'compose.yaml')).mode & 0o777, 0o644);
    assert.equal(statSync(join(root, 'node', 'bin', 'node')).mode & 0o777, 0o755);
    assert.deepEqual(calls, [
      `gh attestation verify oci://${AUTH} --repo Omni-Legal-Products/lawoss-selfhost`,
      `docker create ${AUTH}`,
      `docker cp 0123456789ab:/usr/local/bin/node ${join(root, 'node', 'bin', '.node.new')}`,
      'docker rm 0123456789ab',
    ]);
    // The wrapper finds its Node and the CLI next to itself; as a non-root user the CLI refuses.
    const wrapper = spawnSync(join(root, 'bin', 'lawoss-selfhost'), ['doctor'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(wrapper.status, 1, wrapper.stderr);
    assert.match(wrapper.stderr, /run with sudo/);
  });

  it('removes CLI modules the release does not ship and replaces changed ones', () => {
    const { path, sha, record } = generate();
    const first = install({ record: path, sha });
    assert.equal(first.result.status, 0, first.result.stderr);
    writeFileSync(join(first.root, 'bin', 'commands', 'stale.mjs'), '// from an older release\n');
    writeFileSync(join(first.root, 'compose.yaml'), '# edited\n');
    const again = spawnSync('sh', [join(repo, 'deploy', 'install-host-files.sh'), path, sha, repo], {
      encoding: 'utf8', env: { PATH: `${stubs().dir}:/usr/bin:/bin:/usr/sbin:/sbin`, LAWOSS_ROOT: first.root },
    });
    assert.equal(again.status, 0, again.stderr);
    verifyHostFiles(first.root, record);
  });

  it('refuses a record that does not hash to the pinned value, and installs nothing', () => {
    const { path } = generate();
    const { root, result, calls } = install({ record: path, sha: 'f'.repeat(64) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the pinned value/);
    assert.deepEqual(readdirSync(root), []);
    assert.deepEqual(calls, []);
  });

  it('refuses a source tree whose files differ from the record before installing anything', () => {
    const { path, sha } = generate();
    const src = fresh('src');
    for (const dir of ['cli', 'deploy', 'hub']) cpSync(join(repo, dir), join(src, dir), {
      recursive: true, filter: from => !from.includes('node_modules') && !from.includes(`${join('cli', 'test')}`),
    });
    writeFileSync(join(src, 'deploy', 'compose.yaml'), '# not the release\n');
    const { root, result } = install({ record: path, sha, src });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compose\.yaml/);
    assert.equal(existsSync(join(root, 'compose.yaml')), false);
    assert.equal(existsSync(join(root, 'bin')), false);
  });

  it('refuses when the attestation of the auth image does not verify', () => {
    const { path, sha } = generate();
    const { root, result, calls } = install({ record: path, sha, env: { GH_FAIL: '1' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /attestation/);
    assert.ok(!calls.some(line => line.startsWith('docker')));
    assert.deepEqual(readdirSync(root), []);
  });

  it('usage errors exit 2', () => {
    const result = spawnSync('sh', [join(repo, 'deploy', 'install-host-files.sh'), 'only-one'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    const bad = spawnSync('sh', [join(repo, 'deploy', 'install-host-files.sh'), 'x', 'not-hex', repo], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });
});
