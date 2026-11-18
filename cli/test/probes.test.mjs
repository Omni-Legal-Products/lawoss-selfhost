// The real doctor probes connect to 127.0.0.1 with the public host name as SNI and Host header, so
// they need no hairpin NAT. Checked against a local HTTPS server with a throwaway certificate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { realProbes } from '../commands/doctor.mjs';

let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }

describe('real doctor probes', { skip: openssl ? false : 'openssl is not installed' }, () => {
  let server;
  let port;
  let ca;
  const dir = mkdtempSync(join(tmpdir(), 'lawoss-probes-'));
  before(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=crz.example.test',
      '-addext', 'subjectAltName=DNS:crz.example.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'cert.pem'));
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, (req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'www-authenticate': 'Bearer x' });
      res.end(JSON.stringify({ host: req.headers.host, method: req.method, path: req.url, servername: req.socket.servername }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('tls connects to the local address with the host as SNI and checks the certificate against it', async () => {
    const probes = realProbes({ address: '127.0.0.1', port, ca });
    const cert = await probes.tls('crz.example.test');
    assert.equal(cert.authorized, true);
    assert.ok(cert.validTo instanceof Date && cert.validTo > new Date());
    await assert.rejects(probes.tls('orsr.example.test'), 'a certificate for another name does not pass');
  });

  it('fetch sends the public URL to the local address with SNI and Host, without following redirects', async () => {
    const probes = realProbes({ address: '127.0.0.1', port, ca });
    const response = await probes.fetch('https://crz.example.test/.well-known/oauth-protected-resource/mcp?x=1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer x');
    assert.deepEqual(await response.json(), {
      host: 'crz.example.test', method: 'POST', path: '/.well-known/oauth-protected-resource/mcp?x=1', servername: 'crz.example.test',
    });
  });

  it('defaults to 127.0.0.1:443', () => {
    const probes = realProbes();
    assert.equal(probes.address, '127.0.0.1');
    assert.equal(probes.port, 443);
  });
});
