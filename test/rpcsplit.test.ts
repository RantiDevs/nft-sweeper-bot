import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { makeClients } from "../src/rpc.js";

const cfg = (env: Record<string, string> = {}) => loadConfig({ DRY_RUN: "true", ...env }, { requireWallets: false });

describe("watch and action RPC split", () => {
  it("uses one client for everything when no action URL is set", () => {
    const c = makeClients(cfg());
    expect(c.watchClient).toBe(c.publicClient);
  });

  it("uses a separate client for actions when ACTION_RPC_URLS is set", () => {
    const c = makeClients(cfg({ ACTION_RPC_URLS: "https://rpc.example/key123" }));
    expect(c.watchClient).not.toBe(c.publicClient);
  });

  it("reads several action URLs from one line", () => {
    expect(cfg({ ACTION_RPC_URLS: "https://a.example/1, https://b.example/2" }).actionRpcUrls).toEqual(["https://a.example/1", "https://b.example/2"]);
    expect(cfg().actionRpcUrls).toEqual([]);
  });

  it("sends action traffic to the action URL first and falls back to the watch endpoint", async () => {
    const hits: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      hits.push(String(url));
      if (String(url).includes("action.example")) throw new Error("provider down");
      return new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "0x1237" }]), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const c = makeClients(cfg({ ACTION_RPC_URLS: "https://action.example/key", RPC_URLS: "https://watch.example/rpc", RPC_TIMEOUT_MS: "500" }));
      await c.publicClient.getChainId().catch(() => {});
      expect(hits.some((h) => h.includes("action.example"))).toBe(true);
      expect(hits.some((h) => h.includes("watch.example"))).toBe(true); // the backup was tried when the provider failed
      hits.length = 0;
      await c.watchClient.getChainId().catch(() => {});
      expect(hits.every((h) => h.includes("watch.example"))).toBe(true); // watching never touches the metered provider
    } finally {
      globalThis.fetch = real;
    }
  });
});
