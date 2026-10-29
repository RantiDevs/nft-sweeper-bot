import { createServer, type Server } from "node:http";
import { log } from "./util.js";

/**
 * A tiny web endpoint, for two reasons:
 *  - Render's free web service only stays awake while it receives web traffic, and only runs a service
 *    that listens on a port. A free pinger (cron-job.org / UptimeRobot) calling /health every few
 *    minutes provides that traffic.
 *  - It tells you at a glance whether the bot is alive and watching the chain.
 *
 * It exposes nothing sensitive: no users, wallets, balances or keys.
 */

export type Health = Record<string, string | number | boolean | undefined | Record<string, string | number | boolean | undefined>>;

export function startHealthServer(port: number, status: () => Health): Promise<Server> {
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/health" || path === "/healthz") {
      let body: Health;
      try {
        body = { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), ...status() };
      } catch {
        body = { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) };
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(path === "/" && req.method === "HEAD" ? undefined : JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.requestTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      log(`health endpoint listening on port ${(server.address() as { port: number }).port}`);
      resolve(server);
    });
  });
}

/**
 * Calls the service's own public address every few minutes. While the service is awake this keeps the
 * 15-minute idle timer from ever running out; if it has already gone to sleep, only the outside pinger
 * can wake it, which is why both exist.
 */
export function startSelfPing(url: string, everyMs = 10 * 60_000, fetchFn: typeof fetch = fetch): () => void {
  const target = `${url.replace(/\/+$/, "")}/health`;
  const timer = setInterval(() => {
    void fetchFn(target, { signal: AbortSignal.timeout(15_000) }).catch(() => {});
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
