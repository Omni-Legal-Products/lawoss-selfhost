# lawoss-selfhost

Self-hosted LAWOSS MCP servers with a branded login, deployable by an AI agent.

> Status: early. This repository currently contains only the authorization server (`auth/`).
> The MCP hub, the setup CLI and Docker Compose follow in later releases. No container images
> are published yet.

## Contents

- `auth/`: OAuth 2.1 authorization server (Node 24, Express 5, `oidc-provider` 9, SQLite) with
  sign-in, activation, consent and help screens. The default brand pack is LAWOSS
  (`auth/brand/default`); a deployment can select its own pack with the optional `brand` field of its configuration
  (preview a pack with `AUTH_BRAND=brand/<name> node dist/preview.js`).
  Exported from upstream commit `2e17cb822bdef433d9df7d09c3e36ea2e5d89f96`.
- `deploy/.env.example`: placeholder configuration.

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

## License

AGPL-3.0, see `LICENSE`. Fonts in `auth/brand/*/fonts` are under the SIL Open Font License 1.1.
