import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { OpenSeaClient } from "../src/market/opensea.js";
import type { Sale } from "../src/market/sales.js";
import { snapshot } from "../src/market/stats.js";
import { assess, decide, DEFAULT_VALUATION, effectiveFloor, premiumMultiplier, type CollectionMarket } from "../src/market/valuation.js";
import { filterWash } from "../src/market/wash.js";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const C = "0x00000000000000000000000000000000000000c3" as Address;
const D = "0x00000000000000000000000000000000000000d4" as Address;
const E = "0x00000000000000000000000000000000000000e5" as Address;
const wei = (eth: number) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;

let n = 0;
const sale = (tokenId: number, from: Address, to: Address, block: number, eth: number): Sale => ({
  tokenId: String(tokenId), from, to, block: BigInt(block), tx: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, priceWei: wei(eth),
});

describe("wash trading filter", () => {
  it("removes self-trades, round trips and ping-pong pairs, keeping honest sales", () => {
    const sales = [
      sale(1, A, A, 100, 5), // self trade
      sale(2, A, B, 110, 5), sale(2, B, A, 120, 5), // round trip
      sale(3, C, D, 130, 5), sale(4, D, C, 140, 5), sale(5, C, D, 150, 5), // same pair 3 times
      sale(6, A, E, 160, 0.01), // honest
      sale(7, B, D, 170, 0.012), // honest
    ];
    const r = filterWash(sales, { roundTripBlocks: 1000 });
    expect(r.clean.map((s) => s.tokenId)).toEqual(["6", "7"]);
    expect(r.washShare).toBeCloseTo(6 / 8);
  });

  it("does not flag a token that comes back only after the round-trip window", () => {
    const r = filterWash([sale(1, A, B, 100, 1), sale(1, B, A, 5000, 1)], { roundTripBlocks: 1000 });
    expect(r.clean).toHaveLength(2);
  });
});

describe("market snapshot", () => {
  const owners = new Map<string, Address>(Array.from({ length: 20 }, (_, i) => [String(i), [A, B, C, D][i % 4]]));
  it("uses a low quantile of recent sales for the floor, not the single cheapest sale", () => {
    const prices = [0.001, 0.01, 0.011, 0.012, 0.012, 0.013, 0.014, 0.015, 0.02, 0.03];
    const sales = prices.map((p, i) => sale(i, A, [B, C, D, E][i % 4], 1000 + i, p));
    const s = snapshot({ clean: sales, washShare: 0, owners, supply: 20, headBlock: 1100n, recentBlocks: 500 });
    expect(s.salesCount).toBe(10);
    expect(s.floorEth).toBeGreaterThan(0.001); // the 0.001 outlier is not the floor
    expect(s.floorEth).toBeLessThan(0.0125);
    expect(s.uniqueBuyers).toBe(4);
    expect(s.holderRatio).toBeCloseTo(4 / 20);
    expect(s.whaleShare).toBe(1); // 4 holders: top 10 cover everything
  });

  it("measures the price trend from oldest vs newest third", () => {
    const rising = Array.from({ length: 9 }, (_, i) => sale(i, A, B, 100 + i, 0.01 * (i + 1)));
    const falling = Array.from({ length: 9 }, (_, i) => sale(i, A, B, 100 + i, 0.01 * (9 - i)));
    const opts = { washShare: 0, owners, headBlock: 200n, recentBlocks: 500 };
    expect(snapshot({ ...opts, clean: rising }).trend!).toBeGreaterThan(1);
    expect(snapshot({ ...opts, clean: falling }).trend!).toBeLessThan(-0.5);
  });
});

describe("valuation", () => {
  it("rarity premium is flat for the common half and grows toward the top", () => {
    expect(premiumMultiplier(0.9)).toBe(1);
    expect(premiumMultiplier(0.5)).toBe(1);
    expect(premiumMultiplier(0.3)).toBeGreaterThan(1);
    expect(premiumMultiplier(0.3)).toBeLessThan(1.6);
    expect(premiumMultiplier(0.1)).toBeCloseTo(1.6);
    expect(premiumMultiplier(0.01)).toBeGreaterThan(premiumMultiplier(0.05));
    expect(premiumMultiplier(0)).toBeLessThanOrEqual(DEFAULT_VALUATION.maxMultiplier);
  });

  const snap = (over: object = {}) => ({
    salesCount: 30, recentSales: 12, medianEth: 0.01, floorEth: 0.01, trend: 0.3, uniqueBuyers: 10, uniqueHolders: 200,
    holderRatio: 0.4, whaleShare: 0.1, washShare: 0, blocksSinceLastSale: 100, ...over,
  });
  const market = (over: object = {}, extra: Partial<CollectionMarket> = {}): CollectionMarket => ({ snap: snap(over), ageBlocks: 1000, ...extra });

  it("takes the lower of the listed floor and the sales floor", () => {
    expect(effectiveFloor(market({}, { opensea: { floorEth: 0.02 } }))).toBe(0.01);
    expect(effectiveFloor(market({}, { opensea: { floorEth: 0.005 } }))).toBe(0.005);
    expect(effectiveFloor(market({ floorEth: undefined }, { opensea: { floorEth: 0.02 } }))).toBe(0.02);
  });

  it("classifies collection health", () => {
    expect(assess(market()).health).toBe("ACTIVE");
    expect(assess(market({ recentSales: 1, uniqueBuyers: 1 })).health).toBe("THIN");
    expect(assess(market({ recentSales: 0, blocksSinceLastSale: DEFAULT_VALUATION.staleBlocks + 1 })).health).toBe("STALLED");
    const none = { salesCount: 0, recentSales: 0, uniqueBuyers: 0, uniqueHolders: 5, washShare: 0 };
    expect(assess({ snap: none, ageBlocks: 100 }).health).toBe("NO_MARKET");
    expect(assess({ snap: none, ageBlocks: DEFAULT_VALUATION.deadAfterBlocks + 1 }).health).toBe("DEAD");
  });

  it("lowers the score for wash trading and whale concentration", () => {
    const clean = assess(market()).score;
    expect(assess(market({ washShare: 0.6 })).score).toBeLessThan(clean - 15);
    expect(assess(market({ whaleShare: 0.8 })).score).toBeLessThan(clean);
  });

  it("holds only rare tokens in healthy, valuable collections; sells the rest", () => {
    const ethUsd = 3000;
    const healthy = assess(market({ floorEth: 0.01 }));
    const rare = decide({ assessment: healthy, percentile: 0.02, ethUsd });
    expect(rare.action).toBe("HOLD");
    expect(rare.valueEth!).toBeGreaterThan(0.01 * 1.6);

    const common = decide({ assessment: healthy, percentile: 0.8, ethUsd });
    expect(common.action).toBe("SELL");
    expect(common.listEth).toBeCloseTo(0.01);
    expect(common.listUsd).toBeCloseTo(30);

    // Rare but the collection is only thin: sell, and list under value.
    const thin = decide({ assessment: assess(market({ recentSales: 1, uniqueBuyers: 1 })), percentile: 0.02, ethUsd });
    expect(thin.action).toBe("SELL");
    expect(thin.listEth!).toBeLessThan(thin.valueEth!);

    // Rare but worth pennies: not worth listing.
    expect(decide({ assessment: assess(market({ floorEth: 0.00002, recentSales: 12 })), percentile: 0.01, ethUsd }).action).toBe("DEAD");
  });

  it("waits when there is no market yet and writes off a market that never appeared", () => {
    const none = { salesCount: 0, recentSales: 0, uniqueBuyers: 0, uniqueHolders: 5, washShare: 0 };
    expect(decide({ assessment: assess({ snap: none, ageBlocks: 100 }), percentile: 0.1 }).action).toBe("WAIT");
    expect(decide({ assessment: assess({ snap: none, ageBlocks: DEFAULT_VALUATION.deadAfterBlocks + 5 }), percentile: 0.1 }).action).toBe("DEAD");
  });

  it("prices unranked tokens at the floor and never holds them", () => {
    const d = decide({ assessment: assess(market()), percentile: undefined, ethUsd: 3000 });
    expect(d.action).toBe("SELL");
    expect(d.valueEth).toBeCloseTo(0.01);
  });
});

describe("OpenSeaClient", () => {
  const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

  it("does nothing without an API key", async () => {
    const f = vi.fn();
    expect(await new OpenSeaClient({ fetchFn: f as never }).stats(A)).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("finds the chain slug, the collection, and reads an ETH floor", async () => {
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/api/v2/chains")) return json({ chains: [{ chain: "ethereum", name: "Ethereum" }, { chain: "robinhood", name: "Robinhood Chain" }] });
      if (url.includes("/chain/robinhood/contract/")) return json({ collection: "cool-cats" });
      if (url.includes("/collections/cool-cats/stats")) {
        return json({ total: { floor_price: 0.012, floor_price_symbol: "ETH", num_owners: 80, sales: 140 }, intervals: [{ interval: "one_day", sales: 9, volume: 0.1 }] });
      }
      return json({}, 404);
    });
    const os = new OpenSeaClient({ apiKey: "k", fetchFn: f as never });
    expect(await os.stats(A)).toEqual({ floorEth: 0.012, owners: 80, salesTotal: 140, sales24h: 9, volume24hEth: 0.1 });
    expect((f.mock.calls[0][1]!.headers as Record<string, string>)["x-api-key"]).toBe("k");
    await os.stats(A); // slug is cached: no second chains/contract lookup
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/chains"))).toHaveLength(1);
  });

  it("ignores a floor quoted in a non-ETH currency and survives errors", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/contract/")) return json({ collection: "x" });
      if (url.includes("/stats")) return json({ total: { floor_price: 5, floor_price_symbol: "USDC" } });
      return json({ chains: [] });
    });
    expect((await new OpenSeaClient({ apiKey: "k", chainSlug: "robinhood", fetchFn: f as never }).stats(A))?.floorEth).toBeUndefined();
    const boom = vi.fn(async () => { throw new Error("offline"); });
    expect(await new OpenSeaClient({ apiKey: "k", chainSlug: "robinhood", fetchFn: boom as never }).stats(A)).toBeUndefined();
    const unknownChain = vi.fn(async () => json({ chains: [{ chain: "ethereum", name: "Ethereum" }] }));
    expect(await new OpenSeaClient({ apiKey: "k", fetchFn: unknownChain as never }).stats(A)).toBeUndefined();
  });
});
