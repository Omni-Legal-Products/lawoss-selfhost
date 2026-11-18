// The release workflow publishes images, so it must run only when a maintainer starts it, with
// pinned actions and the least permissions; ci.yml must never publish.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repo } from './helpers.mjs';

const workflow = name => readFileSync(join(repo, '.github', 'workflows', name), 'utf8');

describe('release workflow', () => {
  const text = workflow('release.yml');

  it('runs only on workflow_dispatch with a version and the catalog commit as inputs', () => {
    const on = /^on:\n((?: {2}.*\n)+)/m.exec(text)?.[1] ?? '';
    assert.match(on, /^ {2}workflow_dispatch:$/m);
    assert.deepEqual(on.split('\n').filter(line => /^ {2}\S/.test(line)), ['  workflow_dispatch:']);
    assert.match(on, /^ {6}version:$/m);
    assert.match(on, /^ {6}catalog_commit:$/m);
    assert.match(text, /catalogCommit.*\n?.*CATALOG_COMMIT|CATALOG_COMMIT[\s\S]*catalogCommit/);
  });

  it('pins every action by commit SHA', () => {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map(match => match[1]);
    assert.ok(uses.length >= 4);
    for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
    assert.ok(uses.some(ref => ref.startsWith('actions/attest-build-provenance@')));
    assert.ok(uses.some(ref => ref.startsWith('actions/upload-artifact@')));
  });

  it('grants nothing at the top and only packages, id-token and attestations write in its one job', () => {
    assert.match(text, /^permissions: \{\}$/m);
    const granted = [...text.matchAll(/^ {6}([a-z-]+): write$/gm)].map(match => match[1]).sort();
    assert.deepEqual(granted, ['attestations', 'id-token', 'packages']);
    assert.equal([...text.matchAll(/^ {2}[a-z][\w-]*:$/gm)].filter(m => text.indexOf('jobs:') < m.index).length, 1, 'one job');
  });

  it('pushes both images to GHCR, attests them and uploads the release record', () => {
    for (const name of ['auth', 'hub']) assert.ok(text.includes(`ghcr.io/omni-legal-products/lawoss-${name}`), name);
    assert.equal((text.match(/actions\/attest-build-provenance@/g) ?? []).length, 2);
    assert.match(text, /node deploy\/release-record\.mjs/);
    assert.match(text, /releases\/\$\{\{ inputs\.version \}\}\.json|releases\/\$VERSION\.json/);
    // Inputs reach shell steps through env only, never by template expansion inside run.
    for (const block of text.split(/\n\s+- /).filter(step => /\brun: /.test(step)))
      assert.doesNotMatch(block.slice(block.indexOf('run:')), /\$\{\{\s*inputs\./, 'inputs expanded inside a run script');
  });
});

describe('ci workflow', () => {
  it('never logs in, pushes or attests', () => {
    const text = workflow('ci.yml');
    assert.doesNotMatch(text, /docker (login|push)|attest-build-provenance|packages: write/);
  });
});
