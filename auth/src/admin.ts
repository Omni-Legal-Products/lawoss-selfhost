import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { Store } from "./store.js";
import type { Config } from "./server.js";
const raw =
  process.env.AUTH_CONFIG_JSON ||
  (process.env.AUTH_CONFIG
    ? readFileSync(process.env.AUTH_CONFIG, "utf8")
    : undefined);
if (!raw) throw new Error("AUTH_CONFIG required");
const config = JSON.parse(raw) as Config;
const store = new Store(config.dataDir);
try {
  const [command, username, resource, tenant, out] = process.argv.slice(2);
  if (command === "list") console.log(JSON.stringify(store.list(), null, 2));
  else if (command === "invite") {
    if (
      !username ||
      !resource ||
      !tenant ||
      !out ||
      !Object.hasOwn(config.resources, resource)
    )
      throw new Error(
        "Usage: invite USERNAME_OR_EMAIL RESOURCE TENANT OUTPUT_FILE",
      );
    const output = openSync(out, "wx", 0o600);
    try {
      const user = store.byUsername(username);
      const invite = store.invite(
        username,
        user?.resources || { [resource]: tenant },
      );
      writeFileSync(output, `${config.origin}/activate/${invite.token}\n`);
    } finally {
      closeSync(output);
    }
    console.log(
      "One-time link saved to the specified private file; valid for 1 hour.",
    );
  } else if (command === "grant-resource" || command === "revoke-resource") {
    if (!username || !resource || !Object.hasOwn(config.resources, resource))
      throw new Error("Known member and configured resource required");
    const user = store.byUsername(username);
    if (!user) throw new Error("Unknown member");
    if (command === "grant-resource") {
      if (!tenant) throw new Error("Usage: grant-resource USERNAME RESOURCE TENANT");
      store.grantResource(user.id, resource, tenant);
    } else store.revokeResource(user.id, resource);
    console.log("Resource access updated.");
  } else if (command === "disable") {
    if (!username) throw new Error("Usage: disable USERNAME_OR_EMAIL");
    const user = store.byUsername(username);
    if (!user) throw new Error("Unknown member");
    store.disable(user.id);
    console.log("Access disabled.");
  } else throw new Error("Commands: list, invite, grant-resource, revoke-resource, disable");
} finally {
  store.close();
}
