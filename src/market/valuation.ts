import type { MarketSnapshot } from "./stats.js";
import type { OpenSeaStats } from "./opensea.js";

/**
 * Turns market data and a token's rarity into a value and a sell/hold decision.
 * Nothing here predicts the future: it prices an NFT from what similar ones have
 * actually sold for, and holds only when the collection shows real, rising demand.
 */

export interface ValuationConfig {
  /** Blocks of silence after which a collection with sales is considered stalled. */
  staleBlocks: number;
  /** Blocks after mint with no sale at all before a collection is considered dead. */
  deadAfterBlocks: number;
  holdTopPct: number;
  holdMinScore: number;
  holdMinUsd: number;
  /** Below this, an NFT isn't worth the trouble of listing. */
  minListUsd: number;
  /** Cap on the rarity premium. */
  maxMultiplier: number;
}

export const DEFAULT_VALUATION: ValuationConfig = {
  staleBlocks: 36_000 * 24, // 24h at 10 blocks/s
  deadAfterBlocks: 36_000 * 48,
  holdTopPct: 0.15,
  holdMinScore: 65,
  holdMinUsd: 10,
  minListUsd: 0.5,
  maxMultiplier: 8,
};

/**
 * Price multiplier over the floor for a token at rarity `percentile` (0 = rarest).
 * Shape from Mekacher et al. 2022: roughly flat for the commoner half, then rising,
 * about +195% on average for the rarest decile with a power-law tail. These are
 * literature defaults, not fitted to this chain.
 */
export function premiumMultiplier(percentile: number, cfg: Pick<ValuationConfig, "maxMultiplier"> = DEFAULT_VALUATION): number {
  if (percentile >= 0.5) return 1;
  if (percentile >= 0.1) return 1 + 0.6 * ((0.5 - percentile) / 0.4); // 1.0 -> 1.6
  const tail = 1.6 * Math.pow(Math.max(percentile, 0.002) / 0.1, -0.55); // 1.6 at 10%, rising
  return Math.min(cfg.maxMultiplier, Math.max(1.6, tail));
}

export type Health = "ACTIVE" | "THIN" | "STALLED" | "NO_MARKET" | "DEAD";

export interface CollectionMarket {
  snap: MarketSnapshot;
  opensea?: OpenSeaStats;
  /** Blocks since the collection was first seen minting. */
  ageBlocks: number;
}

export interface CollectionAssessment {
  health: Health;
  /** 0..100 */
  score: number;
  floorEth?: number;
  reasons: string[];
}

/** Conservative floor: the lower of the listed floor and recent sales, when both exist. */
export function effectiveFloor(m: CollectionMarket): number | undefined {
  const a = m.opensea?.floorEth;
  const b = m.snap.floorEth;
  if (a !== undefined && b !== undefined) return Math.min(a, b);
  return a ?? b;
}

export function assess(m: CollectionMarket, cfg: ValuationConfig = DEFAULT_VALUATION): CollectionAssessment {
  const s = m.snap;
  const floorEth = effectiveFloor(m);
  const reasons: string[] = [];
  const hasSales = s.salesCount > 0;

  if (!hasSales && floorEth === undefined) {
    const dead = m.ageBlocks > cfg.deadAfterBlocks;
    return {
      health: dead ? "DEAD" : "NO_MARKET",
      score: 0,
      reasons: [dead ? "no sale or listing since mint" : "no sales or listings yet"],
    };
  }

  let score = 0;
  // Liquidity is the strongest signal: recent sales and a spread of different buyers.
  score += Math.min(35, s.recentSales * 5);
  score += Math.min(15, s.uniqueBuyers * 2);
  // A wide, even holder base is harder to manipulate and to dump.
  if (s.holderRatio !== undefined) score += Math.min(10, s.holderRatio * 20);
  if (s.whaleShare !== undefined) score += s.whaleShare < 0.25 ? 10 : s.whaleShare < 0.5 ? 5 : 0;
  // Direction of recent prices.
  if (s.trend !== undefined) score += s.trend > 0.1 ? 20 : s.trend > -0.1 ? 10 : 0;
  else score += 5;
  // Faked volume is penalised.
  score -= Math.round(s.washShare * 40);
  score = Math.max(0, Math.min(100, Math.round(score)));

  if (s.washShare > 0.3) reasons.push(`${Math.round(s.washShare * 100)}% of sales look like wash trading`);
  if (s.whaleShare !== undefined && s.whaleShare > 0.5) reasons.push("top 10 wallets hold over half of the supply");
  if (s.trend !== undefined) reasons.push(`price trend ${s.trend >= 0 ? "+" : ""}${Math.round(s.trend * 100)}%`);

  const silent = s.blocksSinceLastSale !== undefined && s.blocksSinceLastSale > cfg.staleBlocks;
  if (silent && s.recentSales === 0) {
    reasons.push("no sale in the last 24h");
    return { health: "STALLED", score: Math.min(score, 30), floorEth, reasons };
  }
  if (s.recentSales < 3 || s.uniqueBuyers < 3) {
    reasons.push("few recent sales: price is uncertain");
    return { health: "THIN", score: Math.min(score, 55), floorEth, reasons };
  }
  return { health: "ACTIVE", score, floorEth, reasons };
}

export type Action = "HOLD" | "SELL" | "WAIT" | "DEAD";

export interface Decision {
  action: Action;
  valueEth?: number;
  valueUsd?: number;
  /** Suggested listing price. */
  listEth?: number;
  listUsd?: number;
  reason: string;
}

/** Decide what to do with one token given its collection's assessment and its rarity. */
export function decide(opts: {
  assessment: CollectionAssessment;
  /** Rarity percentile (0 = rarest), or undefined when unranked. */
  percentile?: number;
  ethUsd?: number;
  cfg?: ValuationConfig;
}): Decision {
  const cfg = opts.cfg ?? DEFAULT_VALUATION;
  const a = opts.assessment;
  const usd = (eth: number | undefined) => (eth !== undefined && opts.ethUsd ? eth * opts.ethUsd : undefined);

  if (a.health === "NO_MARKET") return { action: "WAIT", reason: `${a.reasons[0]}; check again later` };
  if (a.health === "DEAD") return { action: "DEAD", reason: `${a.reasons[0]}: likely worthless, don't spend gas on it` };
  if (a.floorEth === undefined) return { action: "WAIT", reason: "no price reference" };

  const ranked = opts.percentile !== undefined;
  const mult = ranked ? premiumMultiplier(opts.percentile!, cfg) : 1;
  const valueEth = a.floorEth * mult;
  const valueUsd = usd(valueEth);
  const why = [
    ranked ? `rarity top ${Math.max(1, Math.round(opts.percentile! * 100))}% (×${mult.toFixed(2)} over floor)` : "unranked: priced at the floor",
    ...a.reasons,
  ].join("; ");

  if (valueUsd !== undefined && valueUsd < cfg.minListUsd) {
    return { action: "DEAD", valueEth, valueUsd, reason: `worth about $${valueUsd.toFixed(2)}, below the $${cfg.minListUsd} not-worth-listing line` };
  }

  const holdWorthy =
    a.health === "ACTIVE" &&
    a.score >= cfg.holdMinScore &&
    ranked &&
    opts.percentile! <= cfg.holdTopPct &&
    (valueUsd === undefined || valueUsd >= cfg.holdMinUsd);
  if (holdWorthy) return { action: "HOLD", valueEth, valueUsd, reason: `${why}; demand score ${a.score}/100` };

  // Thin or stalled markets: list a little under value so it actually sells.
  const haircut = a.health === "ACTIVE" ? 1 : a.health === "THIN" ? 0.9 : 0.8;
  const listEth = valueEth * haircut;
  return { action: "SELL", valueEth, valueUsd, listEth, listUsd: usd(listEth), reason: `${why}; ${a.health.toLowerCase()} market` };
}
