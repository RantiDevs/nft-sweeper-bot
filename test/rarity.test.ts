import { describe, expect, it } from "vitest";
import type { CollectionRarity } from "../src/rarity/collect.js";
import { buildPlan, DEFAULT_TIERS, parseTiers, planCsv, tierFor } from "../src/rarity/plan.js";
import { extractTraits, hasRaritySignal, scoreCollection } from "../src/rarity/score.js";
import { fetchPublicText, isPrivateIp, loadMetadata, resolveUri } from "../src/rarity/uri.js";

const tok = (id: number, traits: Record<string, string>) => ({
  id: String(id),
  traits: Object.entries(traits).map(([type, value]) => ({ type, value })),
});

describe("trait extraction", () => {
  it("reads the common metadata shapes and skips numeric stats", () => {
    expect(extractTraits({ attributes: [{ trait_type: "Eyes", value: "Laser" }, { trait_type: "Level", value: 5, display_type: "number" }] })).toEqual([{ type: "eyes", value: "laser" }]);
    expect(extractTraits({ attributes: { Hat: "Crown" } })).toEqual([{ type: "hat", value: "crown" }]);
    expect(extractTraits({ traits: [{ type: "Fur", value: "Gold" }] })).toEqual([{ type: "fur", value: "gold" }]);
    expect(extractTraits({ name: "x" })).toBeNull();
    expect(extractTraits("junk")).toBeNull();
  });
});

describe("rarity scoring", () => {
  // 100 tokens: 1 gold, 9 silver, 90 plain; a hat on 5 of them (2 on the gold/silver ones).
  const tokens = Array.from({ length: 100 }, (_, i) =>
    tok(i + 1, {
      fur: i === 0 ? "gold" : i < 10 ? "silver" : "plain",
      ...(i === 0 || i === 1 || i >= 95 ? { hat: "crown" } : {}),
    }),
  );
  const scored = scoreCollection(tokens);
  const byId = new Map(scored.map((s) => [s.id, s]));

  it("ranks the token with the rarest traits first", () => {
    expect(byId.get("1")!.rank).toBe(1);
    expect(byId.get("1")!.percentile).toBe(0);
    expect(byId.get("2")!.rank).toBeLessThan(byId.get("50")!.rank);
  });

  it("gives identical tokens identical (tied) ranks", () => {
    expect(byId.get("40")!.rank).toBe(byId.get("60")!.rank);
    expect(byId.get("40")!.percentile).toBe(byId.get("60")!.percentile);
  });

  it("places a big tie of common tokens at the middle of the tie, not its start", () => {
    // 50 tokens share the plainest traits: they occupy the bottom half of the ranking.
    const mixed = [...Array.from({ length: 50 }, (_, i) => tok(i, { a: "plain" })), ...Array.from({ length: 50 }, (_, i) => tok(100 + i, { a: `u${i}` }))];
    const s = new Map(scoreCollection(mixed).map((x) => [x.id, x]));
    expect(s.get("10")!.percentile).toBeGreaterThan(0.7); // would be 0.5 if ties used their start
    expect(s.get("100")!.percentile).toBeLessThan(0.5);
  });

  it("treats a missing trait as its own category", () => {
    // 95 tokens lack a hat, so 'no hat' is common while 'crown' is rare.
    expect(byId.get("96")!.ic).toBeGreaterThan(byId.get("50")!.ic);
  });

  it("reports no signal when every token is identical", () => {
    const same = scoreCollection([tok(1, { a: "x" }), tok(2, { a: "x" }), tok(3, { a: "x" })]);
    expect(hasRaritySignal(same)).toBe(false);
    expect(hasRaritySignal(scored)).toBe(true);
  });

  it("smooths sampled frequencies so a value seen once is not treated as unique", () => {
    const sample = tokens.slice(0, 50);
    const exact = scoreCollection(sample).find((s) => s.id === "1")!;
    const smoothed = scoreCollection(sample, 5000).find((s) => s.id === "1")!;
    expect(smoothed.ic).toBeLessThan(exact.ic);
  });
});

describe("tiers and plan", () => {
  it("maps rarity percentiles to the default tiers", () => {
    expect(tierFor(0, DEFAULT_TIERS).kind).toBe("hold");
    expect(tierFor(0.149, DEFAULT_TIERS).kind).toBe("hold");
    expect(tierFor(0.15, DEFAULT_TIERS).priceUsd).toBe(25);
    expect(tierFor(0.249, DEFAULT_TIERS).priceUsd).toBe(25);
    expect(tierFor(0.25, DEFAULT_TIERS).priceUsd).toBe(12.5);
    expect(tierFor(0.5, DEFAULT_TIERS).priceUsd).toBe(5);
    expect(tierFor(0.99, DEFAULT_TIERS).priceUsd).toBe(5);
  });

  it("parses and validates tier specs", () => {
    expect(parseTiers("hold:15,25:10,12.5:25,5:50")).toEqual(DEFAULT_TIERS);
    expect(() => parseTiers("hold:15,25:10")).toThrow(/add up to 25%/);
    expect(() => parseTiers("abc:100")).toThrow(/bad price/);
  });

  it("builds a plan with money math and flags unranked tokens", () => {
    const collection = "0x00000000000000000000000000000000000000c1";
    const scores = new Map(
      [["1", 0.0], ["2", 0.2], ["3", 0.3], ["4", 0.7]].map(([id, percentile]) => [
        id as string,
        { id: id as string, ic: 1, score: 1, percentile: percentile as number, rank: 1 },
      ]),
    );
    const rarity = new Map<string, CollectionRarity>([[collection, { collection: collection as never, scoredCount: 4, failed: 0, basis: "collection", scores }]]);
    const held = ["1", "2", "3", "4", "5"].map((tokenId) => ({ wallet: "0xw", collection, tokenId, standard: "erc721" as const, amount: "1" }));
    const plan = buildPlan(held, rarity, { tiers: DEFAULT_TIERS, feePct: 5, ethUsd: 3000, gasSpentWei: 10n ** 15n });
    expect(plan.rows.map((r) => r.action)).toEqual(["HOLD", "SELL", "SELL", "SELL", "WAIT"]);
    expect(plan.rows.map((r) => r.priceUsd)).toEqual([undefined, 25, 12.5, 5, undefined]);
    expect(plan.listUsd).toBe(42.5);
    expect(plan.proceedsUsd).toBeCloseTo(40.375);
    expect(plan.gasSpentUsd).toBeCloseTo(3);
    expect(plan.breakEvenPct).toBeCloseTo((3 / 40.375) * 100);
    expect(plan.wait).toBe(1);
  });

  it("neutralises spreadsheet formulas in CSV output", () => {
    const csv = planCsv([{ wallet: "0xw", collection: "=cmd()", tokenId: "1", standard: "erc721", amount: "1", action: "WAIT", note: "has, comma" }]);
    expect(csv).toContain("'=cmd()");
    expect(csv).toContain('"has, comma"');
  });
});

describe("safe metadata fetching", () => {
  it("recognises private and loopback addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("refuses to fetch internal URLs", async () => {
    for (const url of ["http://127.0.0.1:8545/", "http://localhost/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "ftp://example.com/x", "http://user:pw@example.com/"]) {
      await expect(fetchPublicText(url), url).rejects.toThrow();
    }
  });

  it("resolves ipfs, arweave and data URIs", () => {
    expect(resolveUri("ipfs://Qm123/1.json", ["https://gw/ipfs/"])).toEqual({ urls: ["https://gw/ipfs/Qm123/1.json"] });
    expect(resolveUri("ar://abc")).toEqual({ urls: ["https://arweave.net/abc"] });
    expect(resolveUri('data:application/json;utf8,{"a":1}')).toEqual({ inline: '{"a":1}' });
    expect(resolveUri(`data:application/json;base64,${Buffer.from('{"b":2}').toString("base64")}`)).toEqual({ inline: '{"b":2}' });
    expect(() => resolveUri("file:///etc/passwd")).toThrow(/unsupported/);
  });

  it("falls back to the next IPFS gateway", async () => {
    const calls: string[] = [];
    const meta = await loadMetadata("ipfs://Qm1/1.json", {
      gateways: ["https://a/ipfs/", "https://b/ipfs/"],
      fetchText: async (u) => {
        calls.push(u);
        if (u.startsWith("https://a/")) throw new Error("down");
        return '{"attributes":[{"trait_type":"x","value":"y"}]}';
      },
    });
    expect(calls).toHaveLength(2);
    expect(extractTraits(meta)).toEqual([{ type: "x", value: "y" }]);
  });
});
