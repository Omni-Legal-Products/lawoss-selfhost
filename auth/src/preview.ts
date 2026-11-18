import express from "express";
import { resolve } from "node:path";
import { renderPage, type PageState } from "./ui.js";
import { defaultBrand, loadBrand, pageStates } from "./brand.js";
// Optional pack to review before it goes live: AUTH_BRAND=brand/<name> node dist/preview.js
const brand = process.env.AUTH_BRAND
  ? loadBrand(resolve(process.env.AUTH_BRAND))
  : defaultBrand();
const app = express();
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'none'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  next();
});
app.use("/assets", express.static("public"));
const brandAssets = express.static(brand.dir);
app.use("/assets", (req, res, next) =>
  brand.files.has(req.path.slice(1)) ? brandAssets(req, res, next) : next(),
);
app.get("/", (_req, res) => res.redirect("/preview/login"));
app.get("/preview/:state", (req, res) => {
  const state = req.params.state as PageState;
  if (!pageStates.includes(state)) return res.sendStatus(404);
  res.type("html").send(
    renderPage(
      {
        state,
        service: "Kataster",
        client: "Codex",
        username: state === "activate" ? "kolega@example.test" : undefined,
        redirect: "http://localhost:1455/auth/callback",
        preview: true,
      },
      brand,
    ),
  );
});
app.listen(4317, "127.0.0.1", () =>
  console.log(`${brand.productName} preview: http://127.0.0.1:4317`),
);
