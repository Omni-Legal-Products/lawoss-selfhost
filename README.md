# lawoss-selfhost

Self-hosted LAWOSS MCP servers with a branded login, deployable by an AI agent.

> Status: early. This repository contains the authorization server (`auth/`), the MCP hub
> (`hub/`), the Compose deployment (`deploy/`) and the setup CLI (`cli/`). No container images
> are published yet.

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
dropped, no new privileges, memory and process limits); only the proxy publishes ports 80 and 443.
Check it with:

```sh
python3 -m unittest -v deploy/test/compose.test.py
docker compose -f deploy/compose.yaml --env-file deploy/.env.example config -q
```

## Setup CLI

`cli/lawoss-selfhost.mjs` (Node standard library only) is installed to `/opt/lawoss/bin` next to
`compose.yaml`, `Caddyfile.template` and `services.json` in `/opt/lawoss`, and run with `sudo`.
It generates every secret on the server into `/opt/lawoss/.env` (0600, root) and never prints a
secret, key, activation link or password: its outputs are host names, `PASS`/`FAIL` lines and
paths of 0600 files. Account, backup and snapshot work runs in one-off containers; no container
gets the Docker socket.

```sh
lawoss-selfhost init --base example.com --services crz,orsr --record releases/VERSION.json --record-sha256 HEX
lawoss-selfhost invite alice crz,orsr      # prints /opt/lawoss/handoff/alice.link
lawoss-selfhost doctor
lawoss-selfhost update --to VERSION --record releases/VERSION.json --record-sha256 HEX
```

`init` and `update` accept a release only when its record hashes to the value pinned in the
catalog; when `gh` is installed they also run `gh attestation verify` for the auth and hub images
and refuse on failure. A custom brand pack (`init --brand /path/to/pack`, `brand check`,
`brand preview`) is copied to `/opt/lawoss/brand/<name>`, which auth mounts read-only at
`/brand`; without `--brand` the built-in LAWOSS pack applies.

`lawoss-selfhost` without arguments lists every command. Tests: `cd cli && npm test`.

## License

AGPL-3.0, see `LICENSE`. Fonts in `auth/brand/*/fonts` are under the SIL Open Font License 1.1.
