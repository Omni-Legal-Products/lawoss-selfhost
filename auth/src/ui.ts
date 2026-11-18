import { defaultBrand, pageStates, type Brand, type PageState } from "./brand.js";
export type { PageState } from "./brand.js";
export interface PageOptions {
  state: PageState;
  service?: string;
  action?: string;
  csrf?: string;
  username?: string;
  error?: string;
  client?: string;
  redirect?: string;
  preview?: boolean;
}
export const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
// Escapes a catalog text, then inserts already safe HTML for its {placeholders}.
const fill = (template: string, values: Record<string, string>) =>
  escape(template).replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : match,
  );
const lines = (html: string) => html.replace(/\n/g, "<br>");
export function renderPage(o: PageOptions, brand: Brand = defaultBrand()): string {
  const action = o.action || "/";
  if (
    !action.startsWith("/") ||
    action.startsWith("//") ||
    /[\\\r\n]/.test(action)
  )
    throw new Error("Same-origin form action required");
  const t = brand.texts;
  const e = escape;
  const product = e(brand.productName);
  const f = (template: string, values: Record<string, string> = {}) =>
    fill(template, { product, ...values });
  const [title, subtitle] = t[o.state].map((s) => f(s));
  const service = e(o.service || t.defaultService);
  const asset = (path: string) => `/assets/${e(path)}`;
  const password = (label: string, id: string, activation: boolean) =>
    `<div class="field"><label for="${id}">${f(label)}</label><div class="password"><input id="${id}" name="${id}" type="password" autocomplete="${activation ? "new-password" : "current-password"}" ${activation ? 'minlength="15" ' : ""}maxlength="128" required><button class="reveal" type="button" data-reveal="${id}" aria-controls="${id}" aria-pressed="false">${f(t.reveal)}</button></div></div>`;
  const error = o.error
    ? `<p class="error" role="alert">${e(o.error)}</p>`
    : "";
  const start = `<form method="post" action="${e(action)}"${o.preview ? " data-preview" : ""}><input type="hidden" name="csrf" value="${e(o.csrf || "")}">`;
  const button = (label: string) =>
    `<button class="primary" type="submit"><span>${f(label)}</span><span class="arrow" aria-hidden="true">→</span></button>`;
  const help = o.preview ? "/preview/help" : "/help";
  let body = "";
  if (o.state === "login")
    body = `${start}<div class="field"><label for="username">${f(t.usernameLabel)}</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${f(t.usernamePlaceholder)}" value="${e(o.username || "")}" maxlength="254" required></div>${password(t.passwordLabel, "password", false)}<a class="help-link" href="${help}">${f(t.forgot)}</a>${button(t.signIn)}</form><p class="assist">${f(t.noAccess)} <a href="${help}">${f(t.contactAdmin)}</a></p>`;
  if (o.state === "activate")
    body = `${start}<div class="field"><label for="username">${f(t.usernameLabel)}</label><input id="username" name="username" type="text" autocomplete="username" value="${e(o.username || "")}" readonly></div>${password(t.newPasswordLabel, "password", true)}${password(t.confirmLabel, "confirm", true)}<p class="hint">${f(t.passwordHint)}</p><br>${button(t.setPassword)}</form>`;
  if (o.state === "consent")
    body = `<p>${f(t.consentRequest, { client: `<strong>${e(o.client || t.defaultClient)}</strong>`, service: `<strong>${service}</strong>` })}</p><ul class="consent-list"><li><span class="check" aria-hidden="true">↗</span><span>${f(t.consentTools)}</span></li><li><span class="check" aria-hidden="true">↗</span><span>${f(t.consentRefresh)}</span></li></ul><p class="legal">${f(t.consentLegal)}</p><details class="details"><summary>${f(t.connectionDetails)}</summary><p>${f(t.redirectLabel)} ${e(o.redirect || "")}</p></details>${start}<button class="primary" name="decision" value="allow"><span>${f(t.allow)}</span><span class="arrow" aria-hidden="true">→</span></button><button class="secondary" name="decision" value="deny">${f(t.deny)}</button></form>`;
  if (o.state === "help" || o.state === "expired")
    body = `<p class="legal">${f(t.helpText)}</p><p class="assist">${f(t.adminContact)}</p>`;
  if (o.state === "success")
    body = `<div class="notice">${f(t.closeWindow)}</div>`;
  const preview = o.preview
    ? `<p class="preview-note" data-preview-note role="status">${f(t.previewNote)}</p><nav class="preview" aria-label="${f(t.previewNav)}">${pageStates.map((state, i) => `<a href="/preview/${state}"${o.state === state ? ' aria-current="page"' : ""}>${f(t.previewLabels[i]!)}</a>`).join("")}</nav>`
    : "";
  const { assets, links } = brand;
  const art = assets.artwork
    ? `<img class="art" src="${asset(assets.artwork)}" alt="" aria-hidden="true">`
    : "";
  const footerLinks = (["privacy", "terms"] as const)
    .filter((key) => links[key])
    .map((key) => `<span><a href="${e(links[key]!)}">${f(t[key])}</a></span>`)
    .join("");
  return `<!doctype html><html lang="${brand.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} | ${product}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="${asset(assets.tokens)}"><link rel="stylesheet" href="/assets/auth.css"><script src="/assets/auth.js" defer></script></head><body><a class="skip" href="#main">${f(t.skip)}</a><header class="top"><img class="logo" src="${asset(assets.logo)}" alt="${product}" width="${assets.logoSize.width}" height="${assets.logoSize.height}"><span class="top-note">${f(t.topNote)}</span></header><div class="layout"><aside class="identity" aria-label="${f(t.asideLabel)}">${art}<h2>${lines(f(t.asideTitle))}</h2><p>${lines(f(t.asideText))}</p></aside><main id="main" class="form-panel"><div class="service"><span class="dot" aria-hidden="true"></span><strong>${service}</strong><span>${e(brand.accountLabel)}</span></div><h1>${title}</h1><p class="intro">${subtitle}</p>${error}${body}${preview}</main></div><footer class="footer"><span>${f(t.footer, { year: String(new Date().getFullYear()) })}</span><span>${f(t.footerNote)}</span>${footerLinks}</footer></body></html>`;
}
