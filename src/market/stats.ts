import type { Address } from "viem";
import type { Sale } from "./sales.js";

export interface MarketSnapshot {
  /** Clean (non-wash) sales with a readable price. */
  salesCount: number;
  /** Clean sales inside the recent window. */
  recentSales: number;
  medianEth?: number;
  lastEth?: number;
  /** Conservative floor: a low quantile of recent sales, not the single cheapest sale. */
  floorEth?: number;
  /** Median of the newest third of sales over the oldest third, minus 1 (0.2 means +20%). */
  trend?: number;
  uniqueBuyers: number;
  uniqueHolders: number;
  holderRatio?: number;
  /** Share of held supply owned by the 10 biggest holders, 0..1. */
  whaleShare?: number;
  washShare: number;
  /** Blocks since the newest clean sale. */
  blocksSinceLastSale?: number;
}

const eth = (wei: bigint) => Number(wei) / 1e18;

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function snapshot(opts: {
  clean: Sale[];
  washShare: number;
  owners: Map<string, Address>;
  supply?: number;
  headBlock: bigint;
  recentBlocks: number;
}): MarketSnapshot {
  const priced = opts.clean.filter((s) => s.priceWei !== undefined);
  const recent = priced.filter((s) => Number(opts.headBlock - s.block) <= opts.recentBlocks);
  const prices = (list: Sale[]) => list.map((s) => eth(s.priceWei!)).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length ? quantile(xs, 0.5) : undefined);

  // Use recent sales when there are enough; otherwise fall back to the latest few.
  const basis = recent.length >= 3 ? recent : priced.slice(-10);
  const sortedBasis = prices(basis);

  let trend: number | undefined;
  if (priced.length >= 9) {
    const third = Math.floor(priced.length / 3);
    const first = median(prices(priced.slice(0, third)));
    const last = median(prices(priced.slice(-third)));
    if (first && last) trend = last / first - 1;
  }

  const holders = new Map<Address, number>();
  for (const a of opts.owners.values()) holders.set(a, (holders.get(a) ?? 0) + 1);
  const held = opts.owners.size;
  const top10 = [...holders.values()].sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0);

  return {
    salesCount: priced.length,
    recentSales: recent.length,
    medianEth: median(sortedBasis),
    lastEth: priced.length ? eth(priced[priced.length - 1].priceWei!) : undefined,
    floorEth: sortedBasis.length ? quantile(sortedBasis, 0.2) : undefined,
    trend,
    uniqueBuyers: new Set(priced.map((s) => s.to)).size,
    uniqueHolders: holders.size,
    holderRatio: held ? holders.size / (opts.supply ?? held) : undefined,
    whaleShare: held ? top10 / held : undefined,
    washShare: opts.washShare,
    blocksSinceLastSale: priced.length ? Number(opts.headBlock - priced[priced.length - 1].block) : undefined,
  };
}
