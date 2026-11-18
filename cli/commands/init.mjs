// init: generates every secret on the server, writes /opt/lawoss/.env (0600, root) and the
// Caddyfile, and prints only the host names to create in DNS. Images come from the release record
// pinned in the catalog, the same trust root that update uses; the release's host files must be
// installed and an optional brand pack must pass auth's check before anything is written.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ACME_EMAIL, DNS_NAME, Failure, SERVICE_NAMES, UsageError, formatEnvValue, loadManifest, options, parseServiceList, paths,
  providerKeys, randomKey, readRecord, renderCaddyfile, resourceUrl, sha256, verifyAttestations, verifyHostFiles, writePrivateFile,
} from '../lib.mjs';
import { checkPack, checkPackArg, ensureBrandDir, installStaged, resolvePack } from './brand.mjs';
import { keepRelease } from '../host.mjs';


/** A signing key as auth's oidc-provider takes it: an RSA private JWK with kid, alg and use. */
export function signingKey() {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  return { ...jwk, kid: randomUUID(), alg: 'RS256', use: 'sig' };
}

/**
 * AUTH_CONFIG_JSON and HUB_CONFIG_JSON for one deployment (auth/src/server.ts Config, hub/src/main.ts
 * HubConfig). `brand` is auth's pack path; undefined means auth's default LAWOSS pack.
 */
export function generateConfig({ base, services, brand }) {
  const issuer = `https://auth.${base}`;
  const secrets = Object.fromEntries(services.map(id => [id, randomKey(32)]));
  const auth = {
    origin: issuer,
    dataDir: '/data',
    cookieKeys: [randomKey(32), randomKey(32)],
    jwks: { keys: [signingKey()] },
    resources: Object.fromEntries(services.map(id => [resourceUrl(id, base), {
      name: SERVICE_NAMES[id] ?? id,
      scope: 'mcp:tools',
      secretHash: sha256(secrets[id]),
    }])),
    ...(brand !== undefined ? { brand } : {}),
  };
  const hub = { base, issuer, services, secrets };
  return { auth, hub };
}

export async function init(args, ctx) {
  const { values } = options(args, {
    base: { type: 'string' },
    services: { type: 'string' },
    brand: { type: 'string' },
    record: { type: 'string' },
    'record-sha256': { type: 'string' },
    'acme-email': { type: 'string' },
  });
  const base = values.base ?? '';
  if (!DNS_NAME.test(base)) throw new UsageError('--base must be a lowercase DNS name');
  const acmeEmail = values['acme-email'] ?? '';
  if (!ACME_EMAIL.test(acmeEmail)) throw new UsageError('--acme-email must be the certificate contact e-mail (name@lowercase.domain)');
  if (values.brand !== undefined) checkPackArg(values.brand);
  if (!values.record || !values['record-sha256']) throw new UsageError('--record and --record-sha256 are required');
  const p = paths(ctx.root);
  if (existsSync(p.env)) throw new Failure(`${p.env} already exists; init never overwrites it`);
  const record = readRecord(values.record, values['record-sha256']);
  // compose.yaml, Caddyfile.template, services.json and the CLI must be this release's.
  verifyHostFiles(ctx.root, record);
  const manifest = loadManifest(ctx.root);
  const services = parseServiceList(values.services, Object.keys(manifest.services ?? {}));
  await verifyAttestations(ctx, record.images);

  // Everything is rendered and validated before the first write.
  const authHost = `auth.${base}`;
  const serviceHosts = services.map(id => `${id}.${base}`);
  const caddyfile = renderCaddyfile(readFileSync(p.template, 'utf8'), { base, services, acmeEmail });
  const pack = values.brand === undefined ? undefined : resolvePack(ctx, values.brand);
  try {
    if (pack && !await checkPack(ctx, record.images.auth, pack))
      throw new Failure(`brand pack ${pack.label} did not pass auth's check; nothing was written`);
    const { auth, hub } = generateConfig({ base, services, brand: pack?.config });
    const lines = [
      '# Written by lawoss-selfhost init. Mode 0600, owned by root. Never print, paste or copy this file.',
      `LAWOSS_BASE=${base}`,
      `LAWOSS_SERVICES=${services.join(',')}`,
      `LAWOSS_RELEASE=${formatEnvValue(record.version)}`,
      // The certificate contact; not a secret, kept so that every later Caddyfile render has it.
      `LAWOSS_ACME_EMAIL=${formatEnvValue(acmeEmail)}`,
      `LAWOSS_AUTH_IMAGE=${record.images.auth}`,
      `LAWOSS_HUB_IMAGE=${record.images.hub}`,
      `LAWOSS_PROXY_IMAGE=${record.images.proxy}`,
      `AUTH_PUBLIC_HOST=${authHost}`,
      `AUTH_CONFIG_JSON=${formatEnvValue(JSON.stringify(auth))}`,
      `HUB_CONFIG_JSON=${formatEnvValue(JSON.stringify(hub))}`,
      // Optional provider keys (set with set-key); empty means unset.
      ...providerKeys(manifest).map(key => `${key}=`),
      '',
    ];

    // compose.yaml mounts <root>/brand read-only and does not create it, so it always exists.
    ensureBrandDir(ctx);
    if (pack?.staging) installStaged(ctx, pack.staging, pack.slug);
    writePrivateFile(ctx, p.env, lines.join('\n'), { exclusive: true });
    writeFileSync(p.caddyfile, caddyfile);
    chmodSync(p.caddyfile, 0o644);
    ctx.chown(p.caddyfile, 0, 0);
    // The record and a copy of the host files, so that a later update can come back to them.
    keepRelease(ctx, record);
  } finally {
    pack?.release();
  }

  for (const host of [authHost, ...serviceHosts]) ctx.out(host);
  return 0;
}
