import { describe, expect, it, vi } from "vitest";
import { GasBudget } from "../src/budget.js";
import { loadConfig } from "../src/config.js";
import { NonceManager } from "../src/nonce.js";
import { mapLimit, withTimeout, TimeoutError } from "../src/util.js";
import { loadAccounts } from "../src/wallets.js";

const A = "0x0000000000000000000000000000000000000001" as const;

describe("NonceManager", () => {
  it("hands out sequential nonces to concurrent senders without refetching", async () => {
    const client = { getTransactionCount: vi.fn().mockResolvedValue(5) };
    const nm = new NonceManager(client as never);
    const got = await Promise.all(Array.from({ length: 10 }, () => nm.use(A, async (n) => n)));
    expect(got.sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(client.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it("does not burn a nonce when the send fails", async () => {
    const client = { getTransactionCount: vi.fn().mockResolvedValue(3) };
    const nm = new NonceManager(client as never);
    await expect(nm.use(A, async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(await nm.use(A, async (n) => n)).toBe(3);
  });
});

describe("GasBudget", () => {
  it("reserves worst case so concurrent sends cannot overshoot", () => {
    let spent = 0n;
    const b = new GasBudget(100n, () => spent);
    expect(b.tryReserve(60n)).toBe(true);
    expect(b.tryReserve(60n)).toBe(false);
    b.release(60n);
    spent = 30n;
    expect(b.tryReserve(60n)).toBe(true);
    expect(b.tryReserve(20n)).toBe(false);
  });
});

describe("util", () => {
  it("mapLimit caps concurrency and keeps order", async () => {
    let live = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });

  it("withTimeout rejects hung promises", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "x")).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("config & wallets", () => {
  it("derives N wallets from a mnemonic and de-duplicates with explicit keys", () => {
    const mnemonic = "test test test test test test test test test test test junk";
    const cfg = loadConfig({ MNEMONIC: mnemonic, WALLET_COUNT: "15" });
    const accts = loadAccounts(cfg);
    expect(accts).toHaveLength(15);
    expect(accts[0].address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("refuses live mode without wallets and rejects bad keys", () => {
    expect(() => loadConfig({ DRY_RUN: "false" })).toThrow(/wallets/);
    expect(() => loadConfig({ PRIVATE_KEYS: "0x1234" })).toThrow(/Invalid private key/);
  });

  it("accepts comma, space or newline separated keys and RPC URLs", () => {
    const cfg = loadConfig({ RPC_URLS: "https://a.example, https://b.example\nhttps://c.example" });
    expect(cfg.rpcUrls).toHaveLength(3);
  });
});
