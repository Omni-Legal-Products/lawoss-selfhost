// doctor: checks, in order, DNS for every host, TLS certificates, the issuer metadata, each
// resource's metadata and 401 challenge, the hub's authenticated path to auth (introspection with
// each service's secret), that the hub image carries the host's services.json, and an in-container
// stdio tools/list per service compared with the installed manifest. TLS and HTTP probes connect to
// 127.0.0.1:443 with the public host as SNI and Host, so they need no hairpin NAT. It prints
// `PASS <check>` or `FAIL <check>` lines only (a failure may add a fixed reason or drifted tool
// names); probe errors and container output are never printed.
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { compose, deployment, loadManifest, options, paths, sha256 } from '../lib.mjs';

const TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The real probes; tests inject fakes with the same shape. DNS asks the public resolvers; TLS and
 * HTTP go to `address`:`port` (the local proxy) with the host name as SNI and Host header.
 */
export function realProbes({ address = '127.0.0.1', port = 443, ca } = {}) {
  return {
    address,
    port,
    async resolve(host) {
      const settled = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
      return settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    },
    tls(host) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host: address, port, servername: host, ca, timeout: TIMEOUT_MS }, () => {
          const cert = socket.getPeerCertificate();
          const result = { authorized: socket.authorized, validTo: cert?.valid_to ? new Date(cert.valid_to) : undefined };
          socket.end();
          resolve(result);
        });
        socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
        socket.on('error', reject);
      });
    },
    /** A fetch-like request of a public https URL, sent to the local address; redirects are not followed. */
    fetch(url, init = {}) {
      const target = new URL(url);
      return new Promise((resolve, reject) => {
        const req = request({
          host: address, port, servername: target.hostname, ca, method: init.method ?? 'GET',
          path: `${target.pathname}${target.search}`, headers: { ...(init.headers ?? {}), host: target.host }, timeout: TIMEOUT_MS,
        }, res => {
          const chunks = [];
          let size = 0;
          res.on('data', chunk => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
          res.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers))
              for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers, json: async () => JSON.parse(text) });
          });
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(init.body);
      });
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

const INTROSPECTION_REASONS = Object.freeze({
  'secret-mismatch': 'the hub and auth hold different introspection secrets',
  unreachable: 'the hub cannot reach auth at its public origin',
  unexpected: 'auth gave an unexpected answer',
});

/** One hub check mode in a one-off container; `answer` is its parsed JSON line, if any. Output is never printed. */
async function hubRun(ctx, args) {
  try {
    const result = await ctx.run([...compose(ctx.root), 'run', '--rm', '--no-deps', 'hub', 'node', 'dist/main.js', ...args]);
    let answer;
    try { answer = JSON.parse(result.stdout); } catch { answer = undefined; }
    return { code: result.code, answer: answer !== null && typeof answer === 'object' ? answer : undefined };
  } catch {
    return { code: 'error', answer: undefined };
  }
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
  // The authenticated path: hub -> proxy alias -> auth introspection, with each service's secret.
  const introspection = await hubRun(ctx, ['--check-introspection']);
  for (const id of services) {
    let reason;
    if (!introspection.answer) reason = `the check did not run (exit ${introspection.code})`;
    else {
      const result = introspection.answer.introspection?.[id];
      reason = result === 'ok' ? undefined : INTROSPECTION_REASONS[result] ?? 'no answer for this service';
    }
    report(reason === undefined, `introspection ${id}`, reason);
  }
  // The hub enforces the services.json baked into its image; the host copy must be the same file.
  const baked = await hubRun(ctx, ['--manifest-sha256']);
  const hostDigest = sha256(readFileSync(paths(ctx.root).services));
  const bakedDigest = baked.answer?.manifestSha256;
  report(bakedDigest === hostDigest, 'manifest services.json', !baked.answer || typeof bakedDigest !== 'string'
    ? `the check did not run (exit ${baked.code})` : 'the hub image carries a different services.json than the host');
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
