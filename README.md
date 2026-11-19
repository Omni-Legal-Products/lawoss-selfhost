# lawoss-selfhost

Self-hosted LAWOSS MCP servers with a branded login, deployable by an AI agent.

> Status: early. This repository contains the authorization server (`auth/`), the MCP hub
> (`hub/`), the Compose deployment (`deploy/`) and the setup CLI (`cli/`). Release 0.1.0 is
> published: its auth and hub images are public in `ghcr.io/omni-legal-products`, pinned by digest
> in its release record (see [Published releases](#published-releases)). The `lawoss-selfhost`
> skill in the LAWOSS marketplace guides an AI agent through deploying it.

## Contents

- `auth/`: OAuth 2.1 authorization server (Node 24, Express 5, `oidc-provider` 9, SQLite) with
  sign-in, activation, consent and help screens. The default brand pack is LAWOSS
  (`auth/brand/default`); a deployment can select its own pack with the optional `brand` field of its configuration
  (preview a pack with `AUTH_BRAND=brand/<name> node dist/preview.js`).
  Exported from upstream commit `2e17cb822bdef433d9df7d09c3e36ea2e5d89f96`.
- `deploy/compose.yaml`, `deploy/Caddyfile.template`, `deploy/.env.example`: the Compose stack
  (Caddy with automatic certificates per host, auth, hub) and its placeholder configuration.

## Build and test

```sh
cd auth
npm ci --ignore-scripts
npm test
docker build -t lawoss-auth:local .
```

## Hub

`hub/` holds the reviewed service manifest (`hub/services.json`) and the runtime fetcher. The
manifest must list exactly the tools each runtime reports. Cross-check it against a local checkout
of the public catalog at the recorded commit (this starts every runtime once and may run `npm ci`
for non-bundled ones; no tool is called):

```sh
cd hub && npm ci --ignore-scripts && npm test
COMMIT=$(node -p "require('./services.json').catalogCommit")
node scripts/fetch-runtimes.mjs --catalog /path/to/lawoss-marketplace --catalog-commit "$COMMIT" --out /tmp/lawoss-runtimes
LAWOSS_RUNTIMES_DIR=/tmp/lawoss-runtimes node --test test/manifest.test.mjs
```

CI runs the same steps in the `hub` job.

The hub image (`docker build -t lawoss-hub:local -f hub/Dockerfile hub`) fetches the runtimes from
the public catalog at that commit, warms the shared dependency cache once at build time and runs
`node dist/main.js` as `node` with `HUB_CONFIG_JSON`; at every start it verifies the runtimes
against their provenance again. `hub/test/image-smoke.sh` checks a built image offline.

## Deployment files

`deploy/compose.yaml` runs three hardened services (read-only root filesystems, all capabilities
dropped, no new privileges, memory and process limits); only the proxy publishes ports (80 and 443 by default; see
"Behind an existing reverse proxy"). Check it with:

```sh
python3 -m unittest -v deploy/test/compose.test.py
docker compose -f deploy/compose.yaml --env-file deploy/.env.example config -q
```

### Behind an existing reverse proxy

By default the proxy publishes host ports 80 and 443 on all addresses. When another proxy already
owns them, `init` can move the published ports and bind them to one address; Caddy keeps terminating
TLS and issuing its own certificates. Three optional `.env` keys control it, and `init` always
writes them so the file states the choice:

| Key | `init` option | Default | Meaning |
| --- | --- | --- | --- |
| `LAWOSS_HTTP_PORT` | `--http-port N` | `80` | host port published for Caddy's port 80 |
| `LAWOSS_HTTPS_PORT` | `--https-port N` | `443` | host port published for Caddy's 443, TCP and UDP |
| `LAWOSS_PROXY_BIND` | `--proxy-bind ADDR` | empty (all addresses) | one IPv4 or IPv6 address, without brackets, that both ports bind to |

Ports are decimal integers from 1 to 65535 without sign or leading zero, and the two differ. An
`.env` written before these keys existed publishes exactly 80 and 443. `update`, `rollback`,
`rotate` and `services` leave the keys as they are; `doctor` and `restore` refuse an invalid value
and name the key.

```sh
lawoss-selfhost init --base lawoss.example.com --services crz,orsr --acme-email ops@example.com \
  --http-port 8080 --https-port 8443 --proxy-bind 127.0.0.1 --record releases/VERSION.json --record-sha256 HEX
```

The existing proxy must pass TLS through unterminated, selecting by SNI, for the auth host and every
service host of the deployment, and should forward plain HTTP on port 80 for the same hosts so that
Caddy can answer certificate challenges and redirect to HTTPS. TLS-ALPN-01 works through the
passthrough; HTTP-01 additionally needs the port 80 route. Public clients still use port 443: the
issuer and resource URLs carry no port. `doctor` probes `127.0.0.1:443` with each host name as SNI,
which behind a passthrough proxy is the proxy's public entry, the path users take. If the existing
proxy does not listen on the host's loopback 443, `doctor` cannot reach the deployment from there.

A minimal Traefik dynamic configuration (file provider) for the deployment above, whose hosts are
`auth.lawoss.example.com` and `crz.lawoss.example.com`, `orsr.lawoss.example.com`.
`HOST_ADDR` stands for the address under which the proxy's container reaches the host (for example
a Docker bridge gateway); the ports are those given to `init` above, and `--proxy-bind` must be an
address the proxy can reach.

```yaml
tcp:
  routers:
    lawoss-tls:
      entryPoints: [websecure]
      rule: HostSNIRegexp(`^.+\.lawoss\.example\.com$`) || HostSNI(`auth.lawoss.example.com`)
      tls:
        passthrough: true
      service: lawoss-tls
  services:
    lawoss-tls:
      loadBalancer:
        servers:
          - address: HOST_ADDR:8443
http:
  routers:
    lawoss-http:
      entryPoints: [web]
      rule: Host(`auth.lawoss.example.com`) || HostRegexp(`^.+\.lawoss\.example\.com$`)
      service: lawoss-http
  services:
    lawoss-http:
      loadBalancer:
        servers:
          - url: http://HOST_ADDR:8080
```

Replace `lawoss.example.com` with the deployment's base. Check the rule syntax against the Traefik
version in use.

## Setup CLI

`cli/lawoss-selfhost.mjs` (Node standard library only) is installed with `cli/lib.mjs`,
`cli/host.mjs` and `cli/commands/` to `/opt/lawoss/bin`, next to `compose.yaml`, `Caddyfile.template`
and `services.json` in `/opt/lawoss`, all from the release's commit, and run with `sudo` through
`/opt/lawoss/bin/lawoss-selfhost`. It generates every secret on the server into `/opt/lawoss/.env`
(0600, root) and never prints a secret, key, activation link or password: its outputs are host
names, `PASS`/`FAIL` lines and paths of 0600 files. Account, backup, snapshot and restore work runs in
one-off containers; no container gets the Docker socket.

### Installing a release's host files

`deploy/host-files.mjs` is the one map from repository paths to host paths (`deploy/compose.yaml` ->
`compose.yaml`, `hub/services.json` -> `services.json`, `cli/**` -> `bin/**`, ...). From a checkout
of this repository at the release's commit:

```sh
sudo sh deploy/install-host-files.sh releases/VERSION.json RECORD_SHA256 .
```

The script checks the record against its pinned SHA-256, verifies the auth image's build
attestation when `gh` is installed, copies the Node binary out of that digest-pinned image to
`/opt/lawoss/node/bin/node` (the host needs no Node package; `bin/lawoss-selfhost` runs the CLI with
it), checks every source file against the record before writing anything, installs them and checks
again. It downloads nothing but the auth image.

### Commands

```sh
lawoss-selfhost init --base example.com --services crz,orsr --acme-email ops@example.com --record releases/VERSION.json --record-sha256 HEX
                                           # optional: --http-port N --https-port N --proxy-bind ADDR
lawoss-selfhost invite alice crz,orsr      # prints /opt/lawoss/handoff/alice.link
lawoss-selfhost set-key FS_API_KEY         # the value is read from stdin, without echo
lawoss-selfhost doctor
lawoss-selfhost backup init-key            # once; copy the private key off the server
lawoss-selfhost backup
lawoss-selfhost update --to VERSION --record releases/VERSION.json --record-sha256 HEX
lawoss-selfhost rollback
lawoss-selfhost restore-snapshot /opt/lawoss/snapshots/TIME
lawoss-selfhost restore --apply --record-sha256 HEX --private-key /path/backup-private.pem /opt/lawoss/backups/TIME
lawoss-selfhost rotate introspection       # or cookies, signing
lawoss-selfhost services add judikaty      # or remove
```

A release record (`releases/<version>.json`) names the commit, the image digests and the SHA-256 of
every host file. `init` and `update` accept it only when its bytes hash to the value pinned in the
catalog and the host files under `/opt/lawoss` match it; when `gh` is installed they also run
`gh attestation verify` for the auth and hub images and refuse on failure. Every accepted release
keeps its record and a copy of its host files in `/opt/lawoss/releases/<version>/`.

`init --acme-email` is the contact the certificate authority receives; it is rendered as Caddy's
global `email` option and kept in `.env` (not a secret).

`doctor` checks DNS, then TLS and HTTP through `127.0.0.1:443` with each public host name as SNI and
`Host` (no hairpin NAT needed), the issuer and resource metadata, the hub's authenticated path to auth
(`hub --check-introspection` posts a junk token with each service's secret: a secret mismatch and a
broken path are reported apart), that the hub image carries the host's `services.json`, and each
runtime's tools.

`update` takes a snapshot first (`.env`, the Caddyfile, the outgoing release's host files and every
volume, archived with auth stopped for a moment), switches the image digests, renders the Caddyfile
from the new template, recreates the stack and runs `doctor`. If that fails, `.env`, the Caddyfile and
the host files are restored together and the old release is started again; `restore-snapshot DIR`
also puts the volumes back. `rollback` installs the previous release's kept host files and switches
only the image digests, so secrets rotated since stay.

Backups: `backup init-key` creates the backup key pair once and never replaces it; `backup` seals to
`keys/backup-public.pem` only, so the private key can and should live off the server. A backup holds
auth's database (sealed by auth's own script), `hub-data`, `.env`, the Caddyfile, `brand/` and
`releases/`. `restore --dry-run` checks one; `restore --apply` puts one back, also on a fresh server
(certificates are issued again). A backup is sealed with the public key, which anyone may hold, so
`--apply` trusts nothing in it for what it installs: `--record-sha256` is the catalog's pin of the
backup's release record, the backup's `.env` must name that record's images, their attestations
must verify (with `gh`), and only that release's host files are installed; the Caddyfile is
rendered from its template. All of it is checked before anything is stopped or written.

`rotate introspection` replaces every service secret in the hub and auth together; `rotate cookies`
and `rotate signing` put a new key first and keep only the previous one (a signing key stays until
the tokens it signed expire, 60 minutes). `services add|remove ID` changes both configurations,
`LAWOSS_SERVICES` and the Caddyfile.

Brand packs: `brand check PACK` and `brand preview PACK` validate or preview a pack directory (or
a built-in pack name) without installing it; before `init` they take `--record` for the auth image.
`brand set PACK` (or `init --brand PACK`) validates the pack with auth's own loader, copies
`brand.json` and the files it declares to `/opt/lawoss/brand/<name>`, which auth mounts read-only at
`/brand`, and points auth at it. Without a pack the built-in LAWOSS pack applies; a pack directory
may not be named like a built-in pack (`default`, `lawoss`).

`lawoss-selfhost` without arguments lists every command. Tests: `cd cli && npm test` (the seam test
needs `hub/` and `auth/` built: `npm ci --ignore-scripts && npm run build` in each).

## Releases

`.github/workflows/release.yml` runs only when a maintainer starts it (`workflow_dispatch` with the
version and the catalog commit). It builds the auth and hub images, pushes them to
`ghcr.io/omni-legal-products`, attests their build provenance and uploads `releases/<version>.json`
(written by `deploy/release-record.mjs`). Running it publishes; adding or changing it does not.

### Published releases

| Version | Date | Commit | Release record SHA-256 |
|---|---|---|---|
| 0.1.0 | 2026-11-18 | `d041ee6fb116a65dde7201fb4c7d15bbb0b51256` | `6f96cd390968ecfee44c34057b5d61705391ffa91953791cb463d286edfcedde` |

Images of 0.1.0:

- auth: `ghcr.io/omni-legal-products/lawoss-auth@sha256:93e84a8a52d3286b07cc1fd231dc4d679db5e15ecf27daf8dc510876390bc1ea`
- hub: `ghcr.io/omni-legal-products/lawoss-hub@sha256:c86179af9093b1b26405da51aedcd343e66b33bf90a61018a21e12e08e667ea7`
- proxy: `caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b`

Check an image's build provenance with
`gh attestation verify oci://IMAGE --repo Omni-Legal-Products/lawoss-selfhost`.

The release record is not committed here. The workflow run keeps it as the `release-0.1.0`
artifact until 2027-02-16; the lasting copy is in the LAWOSS marketplace, bundled with the
`lawoss-selfhost` skill (`plugins/lawoss-selfhost/skills/lawoss-selfhost/release/0.1.0.json`) and
pinned in its `releases.json`. Place it at `releases/0.1.0.json` in a checkout of the commit above
and check its SHA-256 before use.

## Operator notes

- Runtimes run as the same user as the hub and as each other. A compromised runtime could read the
  hub's environment (every introspection secret and provider key) and other users' runtime
  directories; see `SECURITY.md`. If you suspect one, run `rotate introspection` and replace the
  provider keys.
- If a secret appears in any output by mistake, rotate it (`rotate`, `set-key`).
- Keep the backup private key off the server; without it no backup can be restored.

## License

AGPL-3.0, see `LICENSE`. Fonts in `auth/brand/*/fonts` are under the SIL Open Font License 1.1.
