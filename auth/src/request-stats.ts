import type { Request, Response, NextFunction } from "express";

// Paths are reported only from this list: others (e.g. /activate/:token) carry secrets.
const knownPaths = [
  "/token",
  "/token/revocation",
  "/resource/introspect",
  "/reg",
  "/auth",
  "/jwks",
];
const pathGroup = (path: string) =>
  knownPaths.includes(path)
    ? path
    : path.startsWith("/.well-known/")
      ? "/.well-known"
      : path.startsWith("/interaction/")
        ? "/interaction"
        : "other";

// One aggregate log line per minute; client ids are truncated and no tokens are logged.
export function requestStats(intervalMs = 60000) {
  let counts = new Map<string, number>();
  const timer = setInterval(() => {
    if (!counts.size) return;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    console.log(
      JSON.stringify({ event: "auth_requests_per_minute", counts: Object.fromEntries(top) }),
    );
    counts = new Map();
  }, intervalMs);
  timer.unref();
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    res.once("finish", () => {
      const body = req.body as Record<string, unknown> | undefined;
      const clientId = body?.client_id ?? req.query.client_id;
      const key = [
        req.method,
        pathGroup(new URL(req.originalUrl, "http://local").pathname),
        res.statusCode,
        typeof clientId === "string" ? clientId.slice(0, 8) : "-",
      ].join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    next();
  };
  return { middleware, stop: () => clearInterval(timer) };
}
