import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../dist/ui.js";
import { readFileSync } from "node:fs";
// The default brand pack output (tokens, assets) is pinned by test/golden.test.mjs.
test("UI never silently posts preview credentials", () => {
  const html = renderPage({
    state: "login",
    service: "Slov-Lex",
    preview: true,
  });
  assert.ok(html.includes("data-preview"));
  assert.ok(html.includes("Slov-Lex"));
  const js = readFileSync("public/auth.js", "utf8");
  assert.ok(js.includes("event.preventDefault()"));
  assert.ok(!js.includes("fetch("));
});
