import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadSharedAuthConfig,
  createSharedAuth,
  currentIdentity,
  runWithIdentity,
  principalKey,
} from "../dist/resource-server/skallars-auth.js";
const env = {
  MCP_AUTH_MODE: "shared-oauth",
  SKALLARS_AUTH_ISSUER: "https://auth.example.test",
  SKALLARS_AUTH_RESOURCE: "https://disq.example.test/mcp",
  SKALLARS_AUTH_SECRET: "s".repeat(32),
};
const request = {
  headers: { host: "disq.example.test", authorization: "Bearer synthetic" },
  rawHeaders: ["Authorization", "Bearer synthetic"],
};
const claims = {
  active: true,
  iss: env.SKALLARS_AUTH_ISSUER,
  aud: env.SKALLARS_AUTH_RESOURCE,
  sub: "user-1",
  tenant: "tenant-1",
  scope: "mcp:tools",
  exp: Math.floor(Date.now() / 1000) + 60,
};
test("canonical adapter configuration and fail-closed claims", async () => {
  const config = loadSharedAuthConfig(env);
  for (const key of [
    "SKALLARS_AUTH_ISSUER",
    "SKALLARS_AUTH_RESOURCE",
    "SKALLARS_AUTH_SECRET",
  ])
    assert.throws(() => loadSharedAuthConfig({ ...env, [key]: "" }));
  for (const override of [
    { active: false },
    { iss: "https://evil.test" },
    { aud: "https://other.test/mcp" },
    { sub: "" },
    { tenant: "../x" },
    { scope: "other" },
    { exp: 0 },
  ]) {
    const auth = createSharedAuth(config, {
      fetch: async () =>
        new Response(JSON.stringify({ ...claims, ...override })),
    });
    assert.equal(await auth.authenticate(request), undefined);
  }
  const auth = createSharedAuth(config, {
    fetch: async () => new Response(JSON.stringify(claims)),
  });
  const identity = await auth.authenticate(request);
  assert.equal(identity.sub, "user-1");
  assert.equal(
    auth.checkRequest({
      ...request,
      headers: { ...request.headers, origin: "null" },
    }),
    false,
  );
  assert.equal(auth.metadata().resource, env.SKALLARS_AUTH_RESOURCE);
  assert.equal(
    auth.challenge,
    'Bearer resource_metadata="https://disq.example.test/.well-known/oauth-protected-resource/mcp"',
  );
  await Promise.all(
    [identity, { ...identity, sub: "user-2" }].map((value) =>
      runWithIdentity(value, async () => {
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(currentIdentity(), value);
      }),
    ),
  );
  assert.equal(currentIdentity(), undefined);
  assert.notEqual(
    principalKey(identity),
    principalKey({ ...identity, tenant: "tenant-2" }),
  );
});
