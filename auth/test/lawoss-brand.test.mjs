import test from "node:test";
import assert from "node:assert/strict";
import { loadBrand, contrastWithWhite } from "../dist/brand.js";
import { renderPage } from "../dist/ui.js";

test("LAWOSS pack loads with its own assets and readable button text", () => {
  const brand = loadBrand("brand/lawoss");
  assert.equal(brand.productName, "LAWOSS");
  assert.equal(brand.accountLabel, "účet LAWOSS");
  assert.equal(brand.locale, "sk");
  assert.ok(contrastWithWhite(brand.colors.primary) >= 4.5);
  assert.deepEqual(
    [...brand.files.keys()].sort(),
    [
      "fonts/IBMPlexMono-Regular.woff2",
      "fonts/IBMPlexSans-Variable.woff2",
      "fonts/InstrumentSerif-Regular.woff2",
      "logo-dark.svg",
      "logo.svg",
      "mark.svg",
      "tokens.css",
    ],
  );
  const html = renderPage({ state: "login" }, brand);
  assert.match(html, /<title>Vitajte späť\. \| LAWOSS<\/title>/);
  assert.doesNotMatch(html, /SKALLARS|general-sans|flow\.svg/i);
});
