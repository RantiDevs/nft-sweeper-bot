import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { chainFor } from "./chain.js";
import type { Config } from "./config.js";

/**
 * HTTP transport with per-request timeout and retries. Multiple RPC URLs are
 * wrapped in a fallback transport that ranks endpoints by latency/stability
 * and fails over automatically when one errors or stalls.
 */
export function makeTransport(cfg: Config): Transport {
  const opts = { timeout: cfg.rpcTimeoutMs, retryCount: 3, retryDelay: 250 };
  if (cfg.rpcUrls.length <= 1) return http(cfg.rpcUrls[0], opts);
  return fallback(
    cfg.rpcUrls.map((u) => http(u, opts)),
    { rank: { interval: 10_000 }, retryCount: 2 },
  );
}

export function makeClients(cfg: Config) {
  const chain = chainFor(cfg.chainId);
  if (cfg.rpcUrls.length === 0 && chain.rpcUrls.default.http.length === 0) {
    throw new Error(`Chain ${chain.id} has no default RPC; set RPC_URLS`);
  }
  const transport = makeTransport(cfg);
  const publicClient = createPublicClient({
    chain,
    transport,
    batch: { multicall: true },
    pollingInterval: cfg.receiptPollMs,
  }) as PublicClient;
  return { chain, transport, publicClient };
}
