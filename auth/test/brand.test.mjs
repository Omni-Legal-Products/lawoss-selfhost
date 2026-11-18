import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrand } from "../dist/brand.js";
import { renderPage } from "../dist/ui.js";
import { createAuth } from "../dist/server.js";
import { startServer } from "./golden-cases.mjs";

const logo =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
// Synthetic pack: a WOFF2 signature is enough, browsers never see these bytes.
function pack(t, edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "auth-brand-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "fonts"));
  writeFileSync(join(dir, "logo.svg"), logo);
  writeFileSync(join(dir, "tokens.css"), ":root { --color-violet-500: #2f4b66; }\n");
  writeFileSync(join(dir, "fonts", "sans.woff2"), "wOF2synthetic");
  const json = {
    productName: "Ukážka",
    accountLabel: "účet Ukážka",
    locale: "sk",
    assets: {
      logo: "logo.svg",
      tokens: "tokens.css",
      fonts: [{ file: "fonts/sans.woff2", family: "Ukážka Sans" }],
    },
  };
  edit(json, dir);
  writeFileSync(join(dir, "brand.json"), JSON.stringify(json));
  return dir;
}
const invalid = (t, edit, reason) =>
  assert.throws(() => loadBrand(pack(t, edit)), (error) => {
    assert.match(error.message, /^Invalid brand pack: /);
    assert.match(error.message, reason);
    return true;
  });

test("loads the default pack and a minimal pack", (t) => {
  // Brand-neutral: the public edition ships another pack in brand/default.
  assert.ok(loadBrand("brand/default").productName);
  const brand = loadBrand(pack(t));
  assert.equal(brand.locale, "sk");
  assert.deepEqual([...brand.files.keys()].sort(), [
    "fonts/sans.woff2",
    "logo.svg",
    "tokens.css",
  ]);
});

test("rejects an asset outside the pack", (t) => {
  invalid(t, (j) => (j.assets.logo = "../x.svg"), /outside the pack/);
  invalid(t, (j) => (j.assets.logo = "/etc/x.svg"), /outside the pack/);
  invalid(
    t,
    (j, dir) => {
      const outside = mkdtempSync(join(tmpdir(), "auth-outside-"));
      t.after(() => rmSync(outside, { recursive: true, force: true }));
      writeFileSync(join(outside, "x.svg"), logo);
      symlinkSync(join(outside, "x.svg"), join(dir, "linked.svg"));
      j.assets.logo = "linked.svg";
    },
    /outside the pack/,
  );
});

test("rejects svg with script, event handlers or foreignObject", (t) => {
  for (const [svg, reason] of [
    ["<svg><script/></svg>", /script/],
    ['<svg><rect onload="x()"/></svg>', /event handler/],
    ["<svg><foreignObject/></svg>", /foreignObject/],
  ])
    invalid(
      t,
      (j, dir) => writeFileSync(join(dir, "logo.svg"), svg),
      reason,
    );
});

test("rejects oversized assets, wrong font files and reserved names", (t) => {
  invalid(
    t,
    (j, dir) =>
      writeFileSync(join(dir, "logo.svg"), logo + " ".repeat(512 * 1024)),
    /larger than 512 KiB/,
  );
  invalid(
    t,
    (j, dir) => {
      writeFileSync(join(dir, "fonts", "sans.ttf"), "wOF2synthetic");
      j.assets.fonts[0].file = "fonts/sans.ttf";
    },
    /woff2/,
  );
  invalid(
    t,
    (j, dir) => writeFileSync(join(dir, "fonts", "sans.woff2"), "not a font"),
    /woff2/,
  );
  invalid(
    t,
    (j, dir) => {
      writeFileSync(join(dir, "auth.css"), "");
      j.assets.tokens = "auth.css";
    },
    /reserved/,
  );
});

test("rejects bad colors, locales, texts and links", (t) => {
  const colors = {
    primary: "#2F4B66",
    primaryDeep: "#0A0E14",
    accent: "#C9A227",
    ink: "#0A0E14",
    surface: "#F4F1EA",
    line: "#42586E",
  };
  assert.equal(loadBrand(pack(t, (j) => (j.colors = colors))).colors.primary, "#2F4B66");
  invalid(t, (j) => (j.colors = { ...colors, accent: "gold" }), /hex/);
  invalid(
    t,
    (j) => (j.colors = { ...colors, primary: "#BBBBBB" }),
    /contrast/,
  );
  invalid(t, (j) => (j.locale = "fr"), /locale/);
  invalid(t, (j) => (j.texts = { unknown: "x" }), /unknown text/);
  invalid(t, (j) => (j.texts = { login: ["only title"] }), /login/);
  invalid(t, (j) => (j.links = { privacy: "http://example.com" }), /https/);
  invalid(t, (j) => (j.productName = ""), /productName/);
});

test("escapes all brand texts", (t) => {
  const brand = loadBrand(
    pack(t, (j) => {
      j.productName = "<b>";
      j.accountLabel = '"<i>';
      j.texts = {
        topNote: "<script>x</script>",
        asideTitle: "<u>\nriadok",
        login: ["<em>", "<kbd>"],
      };
      j.links = { privacy: "https://example.com/?a=1&b=<2>" };
    }),
  );
  const html = renderPage({ state: "login", csrf: "x" }, brand);
  assert.ok(html.includes("&lt;b&gt;"));
  assert.ok(html.includes("&quot;&lt;i&gt;"));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes("&lt;u&gt;<br>riadok"));
  assert.ok(html.includes("https://example.com/?a=1&amp;b=&lt;2&gt;"));
  for (const raw of ["<b>", "<i>", "<script>", "<u>", "<em>", "<kbd>"])
    assert.ok(!html.includes(raw), raw);
});

test("sets lang and the built-in catalog from locale", (t) => {
  for (const [locale, sample] of [
    ["cs", "Přihlásit se"],
    ["en", "Sign in"],
    ["de", "Anmelden"],
  ]) {
    const html = renderPage(
      { state: "login", csrf: "x" },
      loadBrand(pack(t, (j) => (j.locale = locale))),
    );
    assert.ok(html.startsWith(`<!doctype html><html lang="${locale}">`));
    assert.ok(html.includes(sample), locale);
  }
});

test("server serves only declared pack assets and refuses an invalid pack", async (t) => {
  const dir = pack(t, (j, d) => writeFileSync(join(d, "notes.txt"), "x"));
  const server = await startServer({ brand: dir });
  t.after(() => server.close());
  const get = (path) => fetch(server.origin + path);
  const font = await get("/assets/fonts/sans.woff2");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await font.text(), "wOF2synthetic");
  for (const path of ["/assets/brand.json", "/assets/notes.txt", "/assets/flow.svg"])
    assert.equal((await get(path)).status, 404, path);
  assert.equal((await get("/assets/auth.css")).status, 200);
  const help = await (await get("/help")).text();
  assert.ok(help.includes("<title>Potrebujete pomoc? | Ukážka</title>"));
  assert.ok(!help.includes("flow.svg"));
  assert.throws(
    () =>
      createAuth({
        origin: "http://127.0.0.1:1",
        dataDir: dir,
        brand: pack(t, (j) => (j.locale = "xx")),
        allowInsecureForTests: true,
        cookieKeys: ["x".repeat(32)],
        jwks: { keys: [{ kty: "oct" }] },
        resources: {
          "https://sluzba.example/mcp": {
            name: "x",
            scope: "mcp:tools",
            secretHash: "a".repeat(64),
          },
        },
      }),
    /Invalid brand pack/,
  );
});
