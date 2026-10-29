import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { loadConfig } from "../src/config.js";
import type { HotMint } from "../src/detector.js";
import { Session } from "../src/session.js";
import { Notifier } from "../src/tg/notify.js";
import { errMsg, Semaphore } from "../src/util.js";
import { Watcher } from "../src/watcher.js";

const C = "0x00000000000000000000000000000000000000c1" as Address;
const hot: HotMint = {
  collection: C, uniqueMinters: 3, mintTxs: 3,
  templates: [{ collection: C, txHash: `0x${"11".repeat(32)}`, blockNumber: 1n, minter: "0x3333333333333333333333333333333333333333", target: C, input: "0x1249c58b", value: 0n }],
};
const helpers = { isNft: async () => true, probe: async () => "reverts" as const, vet: async () => ({ ok: true as const }) };

function session(wallets: unknown[], extra: Record<string, string> = {}) {
  const cfg = loadConfig({ DRY_RUN: "true", CHAIN_ID: "1337", ...extra }, { requireWallets: false });
  const state = { isBad: () => false, mintCount: () => 0, markBad: vi.fn(), holdings: () => [], gasSpent: () => 0n };
  const s = new Session({
    publicClient: { getBalance: vi.fn(async () => 0n) } as unknown as PublicClient,
    feeOracle: {} as never,
    state: state as never,
    config: () => cfg,
    wallets: () => wallets as never,
  });
  return { s, state };
}

describe("a user without wallets costs nothing", () => {
  it("is not woken for mints, runs no checks, and blocks nothing", () => {
    const { s, state } = session([]);
    const vet = vi.fn(async () => ({ ok: true as const }));
    expect(s.floor()).toBeUndefined();
    s.offer([hot], { ...helpers, vet });
    expect(vet).not.toHaveBeenCalled();
    expect(state.markBad).not.toHaveBeenCalled();
    expect(s.busy).toBe(0);
  });
});

describe("collections that keep failing are looked at less and less", () => {
  it("backs off after each round that mints nothing", async () => {
    const wallet = { label: "w01", account: { address: "0x1111111111111111111111111111111111111111" }, client: {} };
    const { s } = session([wallet], { DRY_RUN: "false", PRIVATE_KEYS: `0x${"11".repeat(32)}` });
    const rounds = vi.fn(async () => ({ ok: false as const, reason: "x", retryable: true }));
    const h = { ...helpers, vet: rounds };
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    s.offer([hot], h);
    await s.drain();
    expect(rounds).toHaveBeenCalledTimes(1);
    now += 29_000; // under the 30 s base gap
    s.offer([hot], h);
    await s.drain();
    expect(rounds).toHaveBeenCalledTimes(1);
    now += 5_000; // past 30 s: due again
    s.offer([hot], h);
    await s.drain();
    expect(rounds).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});

describe("Semaphore", () => {
  it("never runs more than its limit at once", async () => {
    const gate = new Semaphore(2);
    let live = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => gate.run(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
    })));
    expect(peak).toBe(2);
  });
});

describe("error messages", () => {
  it("show the HTTP status and detail that viem hides", () => {
    const e = Object.assign(new Error("HTTP request failed."), { shortMessage: "An unknown RPC error occurred.", status: 429, details: "rate limit exceeded" });
    expect(errMsg(e)).toBe("An unknown RPC error occurred. [HTTP 429, rate limit exceeded]");
    expect(errMsg(new Error("plain"))).toBe("plain");
  });
});

describe("watcher pacing", () => {
  it("waits longer after each failed tick and resets once healthy", async () => {
    let fail = true;
    const client = {
      getBlockNumber: vi.fn(async () => 100n),
      request: vi.fn(async () => {
        if (fail) throw new Error("boom");
        return [];
      }),
    } as unknown as PublicClient;
    const w = new Watcher(client, { windowBlocks: 4, pollIntervalMs: 10 });
    w.subscribe({ wants: () => true, owns: () => false, floor: () => ({ minUniqueMinters: 1, minMintTxs: 1 }), offer: () => {} });
    const naps: number[] = [];
    (w as unknown as { napOrWake: (ms: number) => Promise<void> }).napOrWake = async (ms) => {
      naps.push(ms);
      if (naps.length === 4) fail = false;
      if (naps.length >= 6) w.stop();
    };
    await w.run();
    expect(naps[1]).toBeGreaterThan(naps[0]); // grows while failing
    expect(naps[2]).toBeGreaterThan(naps[1]);
    expect(naps[naps.length - 1]).toBe(10); // back to the normal pace once it works again
  });
});

describe("quiet Telegram", () => {
  it("does not message about gated mints, but does about an empty wallet, at most every 15 minutes", () => {
    const send = vi.fn(async () => {});
    const n = new Notifier({ sendMessage: send }, []);
    const skip = (note: string) => ({ type: "round" as const, collection: C, dryRun: true, minted: 0, tokens: 0, failed: 0, wouldMint: 0, skipped: 1, gasWei: 0n, txs: [], note });
    n.event(1, skip("simulation reverted: bad proof"));
    n.event(1, skip("simulation reverted: Ownable: caller is not the owner"));
    expect(send).not.toHaveBeenCalled();
    n.event(1, skip("balance 0 ETH < worst-case gas 0.000005"));
    n.event(1, skip("balance 0 ETH < worst-case gas 0.000005")); // within 15 minutes: swallowed
    return n.flush().then(() => expect(send).toHaveBeenCalledTimes(1));
  });
});
