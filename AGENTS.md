# lawoss-selfhost agent instructions

## Project

- Purpose: self-hosted LAWOSS MCP servers behind a brandable OAuth login, deployable by an AI agent.
- `auth/` is the authorization server. It is exported from a recorded commit of the maintainer's
  private upstream; `auth/SOURCE_COMMIT` names it and `auth/EXPORT_MANIFEST.sha256` lists every file.
- License: AGPL-3.0 (`LICENSE`). Bundled fonts keep the SIL Open Font License (`auth/brand/*/fonts/OFL.txt`).

## Rules

- Do not edit `auth/` by hand. Changes go to the upstream first and arrive with the next export.
- Never commit secrets, keys, activation links, passwords, real hostnames, IP addresses, user paths
  or deployment identifiers. Example hosts use `example.com`.
- Do not publish images, create releases or change repository settings without explicit maintainer approval.
- Work on branches and through pull requests.

## Verification

```sh
cd auth
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=high
docker build -t lawoss-auth:test .
cd ..
cmp AGENTS.md CLAUDE.md
```

## Mirror rule

`AGENTS.md` is the source of truth; `CLAUDE.md` must be byte-for-byte identical and change in the same commit.
