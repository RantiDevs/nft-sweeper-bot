import type { CollectionRarity } from "./collect.js";

/**
 * Turns rarity ranks into a sell/hold plan.
 *
 * Tiers are listed rarest-first with the share of each collection they cover.
 * The default is: rarest 15% held, next 10% listed at $25, next 25% at $12.50,
 * most common 50% at $5. A token's tier comes from its rarity percentile in its
 * own collection, so "rare" means rare compared with the whole collection, not
 * just with your bag. Prices are your targets; the bot has no market data, so
 * whether anything sells at them is not something it can know.
 */

export interface Tier {
  kind: "hold" | "sell";
  priceUsd?: number;
  /** Share of each collection's tokens, in percent. */
  pct: number;
}

export const DEFAULT_TIERS: Tier[] = [
  { kind: "hold", pct: 15 },
  { kind: "sell", priceUsd: 25, pct: 10 },
  { kind: "sell", priceUsd: 12.5, pct: 25 },
  { kind: "sell", priceUsd: 5, pct: 50 },
];

/** Parses "hold:15,25:10,12.5:25,5:50" (rarest first; shares must add up to 100). */
export function parseTiers(spec: string): Tier[] {
  const tiers = spec.split(",").map((part) => {
    const [what, pctRaw] = part.trim().split(":");
    const pct = Number(pctRaw);
    if (!Number.isFinite(pct) || pct <= 0) throw new Error(`bad share in "${part}"`);
    if (what.toLowerCase() === "hold") return { kind: "hold", pct } as Tier;
    const price = Number(what.replace(/^\$/, ""));
    if (!Number.isFinite(price) || price <= 0) throw new Error(`bad price in "${part}"`);
    return { kind: "sell", priceUsd: price, pct } as Tier;
  });
  const total = tiers.reduce((a, t) => a + t.pct, 0);
  if (Math.abs(total - 100) > 1e-6) throw new Error(`tier shares add up to ${total}%, not 100%`);
  return tiers;
}

export function tierLabel(t: Tier): string {
  return t.kind === "hold" ? "HOLD" : `SELL $${t.priceUsd}`;
}

/** Tier for a rarity percentile (0 = rarest). */
export function tierFor(percentile: number, tiers: Tier[]): Tier {
  let cum = 0;
  for (const t of tiers) {
    cum += t.pct / 100;
    if (percentile < cum - 1e-12) return t;
  }
  return tiers[tiers.length - 1];
}

export interface HeldToken {
  wallet: string;
  collection: string;
  tokenId: string;
  standard: "erc721" | "erc1155";
  amount: string;
  /** Mint transaction, used to find where the collection's history starts. */
  tx?: string;
}

export interface PlanRow extends HeldToken {
  action: "HOLD" | "SELL" | "WAIT" | "DEAD";
  /** Suggested listing price in USD (SELL rows). */
  priceUsd?: number;
  listEth?: number;
  valueEth?: number;
  valueUsd?: number;
  health?: string;
  /** "Top 3%" style position in the collection; undefined when unranked. */
  percentile?: number;
  rank?: number;
  outOf?: number;
  basis?: CollectionRarity["basis"];
  note?: string;
}

export interface PlanOptions {
  tiers: Tier[];
  /** Marketplace fee + creator royalty, in percent of the sale price. */
  feePct: number;
  /** ETH price in USD, to put gas spent in dollars. Optional. */
  ethUsd?: number;
  gasSpentWei: bigint;
  /** "auto" values every NFT from market data; "tiers" uses the fixed price tiers. */
  mode?: "auto" | "tiers";
}

export interface PlanSummary {
  rows: PlanRow[];
  byTier: { label: string; count: number; listUsd: number }[];
  hold: number;
  wait: number;
  /** NFTs judged not worth listing (no market, or worth pennies). */
  dead?: number;
  /** Estimated worth of the held NFTs. */
  holdValueUsd?: number;
  /** Sum of list prices for SELL rows, and what you'd receive after fees if all sell. */
  listUsd: number;
  proceedsUsd: number;
  gasSpentUsd?: number;
  profitIfAllSellUsd?: number;
  /** Share of SELL listings that must sell to cover the gas already spent. */
  breakEvenPct?: number;
}

export function buildPlan(held: HeldToken[], rarity: Map<string, CollectionRarity>, opts: PlanOptions): PlanSummary {
  const rows: PlanRow[] = held.map((h) => {
    if (h.standard === "erc1155") {
      return { ...h, action: "WAIT", note: "ERC-1155 edition: no per-token traits; price it by hand" };
    }
    const r = rarity.get(h.collection);
    const s = r?.scores.get(h.tokenId);
    if (!r || !s) return { ...h, action: "WAIT", note: r?.unrankedReason ?? "not analysed" };
    const t = tierFor(s.percentile, opts.tiers);
    return {
      ...h,
      action: t.kind === "hold" ? "HOLD" : "SELL",
      priceUsd: t.priceUsd,
      percentile: s.percentile,
      rank: s.rank,
      outOf: r.scoredCount,
      basis: r.basis,
    };
  });

  const byTier = opts.tiers.map((t) => {
    const matching = rows.filter((r) => (t.kind === "hold" ? r.action === "HOLD" : r.action === "SELL" && r.priceUsd === t.priceUsd));
    return { label: tierLabel(t), count: matching.length, listUsd: matching.reduce((a, r) => a + (r.priceUsd ?? 0), 0) };
  });
  const listUsd = rows.reduce((a, r) => a + (r.action === "SELL" ? r.priceUsd ?? 0 : 0), 0);
  const proceedsUsd = listUsd * (1 - opts.feePct / 100);
  const gasSpentUsd = opts.ethUsd !== undefined ? (Number(opts.gasSpentWei) / 1e18) * opts.ethUsd : undefined;
  return {
    rows,
    byTier,
    hold: rows.filter((r) => r.action === "HOLD").length,
    wait: rows.filter((r) => r.action === "WAIT").length,
    listUsd,
    proceedsUsd,
    gasSpentUsd,
    profitIfAllSellUsd: gasSpentUsd !== undefined ? proceedsUsd - gasSpentUsd : undefined,
    breakEvenPct: gasSpentUsd !== undefined && proceedsUsd > 0 ? Math.min(100, (gasSpentUsd / proceedsUsd) * 100) : undefined,
  };
}

const csvCell = (v: unknown) => {
  const s = v === undefined ? "" : String(v);
  // Neutralise spreadsheet formula injection from untrusted values.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function planCsv(rows: PlanRow[]): string {
  const head = ["action", "price_usd", "value_usd", "health", "collection", "token_id", "standard", "amount", "wallet", "rarity_rank", "out_of", "top_percent", "basis", "note"];
  const lines = rows
    .slice()
    .sort((a, b) => (a.percentile ?? 2) - (b.percentile ?? 2))
    .map((r) =>
      [
        r.action, r.priceUsd, r.valueUsd === undefined ? undefined : r.valueUsd.toFixed(2), r.health, r.collection, r.tokenId, r.standard, r.amount, r.wallet, r.rank, r.outOf,
        r.percentile === undefined ? undefined : (r.percentile * 100).toFixed(1), r.basis, r.note,
      ].map(csvCell).join(","),
    );
  return [head.join(","), ...lines].join("\n") + "\n";
}
