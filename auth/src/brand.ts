import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type PageState =
  | "login"
  | "activate"
  | "consent"
  | "help"
  | "success"
  | "expired";
export const pageStates: PageState[] = [
  "login",
  "activate",
  "consent",
  "help",
  "success",
  "expired",
];
export type Locale = "sk" | "cs" | "en" | "de";
const locales: Locale[] = ["sk", "cs", "en", "de"];

// Every word on the shared pages. Placeholders: {product}, {client}, {service}, {year}.
// A line break in asideTitle and asideText is written as "\n".
export interface Texts extends Record<PageState, [string, string]> {
  defaultService: string;
  defaultClient: string;
  usernameLabel: string;
  usernamePlaceholder: string;
  passwordLabel: string;
  newPasswordLabel: string;
  confirmLabel: string;
  reveal: string;
  forgot: string;
  signIn: string;
  noAccess: string;
  contactAdmin: string;
  passwordHint: string;
  setPassword: string;
  consentRequest: string;
  consentTools: string;
  consentRefresh: string;
  consentLegal: string;
  connectionDetails: string;
  redirectLabel: string;
  allow: string;
  deny: string;
  helpText: string;
  adminContact: string;
  closeWindow: string;
  previewNote: string;
  previewNav: string;
  previewLabels: [string, string, string, string, string, string];
  skip: string;
  topNote: string;
  asideLabel: string;
  asideTitle: string;
  asideText: string;
  footer: string;
  footerNote: string;
  privacy: string;
  terms: string;
}

// Built-in catalogs. The Slovak one reproduces the pages as they were before brand packs.
export const catalogs: Record<Locale, Texts> = {
  sk: {
    login: ["Vitajte späť.", "Prihláste sa svojím účtom {product}."],
    activate: [
      "Váš nový prístup.",
      "Nastavte si heslo pre svoje pracovné nástroje.",
    ],
    consent: [
      "Povoliť prístup?",
      "Skontrolujte, ku ktorej službe sa aplikácia pripája.",
    ],
    help: [
      "Potrebujete pomoc?",
      "Obnovenie prístupu zabezpečuje správca {product}.",
    ],
    success: [
      "Všetko je pripravené.",
      "Heslo je nastavené. Vráťte sa do aplikácie a pripojte službu.",
    ],
    expired: [
      "Odkaz už neplatí.",
      "Platnosť odkazu vypršala alebo už bol použitý. Vyžiadajte si nový od správcu.",
    ],
    defaultService: "Pracovné nástroje",
    defaultClient: "Aplikácia",
    usernameLabel: "Používateľské meno alebo e-mail",
    usernamePlaceholder: "meno alebo e-mail",
    passwordLabel: "Heslo",
    newPasswordLabel: "Nové heslo",
    confirmLabel: "Zopakujte heslo",
    reveal: "Zobraziť",
    forgot: "Zabudli ste heslo?",
    signIn: "Prihlásiť sa",
    noAccess: "Prístup nemáte?",
    contactAdmin: "Obráťte sa na správcu.",
    passwordHint: "Aspoň 15 znakov. Heslo si môžete uložiť do správcu hesiel.",
    setPassword: "Nastaviť heslo",
    consentRequest: "{client} žiada prístup k službe {service}.",
    consentTools: "Používať nástroje a údaje služby v rozsahu vašich oprávnení",
    consentRefresh: "Automaticky obnovovať pripojenie najviac 90 dní",
    consentLegal: "Aplikácia nedostane vaše heslo. Prístup môže správca odobrať.",
    connectionDetails: "Podrobnosti pripojenia",
    redirectLabel: "Návratová adresa:",
    allow: "Povoliť prístup",
    deny: "Odmietnuť",
    helpText:
      "Správca vám po overení identity poskytne jednorazový odkaz na nastavenie nového hesla. Heslo neposielajte e-mailom ani do chatu.",
    adminContact: "Kontaktujte svojho správcu pracovných nástrojov {product}.",
    closeWindow: "Toto okno môžete zavrieť.",
    previewNote: "Ukážka rozhrania. Nepoužívajte skutočné prihlasovacie údaje.",
    previewNav: "Ukážky stavov",
    previewLabels: [
      "Prihlásenie",
      "Nové heslo",
      "Súhlas",
      "Pomoc",
      "Hotovo",
      "Expirované",
    ],
    skip: "Preskočiť na prihlásenie",
    topNote: "Prístup k pracovným nástrojom",
    asideLabel: "{product} pracovné nástroje",
    asideTitle: "Právne nástroje.\nJeden prístup.",
    asideText: "Vaše služby {product}.\nPod jedným bezpečným účtom.",
    footer: "© {year} {product}",
    footerNote: "Súkromné pracovné prostredie",
    privacy: "Ochrana súkromia",
    terms: "Podmienky používania",
  },
  cs: {
    login: ["Vítejte zpět.", "Přihlaste se svým účtem {product}."],
    activate: [
      "Váš nový přístup.",
      "Nastavte si heslo pro své pracovní nástroje.",
    ],
    consent: [
      "Povolit přístup?",
      "Zkontrolujte, ke které službě se aplikace připojuje.",
    ],
    help: [
      "Potřebujete pomoc?",
      "Obnovení přístupu zajišťuje správce {product}.",
    ],
    success: [
      "Vše je připraveno.",
      "Heslo je nastaveno. Vraťte se do aplikace a připojte službu.",
    ],
    expired: [
      "Odkaz už neplatí.",
      "Platnost odkazu vypršela nebo už byl použit. Vyžádejte si nový od správce.",
    ],
    defaultService: "Pracovní nástroje",
    defaultClient: "Aplikace",
    usernameLabel: "Uživatelské jméno nebo e-mail",
    usernamePlaceholder: "jméno nebo e-mail",
    passwordLabel: "Heslo",
    newPasswordLabel: "Nové heslo",
    confirmLabel: "Zopakujte heslo",
    reveal: "Zobrazit",
    forgot: "Zapomněli jste heslo?",
    signIn: "Přihlásit se",
    noAccess: "Nemáte přístup?",
    contactAdmin: "Obraťte se na správce.",
    passwordHint: "Alespoň 15 znaků. Heslo si můžete uložit do správce hesel.",
    setPassword: "Nastavit heslo",
    consentRequest: "{client} žádá o přístup ke službě {service}.",
    consentTools: "Používat nástroje a data služby v rozsahu vašich oprávnění",
    consentRefresh: "Automaticky obnovovat připojení nejvýše 90 dní",
    consentLegal: "Aplikace nedostane vaše heslo. Přístup může správce odebrat.",
    connectionDetails: "Podrobnosti připojení",
    redirectLabel: "Návratová adresa:",
    allow: "Povolit přístup",
    deny: "Odmítnout",
    helpText:
      "Správce vám po ověření totožnosti poskytne jednorázový odkaz pro nastavení nového hesla. Heslo neposílejte e-mailem ani do chatu.",
    adminContact: "Kontaktujte svého správce pracovních nástrojů {product}.",
    closeWindow: "Toto okno můžete zavřít.",
    previewNote: "Ukázka rozhraní. Nepoužívejte skutečné přihlašovací údaje.",
    previewNav: "Ukázky stavů",
    previewLabels: [
      "Přihlášení",
      "Nové heslo",
      "Souhlas",
      "Pomoc",
      "Hotovo",
      "Vypršelo",
    ],
    skip: "Přeskočit na přihlášení",
    topNote: "Přístup k pracovním nástrojům",
    asideLabel: "{product} pracovní nástroje",
    asideTitle: "Právní nástroje.\nJeden přístup.",
    asideText: "Vaše služby {product}.\nPod jedním bezpečným účtem.",
    footer: "© {year} {product}",
    footerNote: "Soukromé pracovní prostředí",
    privacy: "Ochrana soukromí",
    terms: "Podmínky používání",
  },
  en: {
    login: ["Welcome back.", "Sign in with your {product} account."],
    activate: ["Your new access.", "Set a password for your work tools."],
    consent: [
      "Allow access?",
      "Check which service the application is connecting to.",
    ],
    help: ["Need help?", "Access is restored by your {product} administrator."],
    success: [
      "All set.",
      "Your password is set. Return to the application and connect the service.",
    ],
    expired: [
      "This link is no longer valid.",
      "The link has expired or was already used. Ask your administrator for a new one.",
    ],
    defaultService: "Work tools",
    defaultClient: "Application",
    usernameLabel: "Username or email",
    usernamePlaceholder: "name or email",
    passwordLabel: "Password",
    newPasswordLabel: "New password",
    confirmLabel: "Repeat password",
    reveal: "Show",
    forgot: "Forgot your password?",
    signIn: "Sign in",
    noAccess: "No access yet?",
    contactAdmin: "Contact your administrator.",
    passwordHint:
      "At least 15 characters. You can save the password in a password manager.",
    setPassword: "Set password",
    consentRequest: "{client} requests access to {service}.",
    consentTools: "Use the service's tools and data within your permissions",
    consentRefresh: "Renew the connection automatically for up to 90 days",
    consentLegal:
      "The application never receives your password. Your administrator can revoke access.",
    connectionDetails: "Connection details",
    redirectLabel: "Return address:",
    allow: "Allow access",
    deny: "Deny",
    helpText:
      "After verifying your identity, your administrator gives you a one-time link to set a new password. Never send a password by email or chat.",
    adminContact: "Contact your {product} work tools administrator.",
    closeWindow: "You can close this window.",
    previewNote: "Interface preview. Do not use real credentials.",
    previewNav: "State previews",
    previewLabels: [
      "Sign in",
      "New password",
      "Consent",
      "Help",
      "Done",
      "Expired",
    ],
    skip: "Skip to sign in",
    topNote: "Access to work tools",
    asideLabel: "{product} work tools",
    asideTitle: "Legal tools.\nOne access.",
    asideText: "Your {product} services.\nUnder one secure account.",
    footer: "© {year} {product}",
    footerNote: "Private work environment",
    privacy: "Privacy",
    terms: "Terms of use",
  },
  de: {
    login: ["Willkommen zurück.", "Melden Sie sich mit Ihrem {product}-Konto an."],
    activate: [
      "Ihr neuer Zugang.",
      "Legen Sie ein Passwort für Ihre Arbeitswerkzeuge fest.",
    ],
    consent: [
      "Zugriff erlauben?",
      "Prüfen Sie, mit welchem Dienst sich die Anwendung verbindet.",
    ],
    help: [
      "Brauchen Sie Hilfe?",
      "Den Zugang stellt Ihr {product}-Administrator wieder her.",
    ],
    success: [
      "Alles ist bereit.",
      "Das Passwort ist festgelegt. Kehren Sie zur Anwendung zurück und verbinden Sie den Dienst.",
    ],
    expired: [
      "Dieser Link ist nicht mehr gültig.",
      "Der Link ist abgelaufen oder wurde bereits verwendet. Fordern Sie bei Ihrem Administrator einen neuen an.",
    ],
    defaultService: "Arbeitswerkzeuge",
    defaultClient: "Anwendung",
    usernameLabel: "Benutzername oder E-Mail",
    usernamePlaceholder: "Name oder E-Mail",
    passwordLabel: "Passwort",
    newPasswordLabel: "Neues Passwort",
    confirmLabel: "Passwort wiederholen",
    reveal: "Anzeigen",
    forgot: "Passwort vergessen?",
    signIn: "Anmelden",
    noAccess: "Noch keinen Zugang?",
    contactAdmin: "Wenden Sie sich an Ihren Administrator.",
    passwordHint:
      "Mindestens 15 Zeichen. Sie können das Passwort in einem Passwort-Manager speichern.",
    setPassword: "Passwort festlegen",
    consentRequest: "{client} bittet um Zugriff auf den Dienst {service}.",
    consentTools:
      "Werkzeuge und Daten des Dienstes im Rahmen Ihrer Berechtigungen nutzen",
    consentRefresh: "Die Verbindung höchstens 90 Tage automatisch erneuern",
    consentLegal:
      "Die Anwendung erhält Ihr Passwort nicht. Ihr Administrator kann den Zugriff entziehen.",
    connectionDetails: "Verbindungsdetails",
    redirectLabel: "Rücksprungadresse:",
    allow: "Zugriff erlauben",
    deny: "Ablehnen",
    helpText:
      "Nach der Prüfung Ihrer Identität gibt Ihnen Ihr Administrator einen einmaligen Link zum Festlegen eines neuen Passworts. Senden Sie Passwörter nie per E-Mail oder Chat.",
    adminContact:
      "Wenden Sie sich an den Administrator Ihrer {product}-Arbeitswerkzeuge.",
    closeWindow: "Sie können dieses Fenster schließen.",
    previewNote: "Vorschau der Oberfläche. Keine echten Zugangsdaten verwenden.",
    previewNav: "Vorschau der Zustände",
    previewLabels: [
      "Anmeldung",
      "Neues Passwort",
      "Zustimmung",
      "Hilfe",
      "Fertig",
      "Abgelaufen",
    ],
    skip: "Zur Anmeldung springen",
    topNote: "Zugang zu Arbeitswerkzeugen",
    asideLabel: "{product} Arbeitswerkzeuge",
    asideTitle: "Juristische Werkzeuge.\nEin Zugang.",
    asideText: "Ihre {product}-Dienste.\nUnter einem sicheren Konto.",
    footer: "© {year} {product}",
    footerNote: "Private Arbeitsumgebung",
    privacy: "Datenschutz",
    terms: "Nutzungsbedingungen",
  },
};

export interface BrandFont {
  file: string;
  family: string;
  weight?: string;
}
export interface BrandColors {
  primary: string;
  primaryDeep: string;
  accent: string;
  ink: string;
  surface: string;
  line: string;
}
export interface Brand {
  /** Real path of the pack directory. */
  dir: string;
  productName: string;
  accountLabel: string;
  locale: Locale;
  /** Built-in catalog for the locale with the pack's overrides applied. */
  texts: Texts;
  /** Paths relative to the pack, served under /assets/ with the same path. */
  assets: {
    logo: string;
    logoSize: { width: number; height: number };
    logoDark?: string;
    mark?: string;
    artwork?: string;
    fonts: BrandFont[];
    tokens: string;
    extra: string[];
  };
  /** Validated now; the page styles still come from tokens. */
  colors?: BrandColors;
  links: { privacy?: string; terms?: string };
  /** Allowlist of servable files: path under /assets/ to the real file. */
  files: Map<string, string>;
}

const maxAssetBytes = 512 * 1024;
// Shared, brand-independent files in public/ keep their names.
const reservedAssets = new Set(["auth.css", "auth.js", "brand.json"]);
const colorKeys: (keyof BrandColors)[] = [
  "primary",
  "primaryDeep",
  "accent",
  "ink",
  "surface",
  "line",
];
const fail = (reason: string): never => {
  throw new Error(`Invalid brand pack: ${reason}`);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function text(value: unknown, name: string, max = 500): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value)
  )
    fail(`${name} must be a non-empty text up to ${max} characters`);
  return value as string;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`unknown field ${where}${key}`);
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
// Contrast of white button text on the given background, WCAG 2 formula.
export const contrastWithWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

function checkSvg(body: string, name: string) {
  if (!/<svg[\s>]/i.test(body)) fail(`${name} is not an SVG image`);
  if (/<script[\s>/]/i.test(body)) fail(`${name} contains a script element`);
  if (/<foreignObject[\s>/]/i.test(body))
    fail(`${name} contains a foreignObject element`);
  if (/\son[a-z]+\s*=/i.test(body)) fail(`${name} contains an event handler attribute`);
  if (/<!ENTITY/i.test(body)) fail(`${name} declares XML entities`);
  if (/javascript:/i.test(body)) fail(`${name} contains a javascript: URL`);
}
function checkCss(body: string, name: string) {
  if (/@import/i.test(body)) fail(`${name} must not use @import`);
  if (/url\(\s*["']?\s*(?!data:)(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(body))
    fail(`${name} must not load external URLs`);
}

/** Reads and validates a brand pack directory. Throws "Invalid brand pack: <reason>". */
export function loadBrand(dir: string): Brand {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    return fail(`directory ${dir} does not exist`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, "brand.json"), "utf8"));
  } catch (error) {
    return fail(`brand.json is missing or not JSON (${(error as Error).message})`);
  }
  if (!isObject(raw)) return fail("brand.json must be an object");
  onlyKeys(
    raw,
    ["productName", "accountLabel", "locale", "texts", "assets", "colors", "links"],
    "",
  );
  const productName = text(raw.productName, "productName", 80);
  const accountLabel = text(raw.accountLabel, "accountLabel", 80);
  const locale = raw.locale as Locale;
  if (!locales.includes(locale))
    fail(`locale must be one of ${locales.join(", ")}`);

  const texts: Texts = structuredClone(catalogs[locale]);
  if (raw.texts !== undefined) {
    if (!isObject(raw.texts)) fail("texts must be an object");
    for (const [key, value] of Object.entries(raw.texts as object)) {
      if (!Object.hasOwn(texts, key) || key === "previewLabels")
        fail(`unknown text ${key}`);
      if ((pageStates as string[]).includes(key)) {
        if (!Array.isArray(value) || value.length !== 2)
          fail(`texts.${key} must be [title, subtitle]`);
        (texts as unknown as Record<string, unknown>)[key] = [
          text(value[0], `texts.${key}[0]`),
          text(value[1], `texts.${key}[1]`),
        ];
      } else
        (texts as unknown as Record<string, unknown>)[key] = text(
          value,
          `texts.${key}`,
        );
    }
  }

  const files = new Map<string, string>();
  const asset = (value: unknown, name: string, kind: "svg" | "woff2" | "css") => {
    if (typeof value !== "string" || !value) return fail(`${name} must be a file path`);
    const parts = value.split("/");
    if (
      isAbsolute(value) ||
      value.includes("\\") ||
      parts.some((p) => p === ".." || p === "." || p === "")
    )
      fail(`${name} (${value}) is outside the pack`);
    if (parts.some((p) => p.startsWith(".")) || !/^[A-Za-z0-9._/-]+$/.test(value))
      fail(`${name} (${value}) must use letters, digits, dot, dash, underscore and slash`);
    if (reservedAssets.has(value)) fail(`${name} (${value}) uses a reserved name`);
    if (!value.toLowerCase().endsWith(`.${kind}`))
      fail(`${name} (${value}) must be a .${kind} file`);
    let real: string;
    try {
      real = realpathSync(join(root, value));
    } catch {
      return fail(`${name} (${value}) does not exist`);
    }
    if (!real.startsWith(root + sep)) fail(`${name} (${value}) is outside the pack`);
    if (!lstatSync(real).isFile() || !statSync(real).isFile())
      fail(`${name} (${value}) is not a file`);
    if (statSync(real).size > maxAssetBytes)
      fail(`${name} (${value}) is larger than 512 KiB`);
    const body = readFileSync(real);
    if (kind === "svg") checkSvg(body.toString("utf8"), name);
    if (kind === "css") checkCss(body.toString("utf8"), name);
    if (kind === "woff2" && body.subarray(0, 4).toString("latin1") !== "wOF2")
      fail(`${name} (${value}) is not a woff2 font`);
    files.set(value, real);
    return value;
  };

  if (!isObject(raw.assets)) return fail("assets must be an object");
  const a = raw.assets;
  onlyKeys(
    a,
    ["logo", "logoSize", "logoDark", "mark", "artwork", "fonts", "tokens", "extra"],
    "assets.",
  );
  const logoSize = { width: 224, height: 42 };
  if (a.logoSize !== undefined) {
    const s = a.logoSize;
    if (!isObject(s)) return fail("assets.logoSize must be an object");
    if (
      !Number.isInteger(s.width) ||
      !Number.isInteger(s.height) ||
      (s.width as number) < 1 ||
      (s.width as number) > 1024 ||
      (s.height as number) < 1 ||
      (s.height as number) > 1024
    )
      fail("assets.logoSize must be { width, height } in whole pixels up to 1024");
    Object.assign(logoSize, { width: s.width, height: s.height } as typeof logoSize);
  }
  const optional = (key: string) =>
    a[key] === undefined ? undefined : asset(a[key], `assets.${key}`, "svg");
  if (!Array.isArray(a.fonts)) fail("assets.fonts must be a list");
  const fonts = (a.fonts as unknown[]).map((f, i): BrandFont => {
    if (!isObject(f)) return fail(`assets.fonts[${i}] must be an object`);
    onlyKeys(f, ["file", "family", "weight"], `assets.fonts[${i}].`);
    const family = text(f.family, `assets.fonts[${i}].family`, 80);
    if (/["\\;{}]/.test(family)) fail(`assets.fonts[${i}].family has invalid characters`);
    const font: BrandFont = {
      file: asset(f.file, `assets.fonts[${i}].file`, "woff2"),
      family,
    };
    if (f.weight !== undefined) {
      if (typeof f.weight !== "string" || !/^\d{3}( \d{3})?$/.test(f.weight))
        fail(`assets.fonts[${i}].weight must look like "400" or "400 700"`);
      font.weight = f.weight as string;
    }
    return font;
  });
  if (a.extra !== undefined && !Array.isArray(a.extra))
    fail("assets.extra must be a list");
  const assets: Brand["assets"] = {
    logo: asset(a.logo, "assets.logo", "svg"),
    logoSize,
    logoDark: optional("logoDark"),
    mark: optional("mark"),
    artwork: optional("artwork"),
    fonts,
    tokens: asset(a.tokens, "assets.tokens", "css"),
    extra: ((a.extra as unknown[]) || []).map((v, i) =>
      asset(v, `assets.extra[${i}]`, "svg"),
    ),
  };

  let colors: BrandColors | undefined;
  if (raw.colors !== undefined) {
    if (!isObject(raw.colors)) return fail("colors must be an object");
    onlyKeys(raw.colors, colorKeys, "colors.");
    colors = {} as BrandColors;
    for (const key of colorKeys) {
      const value = raw.colors[key];
      if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value))
        fail(`colors.${key} must be a hex color like #1A2B3C`);
      colors[key] = value as string;
    }
    if (contrastWithWhite(colors.primary) < 4.5)
      fail("colors.primary needs a contrast of at least 4.5:1 against white button text");
  }

  const links: Brand["links"] = {};
  if (raw.links !== undefined) {
    if (!isObject(raw.links)) return fail("links must be an object");
    onlyKeys(raw.links, ["privacy", "terms"], "links.");
    for (const key of ["privacy", "terms"] as const) {
      const value = raw.links[key];
      if (value === undefined) continue;
      let url: URL | undefined;
      try {
        url = new URL(String(value));
      } catch {
        url = undefined;
      }
      if (typeof value !== "string" || value.length > 2048 || url?.protocol !== "https:")
        fail(`links.${key} must be an https URL`);
      links[key] = value as string;
    }
  }
  return {
    dir: root,
    productName,
    accountLabel,
    locale,
    texts,
    assets,
    colors,
    links,
    files,
  };
}

// The pack shipped with this repository; resolved from the build output, not the working directory.
export const defaultBrandDir = fileURLToPath(new URL("../brand/default/", import.meta.url));
let defaultPack: Brand | undefined;
export const defaultBrand = () => (defaultPack ??= loadBrand(defaultBrandDir));
