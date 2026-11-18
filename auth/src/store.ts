import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  randomUUID,
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
export interface Member {
  id: string;
  username: string;
  password: string | null;
  status: string;
  version: number;
  resources: Record<string, string>;
}
type Row = Omit<Member, "resources"> & { resources: string };
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
let activeHashes = 0;
const derive = async (password: string, salt: string) => {
  if (activeHashes >= 2)
    throw Object.assign(new Error("Password service busy"), { status: 429 });
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        32,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 },
        (err, key) => (err ? reject(err) : resolve(key)),
      ),
    );
  } finally {
    activeHashes--;
  }
};
const normalize = (username: string) => username.trim().toLowerCase();
const DUMMY_SALT = "00000000000000000000000000000000";
export class Store {
  readonly db: DatabaseSync;
  private cleanup: ReturnType<typeof setInterval>;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "auth.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,resources TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY,memberId TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS attempts(hash TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS objects(model TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER,PRIMARY KEY(model,id));
   CREATE TABLE IF NOT EXISTS grant_resource_blocks(grantId TEXT NOT NULL,resource TEXT NOT NULL,PRIMARY KEY(grantId,resource));
   CREATE INDEX IF NOT EXISTS object_grants ON objects(json_extract(payload,'$.grantId'));
   CREATE INDEX IF NOT EXISTS object_accounts ON objects(json_extract(payload,'$.accountId'));
   CREATE INDEX IF NOT EXISTS object_uids ON objects(model,json_extract(payload,'$.uid'));`);
    this.prune();
    this.cleanup = setInterval(() => this.prune(), 60000).unref();
  }
  private member(row: unknown): Member | undefined {
    if (!row) return undefined;
    const r = row as Row;
    return { ...r, resources: JSON.parse(r.resources) };
  }
  get(id: string) {
    return this.member(
      this.db.prepare("SELECT * FROM members WHERE id=?").get(id),
    );
  }
  byUsername(username: string) {
    return this.member(
      this.db
        .prepare("SELECT * FROM members WHERE username=?")
        .get(normalize(username)),
    );
  }
  list() {
    return (
      this.db
        .prepare("SELECT * FROM members ORDER BY username")
        .all() as unknown as Row[]
    ).map((r) => ({
      id: r.id,
      username: r.username,
      status: r.status,
      resources: JSON.parse(r.resources),
    }));
  }
  invite(username: string, resources: Record<string, string>) {
    username = normalize(username);
    if (
      (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) ||
      username.length > 254
    )
      throw new Error("Invalid username");
    if (
      !Object.keys(resources).length ||
      Object.entries(resources).some(
        ([url, tenant]) =>
          !url.startsWith("https://") || !/^[-a-z0-9_]{1,64}$/.test(tenant),
      )
    )
      throw new Error("Invalid resource binding");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let member = this.byUsername(username);
      if (!member) {
        if (
          this.list().some((other) =>
            Object.entries(resources).some(
              ([url, tenant]) => other.resources[url] === tenant,
            ),
          )
        )
          throw new Error("Tenant already belongs to another member");
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO members(id,username,status,resources) VALUES(?,?,'pending',?)",
          )
          .run(id, username, JSON.stringify(resources));
        member = this.get(id)!;
      } else if (JSON.stringify(member.resources) !== JSON.stringify(resources))
        throw new Error(
          "Use existing resource bindings when resetting a password",
        );
      this.db.prepare("DELETE FROM invitations WHERE memberId=?").run(member.id);
      const token = randomBytes(32).toString("base64url");
      this.db
        .prepare("INSERT INTO invitations VALUES(?,?,?)")
        .run(hash(token), member.id, now() + 3600);
      this.db.exec("COMMIT");
      return { token, memberId: member.id, username };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  invitation(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const r = this.db
      .prepare("SELECT memberId FROM invitations WHERE hash=? AND expires>?")
      .get(hash(token), now());
    return r ? this.get(String(r.memberId)) : undefined;
  }
  async activate(token: string, password: string) {
    if (
      password.length < 15 ||
      password.length > 128 ||
      !this.invitation(token)
    )
      return false;
    const salt = randomBytes(16).toString("hex");
    const encoded = `${salt}:${(await derive(password, salt)).toString("hex")}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const user = this.invitation(token);
      if (!user) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("DELETE FROM invitations WHERE hash=?").run(hash(token));
      this.db
        .prepare(
          "UPDATE members SET password=?,status='active',version=version+1 WHERE id=?",
        )
        .run(encoded, user.id);
      this.revokeObjects(user.id);
      this.db
        .prepare("DELETE FROM attempts WHERE hash=?")
        .run(hash(user.username));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async login(username: string, password: string) {
    username = normalize(username);
    if (username.length > 254 || password.length > 128) return undefined;
    const key = hash(username);
    this.db
      .prepare("DELETE FROM attempts WHERE hash=? AND expires<=?")
      .run(key, now());
    const attempt = this.db
      .prepare("SELECT count FROM attempts WHERE hash=?")
      .get(key);
    if (attempt && Number(attempt.count) >= 5) return undefined;
    this.db
      .prepare(
        "INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(hash) DO UPDATE SET count=count+1",
      )
      .run(key, now() + 900);
    const member = this.byUsername(username);
    const [salt, encoded] = (
      member?.password || `${DUMMY_SALT}:${"0".repeat(64)}`
    ).split(":");
    const supplied = await derive(password, salt);
    if (
      !member ||
      member.status !== "active" ||
      !timingSafeEqual(supplied, Buffer.from(encoded, "hex"))
    )
      return undefined;
    // A concurrent password reset or disable must invalidate this login.
    const current = this.get(member.id);
    if (current?.version !== member.version || current.status !== "active")
      return undefined;
    this.db.prepare("DELETE FROM attempts WHERE hash=?").run(key);
    return current;
  }
  grantResource(id: string, resource: string, tenant: string) {
    if (!resource.startsWith("https://") || !/^[-a-z0-9_]{1,64}$/.test(tenant))
      throw new Error("Invalid resource binding");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const member = this.get(id);
      if (!member) throw new Error("Unknown member");
      if (member.resources[resource] && member.resources[resource] !== tenant)
        throw new Error("Revoke the existing binding before changing tenant");
      if (this.list().some((other) => other.id !== id && other.resources[resource] === tenant))
        throw new Error("Tenant already belongs to another member");
      this.db.prepare("UPDATE members SET resources=? WHERE id=?")
        .run(JSON.stringify({ ...member.resources, [resource]: tenant }), id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  resourceBlocked(grantId: string, resource: string) {
    return !!this.db.prepare("SELECT 1 FROM grant_resource_blocks WHERE grantId=? AND resource=?").get(grantId, resource);
  }
  private filterResourcePayload(model: string, id: string, input: AdapterPayload): AdapterPayload | undefined {
    const payload = structuredClone(input);
    const grantId = model === "Grant" ? id : payload.grantId;
    if (!grantId) return payload;
    const blocks = this.db.prepare("SELECT resource FROM grant_resource_blocks WHERE grantId=?").all(grantId).map((r) => String(r.resource));
    if (!blocks.length) return payload;
    if (model === "Grant") {
      const resources = payload.resources as Record<string, string> | undefined;
      for (const resource of blocks) if (resources) delete resources[resource];
    } else {
      if (typeof payload.aud === "string" && blocks.includes(payload.aud)) return undefined;
      const resource = payload.resource;
      if (typeof resource === "string" && blocks.includes(resource)) return undefined;
      if (Array.isArray(resource)) {
        payload.resource = resource.filter((r) => !blocks.includes(r));
        if (!payload.resource.length) return undefined;
      }
    }
    return payload;
  }
  revokeResource(id: string, resource: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const member = this.get(id);
      if (!member) throw new Error("Unknown member");
      const resources = { ...member.resources };
      delete resources[resource];
      this.db.prepare("UPDATE members SET resources=? WHERE id=?").run(JSON.stringify(resources), id);
      const rows = this.db.prepare("SELECT model,id,payload FROM objects WHERE json_extract(payload,'$.accountId') LIKE ?").all(`${id}:%`);
      for (const row of rows) {
        const payload = JSON.parse(String(row.payload));
        if (row.model === "Grant" && Object.hasOwn(payload.resources || {}, resource))
          this.db.prepare("INSERT OR IGNORE INTO grant_resource_blocks VALUES(?,?)").run(String(row.id), resource);
        if (payload.grantId && (payload.aud === resource || payload.resource === resource || (Array.isArray(payload.resource) && payload.resource.includes(resource))))
          this.db.prepare("INSERT OR IGNORE INTO grant_resource_blocks VALUES(?,?)").run(payload.grantId, resource);
      }
      for (const row of rows) {
        const filtered = this.filterResourcePayload(String(row.model), String(row.id), JSON.parse(String(row.payload)));
        if (!filtered) this.db.prepare("DELETE FROM objects WHERE model=? AND id=?").run(row.model, row.id);
        else this.db.prepare("UPDATE objects SET payload=? WHERE model=? AND id=?").run(JSON.stringify(filtered), row.model, row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private revokeObjects(id: string) {
    this.db
      .prepare(
        "DELETE FROM objects WHERE json_extract(payload,'$.accountId') LIKE ? OR json_extract(payload,'$.session.accountId') LIKE ?",
      )
      .run(`${id}:%`, `${id}:%`);
  }
  disable(id: string) {
    if (!this.get(id)) throw new Error("Unknown member");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE members SET status='disabled',version=version+1 WHERE id=?",
        )
        .run(id);
      this.revokeObjects(id);
      this.db.prepare("DELETE FROM invitations WHERE memberId=?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  accountId(member: Member) {
    return `${member.id}:${member.version}`;
  }
  activeAccount(accountId: unknown) {
    if (typeof accountId !== "string") return undefined;
    const [id, version] = accountId.split(":");
    const user = this.get(id);
    return user?.status === "active" && String(user.version) === version
      ? user
      : undefined;
  }
  prune() {
    this.db
      .prepare("DELETE FROM objects WHERE expires IS NOT NULL AND expires<=?")
      .run(now());
    for (const table of ["invitations", "attempts"])
      this.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(now());
  }
  adapter(model: string): Adapter {
    const find = (key: string, value: string) => {
      const row = this.db
        .prepare(
          `SELECT id,payload FROM objects WHERE model=? AND ${key}=? AND (expires IS NULL OR expires>?)`,
        )
        .get(model, value, now());
      if (!row) return undefined;
      const payload = this.filterResourcePayload(model, String(row.id), JSON.parse(String(row.payload)) as AdapterPayload);
      if (!payload) return undefined;
      const account =
        payload.accountId ||
        (payload.session as { accountId?: string } | undefined)?.accountId;
      return account && !this.activeAccount(account) ? undefined : payload;
    };
    return {
      upsert: async (id, payload, expiresIn) => {
        const filtered = this.filterResourcePayload(model, id, payload);
        if (!filtered) return;
        this.db
          .prepare(
            "INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires",
          )
          .run(
            model,
            id,
            JSON.stringify(filtered),
            typeof expiresIn === "number" ? now() + expiresIn : null,
          );
      },
      find: async (id) => find("id", id),
      findByUid: async (id) => find("json_extract(payload,'$.uid')", id),
      findByUserCode: async (id) =>
        find("json_extract(payload,'$.userCode')", id),
      destroy: async (id) => {
        this.db
          .prepare("DELETE FROM objects WHERE model=? AND id=?")
          .run(model, id);
      },
      consume: async (id) => {
        const updated = this.db
          .prepare(
            "UPDATE objects SET payload=json_set(payload,'$.consumed',?) WHERE model=? AND id=? AND json_extract(payload,'$.consumed') IS NULL",
          )
          .run(now(), model, id);
        if (!updated.changes) {
          const row = this.db
            .prepare(
              "SELECT json_extract(payload,'$.grantId') AS grantId FROM objects WHERE model=? AND id=?",
            )
            .get(model, id);
          if (row?.grantId)
            this.db
              .prepare(
                "DELETE FROM objects WHERE json_extract(payload,'$.grantId')=? OR (model='Grant' AND id=?)",
              )
              .run(row.grantId, row.grantId);
          throw new errors.InvalidGrant(
            "Authorization credential already consumed",
          );
        }
      },
      revokeByGrantId: async (id) => {
        this.db
          .prepare(
            "DELETE FROM objects WHERE json_extract(payload,'$.grantId')=? OR (model='Grant' AND id=?)",
          )
          .run(id, id);
      },
    };
  }
  close() {
    clearInterval(this.cleanup);
    this.db.close();
  }
}
