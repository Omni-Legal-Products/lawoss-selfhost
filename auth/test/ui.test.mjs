import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../dist/ui.js";

test("shared forms escape service, action, values and errors; password is never reflected", () => {
  const html = renderPage({
    state: "login",
    service: "<script>alert(1)</script>",
    action: "/interaction/test/login",
    csrf: '"<unsafe>',
    username: '" onfocus="alert(1)',
    error: "<b>bad</b>",
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('autocomplete="current-password"'));
  assert.ok(html.includes('role="alert"'));
  assert.throws(() =>
    renderPage({ state: "login", action: "https://evil.example", csrf: "x" }),
  );
  for (const state of [
    "login",
    "activate",
    "consent",
    "help",
    "success",
    "expired",
  ]) {
    const page = renderPage({
      state,
      action: "/test",
      csrf: "x",
      service: "Kataster",
      username: "person@example.test",
    });
    assert.ok(page.includes('lang="sk"'));
    assert.ok(page.includes("/assets/tokens.css"));
    assert.ok(!page.includes("style="));
  }
});
