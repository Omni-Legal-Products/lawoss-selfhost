import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { once } from "node:events";
import { createAuth } from "../dist/server.js";
import { hash } from "../dist/store.js";
const resource = "https://kataster.example/mcp",
  other = "https://other.example/mcp",
  secret = "test-only-service-secret-".repeat(3),
  verifier = "a".repeat(64);
class Browser {
  cookies = new Map();
  async request(url, options = {}) {
    const target = new URL(url);
    const res = await fetch(url, {
      ...options,
      redirect: "manual",
      headers: {
        cookie: [...this.cookies.values()]
          .filter((c) => target.pathname.startsWith(c.path))
          .map((c) => `${c.name}=${c.value}`)
          .join("; "),
        ...options.headers,
      },
    });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      const c = {
        name: pair.slice(0, i),
        value: pair.slice(i + 1),
        path: /;\s*path=([^;]+)/i.exec(raw)?.[1] || "/",
      };
      this.cookies.set(c.name + "|" + c.path, c);
    }
    return res;
  }
  async follow(url, origin) {
    for (let i = 0; i < 12; i++) {
      if (url.startsWith("http://localhost:45454")) return new URL(url);
      const res = await this.request(url);
      if (![302, 303].includes(res.status)) return res;
      url = new URL(res.headers.get("location"), origin).href;
    }
    throw new Error("redirect loop");
  }
}
async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "auth-oidc-"));
  const socket = (await import("node:net")).createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "jwk" });
  const auth = createAuth({
    origin,
    dataDir: dir,
    cookieKeys: ["cookie-test-key-".repeat(4)],
    jwks: { keys: [{ ...key, kid: "test", alg: "RS256", use: "sig" }] },
    resources: {
      [resource]: {
        name: "Kataster",
        scope: "mcp:tools",
        secretHash: hash(secret),
      },
      [other]: {
        name: "Iná služba",
        scope: "mcp:tools",
        secretHash: hash(secret + "other"),
      },
    },
    allowInsecureForTests: true,
    ...overrides,
  });
  const server = auth.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    auth.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const invite = auth.store.invite("alice@example.test", {
    [resource]: "alice",
  });
  await auth.store.activate(invite.token, "synthetic password for Alice");
  const registration = await fetch(origin + "/reg", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:45454/callback"],
      client_name: "Test client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json();
  const post = (path, body, headers = {}) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const introspect = async (token, aud = resource, key = secret) =>
    await (
      await post(
        "/resource/introspect",
        { token, resource: aud },
        { Authorization: `Bearer ${key}` },
      )
    ).json();
  async function grant(overrides = {}) {
    const browser = new Browser();
    const url =
      origin +
      "/auth?" +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: "code",
        scope: "offline_access mcp:tools",
        resource,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        state: "test-state",
        ...overrides,
      });
    let response = await browser.follow(url, origin);
    assert.equal(response.status, 200, await response.clone().text());
    let html = await response.text();
    assert.ok(html.includes("Vitajte späť."));
    const submit = async (html, fields) => {
      const action = /action="([^"]+)"/.exec(html)[1];
      const csrf = /name="csrf" value="([^"]*)"/.exec(html)[1];
      return browser.request(origin + action, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: origin,
        },
        body: new URLSearchParams({ csrf, ...fields }),
      });
    };
    response = await submit(html, {
      username: "alice@example.test",
      password: "synthetic password for Alice",
    });
    assert.ok(
      [302, 303].includes(response.status),
      await response.clone().text(),
    );
    response = await browser.follow(
      new URL(response.headers.get("location"), origin).href,
      origin,
    );
    assert.equal(response.status, 200, await response.clone().text());
    html = await response.text();
    assert.ok(html.includes("Povoliť prístup?"));
    response = await submit(html, { decision: "allow" });
    const result = await browser.follow(
      new URL(response.headers.get("location"), origin).href,
      origin,
    );
    assert.ok(result instanceof URL);
    assert.equal(result.searchParams.get("state"), "test-state");
    return result.searchParams.get("code");
  }
  return { auth, origin, client, post, introspect, grant, invite };
}
test("real OAuth password login, PKCE, resource isolation, refresh and revocation", async (t) => {
  const f = await fixture(t);
  const code = await f.grant();
  const exchange = {
    grant_type: "authorization_code",
    client_id: f.client.client_id,
    redirect_uri: f.client.redirect_uris[0],
    code,
    code_verifier: verifier,
    resource,
  };
  const response = await f.post("/token", exchange);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json();
  assert.ok(tokens.refresh_token);
  // Introspection checks revocation on every request, so a longer lifetime only cuts refresh traffic.
  assert.equal(tokens.expires_in, 3600);
  const identity = await f.introspect(tokens.access_token);
  assert.equal(identity.active, true);
  assert.equal(identity.tenant, "alice");
  assert.equal(identity.aud, resource);
  assert.equal(
    (await f.introspect(tokens.access_token, other, secret + "other")).active,
    false,
  );
  const refreshed = await f.post("/token", {
    grant_type: "refresh_token",
    client_id: f.client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  f.auth.store.disable(f.invite.memberId);
  assert.equal((await f.introspect(next.access_token)).active, false);
  assert.equal(
    (
      await f.post("/token", {
        grant_type: "refresh_token",
        client_id: f.client.client_id,
        refresh_token: next.refresh_token,
        resource,
      })
    ).status,
    400,
  );
});
test("public metadata bypasses the per-IP limit and limited endpoints answer 429 as OAuth JSON", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 200; i++) {
    const metadata = await fetch(f.origin + "/.well-known/oauth-authorization-server");
    assert.equal(metadata.status, 200);
    await metadata.arrayBuffer();
    const jwks = await fetch(f.origin + "/jwks");
    assert.equal(jwks.status, 200);
    await jwks.arrayBuffer();
  }
  let limited;
  for (let i = 0; i < 200 && !limited; i++) {
    const response = await fetch(f.origin + "/help");
    if (response.status === 429) limited = response;
    else await response.arrayBuffer();
  }
  assert.ok(limited, "global limit never triggered");
  assert.match(limited.headers.get("content-type"), /^application\/json/);
  assert.equal((await limited.json()).error, "temporarily_unavailable");
  // Every resource server introspects from one shared IP; a 429 here would become a 401 for the user.
  for (let i = 0; i < 50; i++)
    assert.equal((await f.introspect("unknown-token")).active, false);
});
async function issueTokens(f) {
  const code = await f.grant();
  const response = await f.post("/token", {
    grant_type: "authorization_code",
    client_id: f.client.client_id,
    redirect_uri: f.client.redirect_uris[0],
    code,
    code_verifier: verifier,
    resource,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const refreshBody = (f, refresh_token) => ({
  grant_type: "refresh_token",
  client_id: f.client.client_id,
  refresh_token,
  resource,
});
test("token endpoint is limited per client, so one runaway client does not starve others on a shared IP", async (t) => {
  const f = await fixture(t);
  const dead = { grant_type: "refresh_token", refresh_token: "dead", client_id: f.client.client_id, resource };
  let limited;
  for (let i = 0; i < 200 && !limited; i++) {
    const response = await f.post("/token", { ...dead, refresh_token: "dead" + i });
    if (response.status === 429) limited = { response, at: i };
    else await response.arrayBuffer();
  }
  assert.ok(limited, "per-client limit never triggered");
  assert.ok(limited.at > 180 / 4 && limited.at <= 60, `limited after ${limited.at}`);
  assert.equal((await limited.response.json()).error, "temporarily_unavailable");
  const registration = await fetch(f.origin + "/reg", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:45454/callback"],
      client_name: "Second client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const other = await registration.json();
  const response = await f.post("/token", { ...dead, client_id: other.client_id });
  assert.equal(response.status, 400, await response.clone().text());
  // The runaway client itself stays limited.
  assert.equal((await f.post("/token", dead)).status, 429);
});
test("concurrent refreshes with one token share the rotated pair and keep the grant", async (t) => {
  const f = await fixture(t);
  const tokens = await issueTokens(f);
  const responses = await Promise.all(
    [0, 1, 2].map(() => f.post("/token", refreshBody(f, tokens.refresh_token))),
  );
  const bodies = await Promise.all(responses.map((r) => r.text()));
  for (const [i, r] of responses.entries()) {
    assert.equal(r.status, 200, bodies[i]);
    assert.match(r.headers.get("content-type"), /^application\/json/);
  }
  assert.equal(new Set(bodies).size, 1);
  const late = await f.post("/token", refreshBody(f, tokens.refresh_token));
  assert.equal(late.status, 200);
  assert.equal(await late.text(), bodies[0]);
  const next = JSON.parse(bodies[0]);
  assert.equal((await f.introspect(next.access_token)).active, true);
  const renewed = await f.post("/token", refreshBody(f, next.refresh_token));
  assert.equal(renewed.status, 200, await renewed.clone().text());
});
test("refresh token reuse after the grace window still revokes the grant", async (t) => {
  const f = await fixture(t, { refreshReuseGraceMs: 50 });
  const tokens = await issueTokens(f);
  const first = await f.post("/token", refreshBody(f, tokens.refresh_token));
  assert.equal(first.status, 200);
  const next = await first.json();
  await new Promise((r) => setTimeout(r, 120));
  const reuse = await f.post("/token", refreshBody(f, tokens.refresh_token));
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, "invalid_grant");
  assert.equal((await f.post("/token", refreshBody(f, next.refresh_token))).status, 400);
  assert.equal((await f.introspect(next.access_token)).active, false);
});
test("registration rejects remote redirect injection, setup rejects cross-site POST", async (t) => {
  const f = await fixture(t);
  const r = await fetch(f.origin + "/reg", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
  });
  assert.equal(r.status, 400);
  const invite = f.auth.store.invite("bob@example.test", { [resource]: "bob" });
  const response = await f.post(
    "/activate/" + invite.token,
    {
      csrf: invite.token,
      password: "synthetic password for Bobby",
      confirm: "synthetic password for Bobby",
    },
    { Origin: "https://evil.example" },
  );
  assert.equal(response.status, 400);
  assert.ok(f.auth.store.invitation(invite.token));
  const valid = await f.post(
    "/activate/" + invite.token,
    {
      csrf: invite.token,
      password: "synthetic password for Bobby",
      confirm: "synthetic password for Bobby",
    },
    { Origin: f.origin },
  );
  assert.equal(valid.status, 200);
  assert.ok((await valid.text()).includes("Všetko je pripravené."));
});

test("metadata matches provider, PKCE mismatch and code replay are rejected", async (t) => {
  const f = await fixture(t);
  const metadata = await (
    await fetch(f.origin + "/.well-known/oauth-authorization-server")
  ).json();
  const oidc = await (
    await fetch(f.origin + "/.well-known/openid-configuration")
  ).json();
  for (const key of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "revocation_endpoint",
    "jwks_uri",
  ])
    assert.equal(metadata[key], oidc[key]);
  const code = await f.grant();
  const exchange = {
    grant_type: "authorization_code",
    client_id: f.client.client_id,
    redirect_uri: f.client.redirect_uris[0],
    code,
    code_verifier: verifier,
    resource,
  };
  assert.equal(
    (await f.post("/token", { ...exchange, code_verifier: "b".repeat(64) }))
      .status,
    400,
  );
  const goodCode = await f.grant();
  const replies = await Promise.all([
    f.post("/token", { ...exchange, code: goodCode }),
    f.post("/token", { ...exchange, code: goodCode }),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 400]);
  const successful = await replies.find((r) => r.status === 200).json();
  assert.equal((await f.introspect(successful.access_token)).active, false);
});

test("MCP refresh survives browser session expiry and has an absolute 90-day limit", async (t) => {
  const f = await fixture(t);
  const code = await f.grant({ scope: "mcp:tools" });
  const response = await f.post("/token", {
    grant_type: "authorization_code",
    client_id: f.client.client_id,
    redirect_uri: f.client.redirect_uris[0],
    code,
    code_verifier: verifier,
    resource,
  });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.ok(
    tokens.refresh_token,
    "MCP clients need renewal even without the OIDC offline_access scope",
  );
  const initial = await f.auth.provider.RefreshToken.find(tokens.refresh_token);
  assert.notEqual(initial.expiresWithSession, true);
  assert.equal(initial.exp - initial.iiat, 90 * 86400);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 89 * 86400000 });
  const renewed = await f.post("/token", {
    grant_type: "refresh_token",
    client_id: f.client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  });
  assert.equal(renewed.status, 200, await renewed.clone().text());
  const next = await renewed.json();
  const rotated = await f.auth.provider.RefreshToken.find(next.refresh_token);
  assert.equal(
    rotated.exp,
    initial.exp,
    "rotation must not extend the original authorization",
  );
  t.mock.timers.tick(2 * 86400000);
  assert.equal(
    (
      await f.post("/token", {
        grant_type: "refresh_token",
        client_id: f.client.client_id,
        refresh_token: next.refresh_token,
        resource,
      })
    ).status,
    400,
  );
});


test("scoped revoke invalidates issued credentials permanently and preserves another service", async (t) => {
  const f = await fixture(t);
  f.auth.store.grantResource(f.invite.memberId, other, "alice-other");
  const version = f.auth.store.get(f.invite.memberId).version;
  async function issue(aud) {
    const code = await f.grant({ resource: aud });
    const res = await f.post("/token", { grant_type: "authorization_code", client_id: f.client.client_id,
      redirect_uri: f.client.redirect_uris[0], code, code_verifier: verifier, resource: aud });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  }
  const a = await issue(resource), b = await issue(other);
  const cachedAccess = await f.auth.provider.AccessToken.find(a.access_token);
  const cachedGrant = await f.auth.provider.Grant.find(cachedAccess.grantId);
  const cachedAccessPayload = JSON.parse(f.auth.store.db.prepare("SELECT payload FROM objects WHERE model='AccessToken' AND id=?").get(cachedAccess.jti).payload);
  f.auth.store.revokeResource(f.invite.memberId, resource);
  assert.equal(f.auth.store.get(f.invite.memberId).version, version);
  assert.equal((await f.introspect(a.access_token)).active, false);
  assert.equal((await f.introspect(b.access_token, other, secret + "other")).active, true);
  f.auth.store.grantResource(f.invite.memberId, resource, "alice");
  await cachedGrant.save();
  await f.auth.store.adapter("AccessToken").upsert(cachedAccess.jti, cachedAccessPayload, 300);
  assert.equal((await f.introspect(a.access_token)).active, false);
  assert.equal((await f.post("/token", { grant_type: "refresh_token", client_id: f.client.client_id,
    refresh_token: a.refresh_token, resource })).status, 400);
  assert.equal((await f.post("/token", { grant_type: "refresh_token", client_id: f.client.client_id,
    refresh_token: b.refresh_token, resource: other })).status, 200);
  assert.equal((await f.introspect((await issue(resource)).access_token)).active, true);
});


test("multi-resource grant retains the unaffected refresh audience after scoped revoke", async (t) => {
  const f = await fixture(t);
  f.auth.store.grantResource(f.invite.memberId, other, "alice-other");
  const response = await f.post("/token", { grant_type: "authorization_code", client_id: f.client.client_id,
    redirect_uri: f.client.redirect_uris[0], code: await f.grant({ resource: other }), code_verifier: verifier, resource: other });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  const refresh = await f.auth.provider.RefreshToken.find(tokens.refresh_token);
  const grant = await f.auth.provider.Grant.find(refresh.grantId);
  grant.addResourceScope(resource, "mcp:tools"); await grant.save();
  refresh.resource = [resource, other];
  const combinedRefresh = await refresh.save();
  f.auth.store.revokeResource(f.invite.memberId, resource);
  f.auth.store.grantResource(f.invite.memberId, resource, "alice");
  await grant.save(); await refresh.save();
  const retainedGrant = await f.auth.provider.Grant.find(grant.jti);
  assert.equal(retainedGrant.getResourceScope(resource), "");
  assert.equal(retainedGrant.getResourceScope(other), "mcp:tools");
  const retainedRefresh = await f.auth.provider.RefreshToken.find(combinedRefresh);
  assert.deepEqual(retainedRefresh.resource, [other]);
  const renewed = await f.post("/token", { grant_type: "refresh_token", client_id: f.client.client_id,
    refresh_token: combinedRefresh, resource: other });
  assert.equal(renewed.status, 200, await renewed.clone().text());
  assert.equal((await f.introspect((await renewed.json()).access_token, other, secret + "other")).active, true);
});
