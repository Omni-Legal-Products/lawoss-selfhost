import type { Request, Response, NextFunction } from "express";
import { hash } from "./store.js";

interface Captured {
  status: number;
  contentType: string | undefined;
  body: Buffer;
}

// oidc-provider revokes the whole grant when a rotated refresh token is presented again.
// MCP clients (several processes sharing one stored token) routinely refresh concurrently,
// so identical refresh requests inside the window receive the pair the first one produced.
// The replay never mints tokens, it re-sends ones already issued; introspection rechecks the
// grant and account on every request, so revocation is unaffected. The authority runs as a
// single replica, so in-memory state is sufficient.
export function refreshReplay(windowMs: number) {
  const entries = new Map<
    string,
    { expires: number; result: Promise<Captured | undefined> }
  >();
  return (req: Request, res: Response, next: NextFunction) => {
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      (body as Record<string, unknown>).grant_type !== "refresh_token" ||
      typeof (body as Record<string, unknown>).refresh_token !== "string"
    )
      return next();
    const now = Date.now();
    for (const [k, e] of entries) if (e.expires <= now) entries.delete(k);
    const key = hash(
      JSON.stringify([
        req.get("authorization") ?? "",
        Object.entries(body).sort(([a], [b]) => (a < b ? -1 : 1)),
      ]),
    );
    const hit = entries.get(key);
    if (hit) {
      hit.result.then((captured) => {
        if (!captured) return next();
        if (captured.contentType) res.type(captured.contentType);
        res.status(captured.status).send(captured.body);
      }, next);
      return;
    }
    let settle!: (captured: Captured | undefined) => void;
    const result = new Promise<Captured | undefined>((r) => (settle = r));
    entries.set(key, { expires: now + windowMs, result });
    const chunks: Buffer[] = [];
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    const collect = (chunk: unknown, encoding: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === "function")
        return;
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(
              chunk as string,
              typeof encoding === "string"
                ? (encoding as BufferEncoding)
                : "utf8",
            ),
      );
    };
    res.write = ((...args: unknown[]) => {
      collect(args[0], args[1]);
      return write(...args);
    }) as Response["write"];
    res.end = ((...args: unknown[]) => {
      collect(args[0], args[1]);
      return end(...args);
    }) as Response["end"];
    const done = () => {
      if (res.statusCode !== 200 || !res.writableFinished) {
        entries.delete(key);
        return settle(undefined);
      }
      const contentType = res.getHeader("content-type");
      settle({
        status: res.statusCode,
        contentType: typeof contentType === "string" ? contentType : undefined,
        body: Buffer.concat(chunks),
      });
    };
    res.once("finish", done);
    res.once("close", done);
    next();
  };
}
