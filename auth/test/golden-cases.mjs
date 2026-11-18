// Synthetic inputs for the golden page fixtures. Not a test file, so importing it registers no tests.
import { createAuth } from "../dist/server.js";
import { hash } from "../dist/store.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

export const states = [
  "login",
  "activate",
  "consent",
  "help",
  "success",
  "expired",
];
// The year in the footer comes from the clock; fixtures are rendered on this date.
export const goldenDate = new Date("2026-11-17T12:00:00Z");
const shared = {
  service: "Ukážková služba",
  client: "Ukážková aplikácia",
  redirect: "http://127.0.0.1:19876/mcp/oauth/callback",
  csrf: "x",
  username: "kolega",
  error: "Nesprávne údaje.",
};
export const goldenOptions = Object.fromEntries(
  states.map((state) => [
    state,
    { ...shared, state, action: `/interaction/golden/${state}` },
  ]),
);
// Every case renders through renderPage; the name is the fixture file under test/golden/.
export const renderCases = [
  ...states.map((state) => [state, goldenOptions[state]]),
  // Fallback texts (no service, client, username or error).
  ...states.map((state) => [`bare-${state}`, { state }]),
  ["preview-login", { state: "login", service: "Kataster", preview: true }],
  [
    "preview-consent",
    {
      state: "consent",
      service: "Kataster",
      client: "Codex",
      redirect: "http://localhost:1455/auth/callback",
      preview: true,
    },
  ],
];
// Pages rendered by the running server with no brand configured.
export const serverCases = [
  ["server-help", "/help", 200],
  ["server-expired", "/activate/golden-unknown-token", 400],
];

export async function startServer(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "auth-golden-"));
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
    allowInsecureForTests: true,
    cookieKeys: ["golden-cookie-key-".repeat(4)],
    jwks: { keys: [{ ...key, kid: "golden", alg: "RS256", use: "sig" }] },
    resources: {
      "https://sluzba.example/mcp": {
        name: "Ukážková služba",
        scope: "mcp:tools",
        secretHash: hash("golden-synthetic-service-secret"),
      },
    },
    ...overrides,
  });
  const server = auth.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      auth.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
