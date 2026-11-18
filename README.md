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

## License

AGPL-3.0, see `LICENSE`. Fonts in `auth/brand/*/fonts` are under the SIL Open Font License 1.1.
