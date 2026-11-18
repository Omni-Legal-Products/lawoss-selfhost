// Local synthetic browser flow; never loads production configuration.
import { createAuth } from "../dist/server.js";
import { hash } from "../dist/store.js";
import { generateKeyPairSync, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const origin = "http://127.0.0.1:5321",
  callback = "http://localhost:5322/callback",
  resource = "https://kataster.example/mcp";
const dir = mkdtempSync(join(tmpdir(), "auth-browser-"));
const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ format: "jwk" });
const auth = createAuth({
  origin,
  dataDir: dir,
  allowInsecureForTests: true,
  cookieKeys: ["synthetic-cookie-key-".repeat(4)],
  jwks: { keys: [{ ...key, kid: "test", alg: "RS256", use: "sig" }] },
  resources: {
    [resource]: {
      name: "Kataster",
      scope: "mcp:tools",
      secretHash: hash("synthetic-service-key"),
    },
  },
});
const invitation = auth.store.invite("test-user", { [resource]: "test-user" });
await auth.store.activate(invitation.token, "synthetic browser password");
const server = auth.app.listen(5321, "127.0.0.1");
const registered = await fetch(origin + "/reg", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    redirect_uris: [callback],
    client_name: "Browser test client",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
if (registered.status !== 201) throw new Error("Fixture registration failed");
const client = await registered.json(),
  verifier = randomBytes(48).toString("base64url"),
  state = randomBytes(16).toString("hex");
const start =
  origin +
  "/auth?" +
  new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: callback,
    response_type: "code",
    scope: "mcp:tools",
    resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  });
const browser = createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.writeHead(302, { Location: start });
      return res.end();
    }
    const url = new URL(req.url, "http://localhost:5322");
    if (
      url.pathname !== "/callback" ||
      url.searchParams.get("state") !== state ||
      !url.searchParams.get("code")
    ) {
      res.writeHead(400);
      return res.end("Invalid callback");
    }
    const response = await fetch(origin + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: callback,
        code: url.searchParams.get("code"),
        code_verifier: verifier,
        resource,
      }),
    });
    const tokens = await response.json();
    if (!response.ok || !tokens.refresh_token)
      throw new Error("Token exchange failed");
    const check = await fetch(origin + "/resource/introspect", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Bearer synthetic-service-key",
      },
      body: new URLSearchParams({ token: tokens.access_token, resource }),
    });
    const identity = await check.json();
    if (!identity.active || identity.tenant !== "test-user")
      throw new Error("Introspection failed");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src data:",
    });
    res.end(
      '<!doctype html><html lang="sk"><title>OAuth overené</title><link rel="icon" href="data:,"><h1>OAuth pripojenie overené.</h1><p>PKCE, prihlasovanie, súhlas, návrat do klienta a obnovovací token fungujú.</p></html>',
    );
  } catch {
    res.writeHead(500);
    res.end("Fixture failed");
  }
}).listen(5322, "127.0.0.1", () =>
  console.log("Synthetic browser fixture: http://localhost:5322"),
);
process.once("SIGINT", () => {
  browser.close();
  server.close(() => {
    auth.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
});
