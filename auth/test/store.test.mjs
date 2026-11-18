import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../dist/store.js";
const resource = "https://kataster.example/mcp";

test("personal username needs no email and is normalized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-username-"));
  const store = new Store(dir);
  try {
    const invite = store.invite("kolega", { [resource]: "kolega" });
    await store.activate(invite.token, "synthetic password for Kolega");
    const member = await store.login(
      " KOLEGA ",
      "synthetic password for Kolega",
    );
    assert.ok(member);
    assert.equal(member.resources[resource], "kolega");
    assert.throws(() => store.invite("two words", { [resource]: "invalid" }));
    assert.throws(() => store.invite("other-user", { [resource]: "kolega" }));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("personal accounts, setup link one-use, passwords and immediate revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-test-"));
  const store = new Store(dir);
  try {
    const invite = store.invite("alice@example.test", { [resource]: "alice" });
    assert.equal(
      await store.login("alice@example.test", "example password for Alice"),
      undefined,
    );
    assert.equal(await store.activate(invite.token, "short"), false);
    assert.equal(
      await store.activate(invite.token, "example password for Alice"),
      true,
    );
    assert.equal(
      await store.activate(invite.token, "a different example password"),
      false,
    );
    const user = await store.login(
      "ALICE@example.test",
      "example password for Alice",
    );
    assert.ok(user);
    assert.equal(user.resources[resource], "alice");
    assert.equal(
      await store.login("alice@example.test", "wrong password"),
      undefined,
    );
    const adapter = store.adapter("AccessToken");
    await adapter.upsert(
      "token",
      { accountId: store.accountId(user), grantId: "grant" },
      60,
    );
    assert.ok(await adapter.find("token"));
    store.disable(user.id);
    assert.equal(await adapter.find("token"), undefined);
    assert.equal(
      await store.login("alice@example.test", "example password for Alice"),
      undefined,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent login throttling and grant replay invalidation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-test-"));
  let store = new Store(dir);
  try {
    const invite = store.invite("bob@example.test", { [resource]: "bob" });
    await store.activate(invite.token, "example password for Bobby");
    for (let i = 0; i < 5; i++)
      await store.login("bob@example.test", "wrong password");
    store.close();
    store = new Store(dir);
    assert.equal(
      await store.login("bob@example.test", "example password for Bobby"),
      undefined,
    );
    const adapter = store.adapter("AuthorizationCode");
    await adapter.upsert("code", { grantId: "g" }, 60);
    await adapter.consume("code");
    await assert.rejects(() => adapter.consume("code"));
    assert.equal(await adapter.find("code"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("resource changes validate personal tenant ownership without changing account version", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-binding-")), store = new Store(dir);
  try {
    const a = store.invite("alice", { [resource]: "alice" });
    store.invite("bob", { [resource]: "bob" });
    const version = store.get(a.memberId).version;
    assert.throws(() => store.grantResource(a.memberId, resource, "bob"));
    assert.throws(() => store.grantResource(a.memberId, "http://invalid", "alice"));
    assert.throws(() => store.grantResource(a.memberId, resource, "INVALID"));
    assert.throws(() => store.grantResource(a.memberId, resource, "replacement"));
    store.grantResource(a.memberId, "https://other.example/mcp", "alice-other");
    store.revokeResource(a.memberId, resource);
    assert.deepEqual(store.get(a.memberId).resources, { "https://other.example/mcp": "alice-other" });
    assert.equal(store.get(a.memberId).version, version);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("admin commands reject unknown services and shared tenants", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-admin-")), store = new Store(dir);
  const other = "https://other.example/mcp";
  try {
    const member = store.invite("alice", { [resource]: "alice" });
    store.invite("bob", { [other]: "bob" });
    const run = (...args) => spawnSync(process.execPath, ["dist/admin.js", ...args], { encoding: "utf8",
      env: { ...process.env, AUTH_CONFIG_JSON: JSON.stringify({ dataDir: dir, resources: { [resource]: {}, [other]: {} } }) } });
    assert.notEqual(run("grant-resource", "alice", "https://unknown.example/mcp", "alice").status, 0);
    assert.notEqual(run("grant-resource", "alice", other, "bob").status, 0);
    assert.equal(run("grant-resource", "alice", other, "alice-other").status, 0);
    assert.equal(run("revoke-resource", "alice", resource).status, 0);
    assert.deepEqual(store.get(member.memberId).resources, { [other]: "alice-other" });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("invite ownership check serializes with grant on an independent SQLite connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-invite-lock-"));
  const first = new Store(dir), second = new Store(dir);
  try {
    const bob = second.invite("bob", { "https://other.example/mcp": "bob" });
    second.db.exec("PRAGMA busy_timeout=0");
    const originalList = first.list.bind(first);
    let competingError;
    first.list = () => {
      const snapshot = originalList();
      try { second.grantResource(bob.memberId, resource, "shared"); }
      catch (error) { competingError = error; }
      return snapshot;
    };
    const alice = first.invite("alice", { [resource]: "shared" });
    first.list = originalList;
    assert.equal(competingError?.errcode, 5, "invite must hold the SQLite writer lock during ownership check");
    assert.equal(first.get(alice.memberId).resources[resource], "shared");
    assert.equal(second.get(bob.memberId).resources[resource], undefined);
    assert.throws(() => second.grantResource(bob.memberId, resource, "shared"), /Tenant already belongs/);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed invitation insert rolls back member creation and preserves existing reset invitation", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-invite-rollback-")), store = new Store(dir);
  try {
    const existing = store.invite("alice", { [resource]: "alice" });
    store.db.exec("CREATE TRIGGER reject_invitation BEFORE INSERT ON invitations BEGIN SELECT RAISE(ABORT,'synthetic invitation failure'); END");
    assert.throws(() => store.invite("bob", { [resource]: "bob" }), /synthetic invitation failure/);
    assert.equal(store.byUsername("bob"), undefined);
    assert.throws(() => store.invite("alice", { [resource]: "alice" }), /synthetic invitation failure/);
    assert.ok(store.invitation(existing.token));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
