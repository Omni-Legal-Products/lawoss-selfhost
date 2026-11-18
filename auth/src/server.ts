import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { requestStats } from "./request-stats.js";
import Provider, { errors, type JWKS } from "oidc-provider";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store, hash } from "./store.js";
import { renderPage, type PageOptions } from "./ui.js";
import { defaultBrand, loadBrand, type Brand } from "./brand.js";
import { refreshReplay } from "./refresh-replay.js";
export interface Resource {
  name: string;
  scope: string;
  secretHash: string;
}
export interface Config {
  origin: string;
  dataDir: string;
  cookieKeys: string[];
  jwks: JWKS;
  resources: Record<string, Resource>;
  allowInsecureForTests?: boolean;
  redirectUris?: string[];
  refreshReuseGraceMs?: number;
  /** Brand pack directory; absent means the pack in brand/default. */
  brand?: string;
  bootstrap?: {
    username: string;
    resources: Record<string, string>;
    invitationHash: string;
    expires: number;
  };
}
const denied = () => Object.assign(new Error("Unauthorized"), { status: 401 });
const random = () => randomBytes(32).toString("base64url");
// Introspection rechecks the grant and account on every request, so revocation stays immediate.
const accessTokenTTL = 3600;
// OAuth clients parse error bodies as JSON; the limiter's default plain text breaks token refresh.
const oauthLimitResponse = {
  error: "temporarily_unavailable",
  error_description: "Too many requests, retry later",
};
// Static discovery documents are fetched by every client on every connect, and every
// resource server introspects from one shared IP; a 429 there turns into a 401 for the user.
// The token endpoint has its own per-client limit: local clients and servers share one NAT IP.
const bypassesIpLimit = (req: Request) =>
  req.path.startsWith("/.well-known/") ||
  req.path === "/jwks" ||
  req.path === "/resource/introspect" ||
  req.path === "/token";
const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? "");
const clientKey = (req: Request) => {
  const clientId = (req.body as Record<string, unknown> | undefined)?.client_id;
  return typeof clientId === "string" && clientId.length <= 256
    ? `client:${clientId}`
    : `ip:${ipKey(req)}`;
};
const equals = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
export function createAuth(config: Config) {
  const { origin, resources } = config;
  if (config.brand !== undefined && typeof config.brand !== "string")
    throw new Error("Invalid brand pack: brand must be a directory path");
  const brand: Brand =
    config.brand === undefined ? defaultBrand() : loadBrand(resolve(config.brand));
  const insecure = config.allowInsecureForTests === true;
  if (
    new URL(origin).origin !== origin ||
    (!insecure && !origin.startsWith("https://")) ||
    config.cookieKeys.some((k) => k.length < 32) ||
    !config.cookieKeys.length ||
    !config.jwks.keys.length
  )
    throw new Error("Valid origin and persistent keys required");
  if (
    !Object.keys(resources).length ||
    Object.entries(resources).some(
      ([url, r]) =>
        new URL(url).protocol !== "https:" ||
        !r.name ||
        !r.scope ||
        !/^\w{64}$/.test(r.secretHash),
    )
  )
    throw new Error("Invalid resources");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", insecure ? false : 1);
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(origin).host) return res.sendStatus(421);
    if (!insecure) {
      if (req.headers["x-forwarded-proto"] !== "https")
        return res.sendStatus(400);
      req.headers["x-forwarded-host"] = new URL(origin).host;
    }
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  const assetOptions = { immutable: true, maxAge: 86400000 };
  app.use("/assets", express.static("public", assetOptions));
  // Only files declared in brand.json are served from the pack, never brand.json itself.
  const brandAssets = express.static(brand.dir, assetOptions);
  app.use("/assets", (req, res, next) =>
    brand.files.has(req.path.slice(1)) ? brandAssets(req, res, next) : next(),
  );
  const stats = requestStats();
  app.use(stats.middleware);
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      version: "0.2.0",
      revision: process.env.SOURCE_REVISION || "development",
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: bypassesIpLimit,
      message: oauthLimitResponse,
    }),
  );
  const store = new Store(config.dataDir);
  if (config.bootstrap && !store.list().length) {
    const b = config.bootstrap;
    if (
      !/^[a-f0-9]{64}$/.test(b.invitationHash) ||
      !Number.isFinite(b.expires) ||
      b.expires <= Date.now() / 1000 ||
      Object.keys(b.resources).some((r) => !Object.hasOwn(resources, r))
    )
      throw new Error("Invalid first-run invitation");
    const invite = store.invite(b.username, b.resources);
    store.db
      .prepare("UPDATE invitations SET hash=?,expires=? WHERE memberId=?")
      .run(b.invitationHash, b.expires, invite.memberId);
  }
  const csrfStore = store.adapter("FormCSRF");
  const provider = new Provider(origin, {
    adapter: (model) => store.adapter(model),
    jwks: config.jwks,
    cookies: {
      keys: config.cookieKeys,
      long: { secure: !insecure, sameSite: "lax" },
      short: { secure: !insecure, sameSite: "lax" },
    },
    clients: [],
    responseTypes: ["code"],
    scopes: [
      "openid",
      "offline_access",
      ...new Set(Object.values(resources).flatMap((r) => r.scope.split(" "))),
    ],
    claims: { openid: ["sub"] },
    clientDefaults: {
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => {
          throw new errors.InvalidTarget("Explicit resource required");
        },
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (!Object.hasOwn(resources, resource))
            throw new errors.InvalidTarget();
          return {
            scope: resources[resource].scope,
            audience: resource,
            accessTokenFormat: "opaque",
            accessTokenTTL,
          };
        },
      },
    },
    extraClientMetadata: {
      properties: ["skallars_policy"],
      validator: (_ctx, _key, _value, metadata) => {
        if (
          metadata.sector_identifier_uri ||
          metadata.jwks_uri ||
          metadata.token_endpoint_auth_method !== "none" ||
          metadata.response_types?.some((v) => v !== "code")
        )
          throw new errors.InvalidClientMetadata("Unsupported client metadata");
        if (
          metadata.redirect_uris?.some((uri) => {
            if (config.redirectUris?.includes(uri)) return false;
            const u = new URL(uri);
            return (
              u.protocol !== "http:" ||
              !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname) ||
              !!u.username ||
              !!u.password ||
              !!u.hash
            );
          })
        )
          throw new errors.InvalidClientMetadata(
            "Only loopback or explicitly registered callbacks accepted",
          );
      },
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: async (_ctx, id) =>
      store.activeAccount(id)
        ? { accountId: id, claims: async () => ({ sub: id }) }
        : undefined,
    // MCP clients may omit OIDC offline_access; explicit consent still permits bounded renewal.
    issueRefreshToken: async (_ctx, client) =>
      client.grantTypeAllowed("refresh_token"),
    expiresWithSession: () => false,
    rotateRefreshToken: true,
    ttl: {
      AccessToken: accessTokenTTL,
      IdToken: 300,
      AuthorizationCode: 60,
      RefreshToken: (_ctx, token) =>
        Math.max(
          1,
          Math.min(
            90 * 86400,
            (token.iiat || Math.floor(Date.now() / 1000)) +
              90 * 86400 -
              Math.floor(Date.now() / 1000),
          ),
        ),
      Session: 30 * 86400,
      Interaction: 600,
      Grant: 90 * 86400,
    },
    renderError: async (ctx) => {
      ctx.type = "html";
      ctx.body = renderPage({ state: "expired" }, brand);
    },
  });
  provider.proxy = !insecure;
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer: origin,
      authorization_endpoint: origin + "/auth",
      token_endpoint: origin + "/token",
      registration_endpoint: origin + "/reg",
      revocation_endpoint: origin + "/token/revocation",
      jwks_uri: origin + "/jwks",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [
        "openid",
        "offline_access",
        ...new Set(Object.values(resources).flatMap((r) => r.scope.split(" "))),
      ],
    }),
  );
  const formParser = express.urlencoded({ extended: false, limit: "8kb" });
  const formLimit = rateLimit({
    windowMs: 60000,
    limit: 12,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const secureForm = (req: Request) => {
    if (req.get("origin") !== origin) throw denied();
  };
  const page = (res: Response, o: PageOptions) =>
    res.type("html").send(renderPage(o, brand));
  const resourceOf = (params: Record<string, unknown>) => {
    const resource = params.resource;
    if (typeof resource !== "string" || !Object.hasOwn(resources, resource))
      throw denied();
    return resource;
  };
  const allowRedirect = (res: Response, uri: string) =>
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; form-action 'self' ${new URL(uri).origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
  app.use(
    "/reg",
    rateLimit({
      windowMs: 60000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: oauthLimitResponse,
    }),
  );
  app.use("/reg", (req, res, next) =>
    req.method === "POST" &&
    Number(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM objects WHERE model='Client'")
        .get()!.n,
    ) >= 1000
      ? res.status(503).json({ error: "temporarily_unavailable" })
      : next(),
  );
  app.get("/", (_req, res) => page(res, { state: "help" }));
  app.get("/help", (_req, res) => page(res, { state: "help" }));
  app.get("/activate/:token", formLimit, (req, res) => {
    const token = String(req.params.token);
    const member = store.invitation(token);
    if (!member) return page(res.status(400), { state: "expired" });
    // The one-time secret and same-origin POST protect setup; no analytics or third-party assets receive it.
    return page(res, {
      state: "activate",
      username: member.username,
      action: `/activate/${req.params.token}`,
      csrf: token,
    });
  });
  app.post("/activate/:token", formLimit, formParser, async (req, res) => {
    secureForm(req);
    const token = String(req.params.token);
    const member = store.invitation(token);
    if (
      !member ||
      typeof req.body.csrf !== "string" ||
      !equals(req.body.csrf, token)
    )
      return page(res.status(400), { state: "expired" });
    if (
      typeof req.body.password !== "string" ||
      req.body.password !== req.body.confirm ||
      !(await store.activate(token, req.body.password))
    )
      return page(res.status(400), {
        state: "activate",
        username: member.username,
        action: `/activate/${token}`,
        csrf: token,
        error: "Heslá sa musia zhodovať a mať 15 až 128 znakov.",
      });
    return page(res, { state: "success" });
  });
  app.get("/interaction/:uid", async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    if (details.uid !== req.params.uid) throw denied();
    const resource = resourceOf(details.params);
    const csrf = random();
    await csrfStore.upsert(details.uid, { extra: { csrf } }, 600);
    if (details.prompt.name === "login")
      return page(res, {
        state: "login",
        service: resources[resource].name,
        action: `/interaction/${details.uid}/login`,
        csrf,
      });
    const member = store.activeAccount(details.session?.accountId);
    if (
      details.prompt.name !== "consent" ||
      !member ||
      !Object.hasOwn(member.resources, resource)
    )
      throw denied();
    const client = await provider.Client.find(String(details.params.client_id));
    allowRedirect(res, String(details.params.redirect_uri));
    return page(res, {
      state: "consent",
      service: resources[resource].name,
      client: client?.clientName || client?.clientId,
      redirect: String(details.params.redirect_uri),
      action: `/interaction/${details.uid}/confirm`,
      csrf,
    });
  });
  async function interaction(req: Request, res: Response, prompt: string) {
    secureForm(req);
    const details = await provider.interactionDetails(req, res);
    const csrf = await csrfStore.find(details.uid);
    if (
      details.uid !== req.params.uid ||
      details.prompt.name !== prompt ||
      typeof req.body.csrf !== "string" ||
      !csrf?.extra ||
      typeof csrf.extra.csrf !== "string" ||
      !equals(req.body.csrf, csrf.extra.csrf)
    )
      throw denied();
    await csrfStore.destroy(details.uid);
    return details;
  }
  app.post(
    "/interaction/:uid/login",
    formLimit,
    formParser,
    async (req, res) => {
      const details = await interaction(req, res, "login");
      const resource = resourceOf(details.params);
      const user =
        typeof req.body.username === "string" &&
        typeof req.body.password === "string"
          ? await store.login(req.body.username, req.body.password)
          : undefined;
      if (!user || !Object.hasOwn(user.resources, resource)) {
        const csrf = random();
        await csrfStore.upsert(details.uid, { extra: { csrf } }, 600);
        return page(res.status(400), {
          state: "login",
          service: resources[resource].name,
          action: `/interaction/${details.uid}/login`,
          csrf,
          error:
            "Prihlásenie sa nepodarilo. Skontrolujte údaje alebo kontaktujte správcu.",
          username:
            typeof req.body.username === "string"
              ? req.body.username.slice(0, 254)
              : "",
        });
      }
      allowRedirect(res, String(details.params.redirect_uri));
      await provider.interactionFinished(
        req,
        res,
        {
          login: {
            accountId: store.accountId(user),
            amr: ["pwd"],
            remember: true,
          },
        },
        { mergeWithLastSubmission: false },
      );
    },
  );
  app.post(
    "/interaction/:uid/confirm",
    formLimit,
    formParser,
    async (req, res) => {
      const details = await interaction(req, res, "consent");
      const resource = resourceOf(details.params);
      const member = store.activeAccount(details.session?.accountId);
      if (!member || !Object.hasOwn(member.resources, resource)) throw denied();
      allowRedirect(res, String(details.params.redirect_uri));
      if (req.body.decision !== "allow")
        return provider.interactionFinished(
          req,
          res,
          { error: "access_denied" },
          { mergeWithLastSubmission: false },
        );
      const grant = details.grantId && !store.resourceBlocked(details.grantId, resource)
        ? await provider.Grant.find(details.grantId)
        : new provider.Grant({
            accountId: details.session!.accountId,
            clientId: String(details.params.client_id),
          });
      if (!grant) throw denied();
      const missing = details.prompt.details as {
        missingOIDCScope?: string[];
        missingOIDCClaims?: string[];
        missingResourceScopes?: Record<string, string[]>;
      };
      if (missing.missingOIDCScope)
        grant.addOIDCScope(missing.missingOIDCScope.join(" "));
      if (missing.missingOIDCClaims)
        grant.addOIDCClaims(missing.missingOIDCClaims);
      for (const [url, scopes] of Object.entries(
        missing.missingResourceScopes || {},
      )) {
        if (url !== resource) throw denied();
        grant.addResourceScope(url, scopes.join(" "));
      }
      await provider.interactionFinished(
        req,
        res,
        { consent: { grantId: await grant.save() } },
        { mergeWithLastSubmission: true },
      );
    },
  );
  app.get("/auth", (req, res, next) => {
    const url = new URL(req.originalUrl, origin);
    if (
      url.searchParams.get("scope")?.split(" ").includes("offline_access") &&
      !url.searchParams.has("prompt")
    ) {
      url.searchParams.set("prompt", "consent");
      return res.redirect(303, url.pathname + url.search);
    }
    next();
  });
  // Flood guard only: the service secret is checked before any lookup.
  const introspectLimit = rateLimit({
    windowMs: 60000,
    limit: 6000,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: oauthLimitResponse,
  });
  app.post(
    "/resource/introspect",
    introspectLimit,
    formParser,
    async (req, res) => {
      const resource = req.body.resource;
      const authorization = req.get("authorization");
      if (
        typeof resource !== "string" ||
        !Object.hasOwn(resources, resource) ||
        typeof authorization !== "string" ||
        !authorization.startsWith("Bearer ") ||
        !equals(hash(authorization.slice(7)), resources[resource].secretHash)
      )
        return res.sendStatus(401);
      const raw = req.body.token;
      if (typeof raw !== "string" || raw.length > 4096)
        return res.json({ active: false });
      const token = await provider.AccessToken.find(raw);
      const member = store.activeAccount(token?.accountId);
      if (
        !token ||
        !member ||
        token.aud !== resource ||
        !token.grantId ||
        !member.resources[resource]
      )
        return res.json({ active: false });
      const grant = await provider.Grant.find(token.grantId);
      if (
        !grant ||
        grant.accountId !== token.accountId ||
        grant.clientId !== token.clientId ||
        !resources[resource].scope.split(" ").every((s) => token.scopes.has(s))
      )
        return res.json({ active: false });
      return res.json({
        active: true,
        iss: origin,
        sub: member.id,
        tenant: member.resources[resource],
        aud: resource,
        scope: [...token.scopes].join(" "),
        exp: token.exp,
      });
    },
  );
  // Replayed concurrent refreshes are answered before these limits and never consume them.
  app.post(
    "/token",
    formParser,
    refreshReplay(config.refreshReuseGraceMs ?? 60000),
    rateLimit({
      windowMs: 60000,
      limit: 1200,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: ipKey,
      message: oauthLimitResponse,
    }),
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: clientKey,
      message: oauthLimitResponse,
    }),
  );
  app.use(provider.callback());
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (!res.headersSent)
        page(
          res.status(
            error instanceof Error && "status" in error && error.status === 429
              ? 429
              : 400,
          ),
          { state: "expired" },
        );
    },
  );
  return {
    app,
    brand,
    provider,
    store,
    close: () => {
      stats.stop();
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const raw =
    process.env.AUTH_CONFIG_JSON ||
    (process.env.AUTH_CONFIG
      ? readFileSync(process.env.AUTH_CONFIG, "utf8")
      : undefined);
  if (!raw) throw new Error("AUTH_CONFIG or AUTH_CONFIG_JSON required");
  const config = JSON.parse(raw) as Config;
  if (config.allowInsecureForTests)
    throw new Error("Test mode is not a production option");
  const auth = createAuth(config);
  const server = auth.app.listen(
    Number(process.env.PORT || 3000),
    "0.0.0.0",
    () => console.log(`${auth.brand.productName} Auth ready`),
  );
  for (const sig of ["SIGTERM", "SIGINT"])
    process.once(sig, () =>
      server.close(() => {
        auth.close();
        process.exit(0);
      }),
    );
}
