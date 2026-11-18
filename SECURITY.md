# Security policy

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
for this repository. Do not open a public issue for a security problem.

Only the latest commit on `main` is supported. Fixes to `auth/` are made in the upstream and arrive
with the next export, recorded in `auth/SOURCE_COMMIT`.

## Known residual risks

These are accepted for now and stated so that operators can weigh them.

- **Runtimes share one user with the hub and with each other.** Every runtime process runs as the
  hub container's `node` user. A runtime that is compromised (they parse untrusted PDF and HTML
  from public portals) could read `/proc/<hub pid>/environ`, which holds `HUB_CONFIG_JSON` with every
  introspection secret and every provider key, and could read other principals' runtime
  directories. The per-runtime environment allowlist and the per-principal 0700 directories protect
  against mistakes, not against a runtime bug. If you suspect a compromised runtime, run
  `lawoss-selfhost rotate introspection` and replace the provider keys with `set-key`.
  Planned: a separate user per runtime.
- **The manifest pins tool names, not arguments.** A runtime update that adds a new tool is denied
  until `hub/services.json` is reviewed, but a new path-like argument on an existing tool is not
  yet detected automatically (design section 5.3). Argument (input property) pinning is planned
  before the first update of the recorded catalog commit; until then every catalog commit bump must
  be reviewed for new arguments by hand.
