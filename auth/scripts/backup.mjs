import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomBytes, createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, constants, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, renameSync, existsSync, chmodSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const label = Buffer.from("skallars-backup:v1:auth");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const keyOptions = (key) => ({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: label });
export function seal(content, publicKey) {
  const recipient = createPublicKey(publicKey);
  if (recipient.asymmetricKeyType !== "rsa" || recipient.asymmetricKeyDetails.modulusLength < 3072) throw new Error("RSA 3072-bit public key required");
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(label);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
  return { format: "skallars-backup-v1", service: "auth", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    key: publicEncrypt(keyOptions(recipient), key).toString("base64"), ciphertext: ciphertext.toString("base64") };
}
export async function snapshot({ config, publicKey, output, revision = "unknown" }) {
  const temp = mkdtempSync(join(tmpdir(), "skallars-auth-backup-")); chmodSync(temp, 0o700);
  let db;
  try {
    db = new DatabaseSync(join(config.dataDir, "auth.sqlite"), { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    const dbPath = join(temp, "auth.sqlite");
    await backup(db, dbPath);
    chmodSync(dbPath, 0o600);
    const database = readFileSync(dbPath), createdAt = new Date().toISOString();
    const content = { format: "skallars-restore-v1", service: "auth", createdAt, revision, config, database: database.toString("base64"),
      manifest: { configSha256: digest(JSON.stringify(config)), databaseSha256: digest(database) } };
    const envelope = seal(content, publicKey);
    writeFileSync(output, JSON.stringify(envelope) + "\n", { flag: "wx", mode: 0o600 });
    return { createdAt, sha256: digest(readFileSync(output)) };
  } finally { db?.close(); rmSync(temp, { recursive: true, force: true }); }
}
export async function restore({ input, privateKey, destination }) {
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error("Restore destination must not exist");
  const envelope = JSON.parse(readFileSync(input, "utf8"));
  if (envelope.format !== "skallars-backup-v1" || envelope.service !== "auth") throw new Error("Invalid backup envelope");
  const key = privateDecrypt(keyOptions(privateKey), Buffer.from(envelope.key, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(label); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const content = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  if (content.format !== "skallars-restore-v1" || content.service !== "auth" || !content.config || !content.manifest) throw new Error("Invalid restore manifest");
  const database = Buffer.from(content.database, "base64");
  if (digest(database) !== content.manifest.databaseSha256 || digest(JSON.stringify(content.config)) !== content.manifest.configSha256) throw new Error("Checksum mismatch");
  const temp = mkdtempSync(join(dirname(destination), ".auth-restore-")); chmodSync(temp, 0o700);
  let db;
  try {
    const dbPath = join(temp, "auth.sqlite"); writeFileSync(dbPath, database, { flag: "wx", mode: 0o600 });
    db = new DatabaseSync(dbPath, { readOnly: true });
    const check = db.prepare("PRAGMA quick_check").get();
    if (check.quick_check !== "ok") throw new Error("SQLite integrity check failed");
    db.close(); db = undefined;
    writeFileSync(join(temp, "config.json"), JSON.stringify({ ...content.config, dataDir: destination }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    writeFileSync(join(temp, "manifest.json"), JSON.stringify({ createdAt: content.createdAt, revision: content.revision, ...content.manifest }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, destination);
    return { createdAt: content.createdAt, revision: content.revision };
  } finally { db?.close(); rmSync(temp, { recursive: true, force: true }); }
}
export function retain(directory, days = 7) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Retention must be 1 to 30 days");
  for (const name of readdirSync(directory)) {
    if (!/^auth-\d{4}-\d{2}-\d{2}T[\d-]+Z\.enc\.json$/.test(name)) continue;
    const path = join(directory, name), file = statSync(path);
    if (file.isFile() && file.mtimeMs < Date.now() - days * 86400000) rmSync(path);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return args[i + 1]; };
  try {
    if (command === "snapshot") {
      const raw = process.env.AUTH_CONFIG_JSON || readFileSync(process.env.AUTH_CONFIG || option("--config"), "utf8");
      const config = JSON.parse(raw), publicKey = readFileSync(option("--public-key"));
      let output;
      if (args.includes("--directory")) {
        const directory = resolve(option("--directory")); mkdirSync(directory, { recursive: true, mode: 0o700 });
        output = join(directory, `auth-${new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}/, "")}.enc.json`);
        const result = await snapshot({ config, publicKey, output, revision: process.env.SOURCE_REVISION });
        retain(directory, args.includes("--retain-days") ? Number(option("--retain-days")) : 7);
        console.log(JSON.stringify({ output, ...result }));
      } else {
        output = resolve(option("--output"));
        console.log(JSON.stringify({ output, ...await snapshot({ config, publicKey, output, revision: process.env.SOURCE_REVISION }) }));
      }
    } else if (command === "restore") {
      console.log(JSON.stringify(await restore({ input: option("--input"), privateKey: readFileSync(option("--private-key")), destination: option("--destination") })));
    } else throw new Error("Commands: snapshot, restore");
  } catch { console.error("Backup operation failed; check arguments, keys, integrity and private destination."); process.exitCode = 1; }
}
