// doctor: checks, in order, DNS for every host, TLS certificates, the issuer metadata, each
// resource's metadata and 401 challenge, and an in-container stdio tools/list per service compared
// with the installed manifest. It prints `PASS <check>` or `FAIL <check>` lines only (a tools
// failure also names the drifted tools); probe errors and container output are never printed.
import { promises as dns } from 'node:dns';
import { connect } from 'node:tls';
import { compose, deployment, loadManifest, options } from '../lib.mjs';

const TIMEOUT_MS = 10_000;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** The real probes; tests inject fakes with the same shape. */
export function realProbes() {
  return {
    async resolve(host) {
      const settled = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
      return settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    },
    tls(host) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
          const cert = socket.getPeerCertificate();
          const result = { authorized: socket.authorized, validTo: cert?.valid_to ? new Date(cert.valid_to) : undefined };
          socket.end();
          resolve(result);
        });
        socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
        socket.on('error', reject);
      });
    },
    fetch(url, init = {}) {
      return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    },
  };
}

async function readJson(response) {
  try { return await response.json(); } catch { return undefined; }
}

/** One check: true when `test` resolves truthy; any error is a failure whose message is dropped. */
async function check(test) {
  try { return Boolean(await test()); } catch { return false; }
}

/** Compares a runtime's tools with the manifest; returns undefined when they match, else a reason. */
export function toolDrift(reported, listed) {
  const extra = reported.filter(name => !listed.includes(name)).sort();
  const missing = listed.filter(name => !reported.includes(name)).sort();
  if (!extra.length && !missing.length) return undefined;
  const parts = [];
  if (extra.length) parts.push(`not in services.json: ${extra.join(', ')}`);
  if (missing.length) parts.push(`missing from the runtime: ${missing.join(', ')}`);
  return parts.join('; ');
}

/** Runs every check, prints one line per check and returns whether all passed. */
export async function runDoctor(ctx) {
  const { base, services, issuer } = deployment(ctx.root);
  const manifest = loadManifest(ctx.root);
  const probes = ctx.probes;
  const hosts = [`auth.${base}`, ...services.map(id => `${id}.${base}`)];
  let ok = true;
  const report = (passed, name, reason) => {
    ok &&= passed;
    ctx.out(`${passed ? 'PASS' : 'FAIL'} ${name}${!passed && reason ? `: ${reason}` : ''}`);
  };

  for (const host of hosts) report(await check(async () => (await probes.resolve(host)).length > 0), `dns ${host}`);
  for (const host of hosts)
    report(await check(async () => {
      const cert = await probes.tls(host);
      return cert.authorized === true && cert.validTo instanceof Date && cert.validTo.getTime() > ctx.now().getTime();
    }), `tls ${host}`);
  report(await check(async () => {
    const response = await probes.fetch(`${issuer}/.well-known/oauth-authorization-server`);
    return response.status === 200 && (await readJson(response))?.issuer === issuer;
  }), `issuer metadata auth.${base}`);
  for (const id of services) {
    const host = `${id}.${base}`;
    const metadataUrl = `https://${host}/.well-known/oauth-protected-resource/mcp`;
    report(await check(async () => {
      const response = await probes.fetch(metadataUrl);
      const body = response.status === 200 ? await readJson(response) : undefined;
      return body?.resource === `https://${host}/mcp` && Array.isArray(body.authorization_servers) && body.authorization_servers.includes(issuer);
    }), `resource metadata ${host}`);
    report(await check(async () => {
      const response = await probes.fetch(`https://${host}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      return response.status === 401 && (response.headers.get('www-authenticate') ?? '').includes(`resource_metadata="${metadataUrl}"`);
    }), `401 challenge ${host}`);
  }
  for (const id of services) {
    const listed = Object.keys(manifest.services?.[id]?.tools ?? {});
    let reason;
    const passed = await check(async () => {
      const result = await ctx.run([...compose(ctx.root), 'run', '--rm', '--no-deps', 'hub', 'node', 'dist/main.js', '--list-tools', id]);
      if (result.code !== 0) { reason = `runtime did not start (exit ${result.code})`; return false; }
      let answer;
      try { answer = JSON.parse(result.stdout); } catch { reason = 'unreadable tool list'; return false; }
      const tools = answer?.service === id && Array.isArray(answer.tools) ? answer.tools : undefined;
      if (!tools || !tools.every(name => typeof name === 'string' && TOOL_NAME.test(name))) { reason = 'unreadable tool list'; return false; }
      reason = toolDrift(tools, listed);
      return reason === undefined;
    });
    report(passed, `tools ${id}`, reason);
  }
  return ok;
}

export async function doctor(args, ctx) {
  options(args, {});
  return (await runDoctor(ctx)) ? 0 : 1;
}
