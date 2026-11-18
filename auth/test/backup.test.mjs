import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { snapshot, restore, seal, retain } from "../scripts/backup.mjs";

test("encrypted snapshot restores WAL content and persistent config, rejects tamper and wrong key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-backup-"));
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const db = new DatabaseSync(join(dir, "auth.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('wal-only-row');");
    const config = { dataDir: dir, cookieKeys: ["persistent-key"], jwks: { keys: [{ synthetic: true }] } };
    const out = join(dir, "snapshot.enc.json");
    await snapshot({ config, publicKey, output: out, revision: "test" });
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.ok(!readFileSync(out, "utf8").includes("persistent-key"));
    const destination = join(dir, "restored");
    await restore({ input: out, privateKey, destination });
    const restored = new DatabaseSync(join(destination, "auth.sqlite"));
    assert.equal(restored.prepare("SELECT value FROM evidence").get().value, "wal-only-row");
    restored.close();
    const saved = JSON.parse(readFileSync(join(destination, "config.json"), "utf8"));
    assert.deepEqual(saved.cookieKeys, config.cookieKeys);
    assert.deepEqual(saved.jwks, config.jwks);
    assert.equal(saved.dataDir, destination);
    await assert.rejects(() => restore({ input: out, privateKey, destination }));
    const wrong = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey;
    await assert.rejects(() => restore({ input: out, privateKey: wrong, destination: join(dir, "wrong") }));
    assert.equal(existsSync(join(dir, "wrong")), false);
    const envelope = JSON.parse(readFileSync(out));
    const data = Buffer.from(envelope.ciphertext, "base64"); data[0] ^= 1;
    envelope.ciphertext = data.toString("base64");
    const corrupted = join(dir, "corrupted.enc.json"); writeFileSync(corrupted, JSON.stringify(envelope));
    await assert.rejects(() => restore({ input: corrupted, privateKey, destination: join(dir, "bad") }));
    assert.equal(existsSync(join(dir, "bad")), false);
    const invalidManifest = join(dir, "invalid-manifest.enc.json");
    writeFileSync(invalidManifest, JSON.stringify(seal({ format: "skallars-restore-v1", service: "auth", config,
      database: Buffer.from("invalid").toString("base64"), manifest: { configSha256: "bad", databaseSha256: "bad" } }, publicKey)));
    await assert.rejects(() => restore({ input: invalidManifest, privateKey, destination: join(dir, "invalid") }), /Checksum mismatch/);
    assert.equal(existsSync(join(dir, "invalid")), false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("retention deletes only expired managed snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-retention-"));
  try {
    const expired = join(dir, "auth-2026-01-01T02-15-00Z.enc.json"), unrelated = join(dir, "keep.json");
    writeFileSync(expired, "encrypted-placeholder"); writeFileSync(unrelated, "keep");
    const old = new Date(Date.now() - 8 * 86400000); utimesSync(expired, old, old); utimesSync(unrelated, old, old);
    assert.throws(() => retain(dir, 0));
    retain(dir, 7);
    assert.equal(existsSync(expired), false); assert.equal(existsSync(unrelated), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
