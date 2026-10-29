import { createPublicClient, fallback, http, webSocket, type PublicClient, type Transport } from "viem";
import { chainFor } from "./chain.js";
import type { Config } from "./config.js";
import { Semaphore } from "./util.js";

/**
 * HTTP transport with per-request timeout and retries. Multiple RPC URLs are
 * wrapped in a fallback transport that ranks endpoints by latency/stability
 * and fails over automatically when one errors or stalls.
 */
export function makeTransport(cfg: Config): Transport {
  // One shared cap on in-flight requests: a free RPC answers a flood with long stalls, so the bot
  // queues its own requests instead of piling them on.
  const gate = new Semaphore(cfg.rpcMaxInflight);
  const fetchFn = ((url: unknown, init?: unknown) => gate.run(() => fetch(url as string, init as RequestInit))) as typeof fetch;
  // Public RPCs answer bursts with 429/503. Retry with growing delays (300ms, 600ms, ... ~10s)
  // instead of failing, so a rate-limited moment slows the bot down rather than stopping it.
  // Many small reads (one getTransaction per mint) are sent as JSON-RPC batches: one HTTP request
  // carries up to 25 calls, which keeps a busy chain within a public RPC's request limits.
  const opts = { timeout: cfg.rpcTimeoutMs, retryCount: 6, retryDelay: 300, batch: { batchSize: 25, wait: 15 }, fetchFn };
  if (cfg.rpcUrls.length <= 1) return http(cfg.rpcUrls[0], opts);
  return fallback(
    cfg.rpcUrls.map((u) => http(u, opts)),
    { rank: { interval: 10_000 }, retryCount: 2 },
  );
}

/**
 * Refuses to run against an RPC that serves a different chain than CHAIN_ID.
 * A wrong endpoint would otherwise watch (and mint on) the wrong network.
 */
export async function assertChain(client: PublicClient, expected: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) {
    throw new Error(`RPC reports chain ${actual} but CHAIN_ID is ${expected}; check RPC_URLS`);
  }
}

/**
 * With RPC_WS_URL set, new heads are pushed over a WebSocket and wake the watcher the
 * moment they arrive, instead of waiting for the next poll.
 */
export function makeWakeSource(cfg: Config): (wake: () => void) => void {
  return (wake) => {
    if (!cfg.rpcWsUrl) return;
    const ws = createPublicClient({ chain: chainFor(cfg.chainId), transport: webSocket(cfg.rpcWsUrl, { reconnect: true, keepAlive: { interval: 15_000 } }) });
    ws.watchBlockNumber({ onBlockNumber: () => wake(), onError: () => {}, emitOnBegin: false });  // a WebSocket transport subscribes (eth_subscribe newHeads) by default
  };
}

export function makeClients(cfg: Config) {
  const chain = chainFor(cfg.chainId);
  if (cfg.rpcUrls.length === 0 && chain.rpcUrls.default.http.length === 0) {
    throw new Error(`Chain ${chain.id} has no default RPC; set RPC_URLS`);
  }
  const make = (transport: Transport) =>
    createPublicClient({ chain, transport, batch: { multicall: true }, pollingInterval: cfg.receiptPollMs }) as PublicClient;

  // Watching: RPC_URLS (the free public endpoint by default). Acting: ACTION_RPC_URLS first, with the
  // watch endpoints as backup, so a provider hitting its quota or an outage costs speed, not the run.
  const watchTransport = makeTransport(cfg);
  if (cfg.actionRpcUrls.length === 0) {
    const watchClient = make(watchTransport);
    return { chain, transport: watchTransport, publicClient: watchClient, watchClient };
  }
  const backup = cfg.rpcUrls.length ? cfg.rpcUrls : chain.rpcUrls.default.http.slice();
  const transport = makeTransport({ ...cfg, rpcUrls: [...cfg.actionRpcUrls, ...backup] });
  return { chain, transport, publicClient: make(transport), watchClient: make(watchTransport) };
}
