import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createAuth } from "../dist/server.js";
import { hash } from "../dist/store.js";

test("first-run invitation is one-use and restart preserves personal accounts and tokens", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "auth-bootstrap-"));
  const resource = "https://kataster.example/mcp";
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "jwk" });
  const token = "x".repeat(43);
  const config = {
    origin: "http://127.0.0.1:5321",
    dataDir,
    allowInsecureForTests: true,
    cookieKeys: ["test-cookie-key-".repeat(4)],
    jwks: { keys: [{ ...key, kid: "test", alg: "RS256", use: "sig" }] },
    resources: {
      [resource]: {
        name: "Kataster",
        scope: "mcp:tools",
        secretHash: hash("test-service-key"),
      },
    },
    bootstrap: {
      username: "kolega",
      resources: { [resource]: "kolega" },
      invitationHash: hash(token),
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  };
  let auth = createAuth(config);
  try {
    assert.equal(auth.store.invitation(token).username, "kolega");
    assert.ok(
      await auth.store.activate(token, "synthetic password for Kolega"),
    );
    const member = await auth.store.login(
      "KOLEGA",
      "synthetic password for Kolega",
    );
    await auth.store
      .adapter("RefreshToken")
      .upsert(
        "persisted-token",
        { accountId: auth.store.accountId(member), grantId: "test-grant" },
        90 * 86400,
      );
    auth.close();
    auth = createAuth({
      ...config,
      bootstrap: { ...config.bootstrap, expires: 0 },
    });
    assert.equal(auth.store.list().length, 1);
    assert.equal(auth.store.invitation(token), undefined);
    assert.ok(
      await auth.store.login("kolega", "synthetic password for Kolega"),
    );
    assert.ok(await auth.store.adapter("RefreshToken").find("persisted-token"));
  } finally {
    auth.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
