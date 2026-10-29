import { describe, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { fmtUsd, fmtWei, parseMoney } from "../src/money.js";
import { EthPriceOracle, type PriceSource } from "../src/price.js";
import { Notifier } from "../src/tg/notify.js";

describe("dollar formatting", () => {
  it("shows tiny amounts with enough digits to be meaningful", () => {
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(0.5)).toBe("$0.50");
    expect(fmtUsd(0.0042)).toBe("$0.0042");
    expect(fmtUsd(0.00000123)).toBe("$0.0000012");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(-3)).toBe("-$3.00");
  });

  it("shows dollars with the ETH amount, or ETH alone without a price", () => {
    expect(fmtWei(parseEther("0.001"), 3000)).toBe("$3.00 (0.001 ETH)");
    expect(fmtWei(parseEther("0.001"), undefined)).toBe("0.001 ETH");
    expect(fmtWei(0n, 3000)).toBe("$0.00 (0 ETH)");
  });

  it("reads typed amounts as dollars unless they say ETH, rounding up", () => {
    expect(parseMoney("2", 3000)).toEqual({ ok: true, eth: "0.000666666667" });
    expect(parseMoney("$2", 3000)).toEqual({ ok: true, eth: "0.000666666667" });
    expect(parseMoney("$1,500", 3000)).toEqual({ ok: true, eth: "0.5" });
    expect(parseMoney("0.001eth", 3000)).toEqual({ ok: true, eth: "0.001" });
    expect(parseMoney("0.001 ETH", undefined)).toEqual({ ok: true, eth: "0.001" });
    expect(parseMoney("2", undefined)).toMatchObject({ ok: false, error: expect.stringMatching(/price isn.t available/) });
    for (const bad of ["abc", "", "-5", "1e3", "$"]) expect(parseMoney(bad, 3000).ok).toBe(false);
  });
});

describe("EthPriceOracle", () => {
  const src = (name: string, value: number | undefined): PriceSource => ({ name, url: `https://${name}.example/p`, parse: () => value });
  const okFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;

  it("takes the median so one bad feed cannot move the price", async () => {
    const o = new EthPriceOracle({ sources: [src("a", 3000), src("b", 3010), src("c", 9999)], fetchFn: okFetch });
    expect(await o.get()).toBe(3010);
  });

  it("works when some feeds are down, and caches the answer", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("down")) throw new Error("offline");
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const o = new EthPriceOracle({ sources: [src("down", 1), src("up", 3100)], fetchFn });
    expect(await o.get()).toBe(3100);
    await o.get();
    expect(fetchFn).toHaveBeenCalledTimes(2); // the second get() came from the cache
  });

  it("keeps the last good price when every feed fails, and uses the manual fallback before any", async () => {
    let up = true;
    const fetchFn = vi.fn(async () => {
      if (!up) throw new Error("offline");
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const o = new EthPriceOracle({ sources: [src("a", 3000)], fetchFn, ttlMs: 0, fallback: 2500 });
    expect(o.peek()).toBe(2500); // nothing fetched yet: the manual fallback
    expect(await o.get()).toBe(3000);
    up = false;
    expect(await o.get()).toBe(3000);
    expect(await new EthPriceOracle({ sources: [src("a", undefined)], fetchFn: okFetch }).get()).toBeUndefined();
  });

  it("distrusts a single feed that jumps more than 40% from the last good price", async () => {
    let value = 3000;
    const o = new EthPriceOracle({ sources: [{ name: "a", url: "https://a.example", parse: () => value }], fetchFn: okFetch, ttlMs: 0 });
    expect(await o.get()).toBe(3000);
    value = 9000;
    expect(await o.get()).toBe(3000);
    value = 3300;
    expect(await o.get()).toBe(3300);
  });
});

describe("notifications in dollars", () => {
  it("shows gas paid in dollars", () => {
    const n = new Notifier({ sendMessage: vi.fn() }, [], undefined, () => 3000);
    const text = n.format({
      type: "round", collection: "0x00000000000000000000000000000000000000c1", dryRun: false,
      minted: 1, tokens: 1, failed: 0, wouldMint: 0, skipped: 0, gasWei: parseEther("0.000002"), txs: [],
    })!;
    expect(text).toContain("Gas paid: $0.006 (0.000002 ETH)");
  });
});
