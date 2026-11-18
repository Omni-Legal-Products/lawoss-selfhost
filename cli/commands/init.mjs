// init: generates every secret on the server, writes /opt/lawoss/.env (0600, root) and the
// Caddyfile, and prints only the host names to create in DNS. Images come from the release record
// pinned in the catalog, the same trust root that update uses.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  DNS_NAME, Failure, SERVICE_NAMES, UsageError, formatEnvValue, loadManifest, options, parseServiceList, paths,
  randomKey, readRecord, resourceUrl, sha256, writePrivateFile,
} from '../lib.mjs';

// Optional provider keys passed to the hub (compose.yaml); empty means unset.
const PROVIDER_KEYS = [
  'CRZ_MISTRAL_OCR', 'MISTRAL_API_KEY', 'MISTRAL_OCR_MODEL', 'EURLEX_WS_DAILY_LIMIT', 'EURLEX_WS_USERNAME',
  'EURLEX_WS_PASSWORD', 'FS_API_KEY', 'USTAVNY_CLIENT_ID', 'USTAVNY_CLIENT_SECRET',
];
const BRAND = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A signing key as auth's oidc-provider takes it: an RSA private JWK with kid, alg and use. */
function signingKey() {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  return { ...jwk, kid: randomUUID(), alg: 'RS256', use: 'sig' };
}

/** AUTH_CONFIG_JSON and HUB_CONFIG_JSON for one deployment (auth/src/server.ts Config, hub/src/main.ts HubConfig). */
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
    ...(brand && brand !== 'default' ? { brand: `brand/${brand}` } : {}),
  };
  const hub = { base, issuer, services, secrets };
  return { auth, hub };
}

/** The Caddyfile: the auth site and one copy of the SERVICES section per enabled service. */
export function renderCaddyfile(template, authHost, serviceHosts) {
  const section = /^# \{\{#SERVICES\}\}\n([\s\S]*?)^# \{\{\/SERVICES\}\}\n/m;
  const match = section.exec(template);
  if (!match) throw new Failure('Caddyfile.template has no SERVICES section');
  const blocks = serviceHosts.map(host => match[1].replaceAll('{{SERVICE_HOST}}', host)).join('');
  return (template.slice(0, match.index) + blocks + template.slice(match.index + match[0].length)).replaceAll('{{AUTH_HOST}}', authHost);
}

export async function init(args, ctx) {
  const { values } = options(args, {
    base: { type: 'string' },
    services: { type: 'string' },
    brand: { type: 'string' },
    record: { type: 'string' },
    'record-sha256': { type: 'string' },
  });
  const base = values.base ?? '';
  if (!DNS_NAME.test(base)) throw new UsageError('--base must be a lowercase DNS name');
  if (values.brand !== undefined && !BRAND.test(values.brand)) throw new UsageError('--brand must be the name of a pack in the auth image');
  if (!values.record || !values['record-sha256']) throw new UsageError('--record and --record-sha256 are required');
  const p = paths(ctx.root);
  const manifest = loadManifest(ctx.root);
  const services = parseServiceList(values.services, Object.keys(manifest.services ?? {}));
  if (existsSync(p.env)) throw new Failure(`${p.env} already exists; init never overwrites it`);
  if (!existsSync(p.compose) || !existsSync(p.template)) throw new Failure('compose.yaml or Caddyfile.template is missing; install the release files first');
  const record = readRecord(values.record, values['record-sha256']);

  const { auth, hub } = generateConfig({ base, services, brand: values.brand });
  const authHost = `auth.${base}`;
  const serviceHosts = services.map(id => `${id}.${base}`);
  const lines = [
    '# Written by lawoss-selfhost init. Mode 0600, owned by root. Never print, paste or copy this file.',
    `LAWOSS_BASE=${base}`,
    `LAWOSS_SERVICES=${services.join(',')}`,
    `LAWOSS_RELEASE=${formatEnvValue(record.version)}`,
    `LAWOSS_AUTH_IMAGE=${record.images.auth}`,
    `LAWOSS_HUB_IMAGE=${record.images.hub}`,
    `LAWOSS_PROXY_IMAGE=${record.images.proxy}`,
    `AUTH_PUBLIC_HOST=${authHost}`,
    `AUTH_CONFIG_JSON=${formatEnvValue(JSON.stringify(auth))}`,
    `HUB_CONFIG_JSON=${formatEnvValue(JSON.stringify(hub))}`,
    ...PROVIDER_KEYS.map(key => `${key}=`),
    '',
  ];
  writePrivateFile(ctx, p.env, lines.join('\n'), { exclusive: true });

  writeFileSync(p.caddyfile, renderCaddyfile(readFileSync(p.template, 'utf8'), authHost, serviceHosts));
  chmodSync(p.caddyfile, 0o644);
  ctx.chown(p.caddyfile, 0, 0);

  for (const host of [authHost, ...serviceHosts]) ctx.out(host);
  return 0;
}
