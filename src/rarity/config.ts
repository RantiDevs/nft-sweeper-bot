import { getAddress, type Address } from "viem";
import { DEFAULT_VALUATION, type ValuationConfig } from "../market/valuation.js";
import { DEFAULT_TIERS, parseTiers, type Tier } from "./plan.js";
import { DEFAULT_IPFS_GATEWAYS } from "./uri.js";

type Env = Record<string, string | undefined>;

export interface PlanConfig {
  tiers: Tier[];
  feePct: number;
  ethUsd?: number;
  sample: number;
  concurrency: number;
  gateways: string[];
  cacheDir: string;
  /** "auto": value every NFT from market data (default). "tiers": use the fixed price tiers. */
  mode: "auto" | "tiers";
  openseaKey?: string;
  openseaChain?: string;
  weth?: Address;
  valuation: ValuationConfig;
}

function num(env: Env, name: string, lo: number, hi: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be a number between ${lo} and ${hi}`);
  return n;
}

export function loadPlanConfig(env: Env, defaults: { cacheDir: string }): PlanConfig {
  return {
    // Rarest first. Default: hold the rarest 15%, then $25 (10%), $12.50 (25%), $5 (50%).
    tiers: env.PLAN_TIERS ? parseTiers(env.PLAN_TIERS) : DEFAULT_TIERS,
    // Marketplace fee + creator royalty you lose on each sale.
    feePct: num(env, "MARKET_FEE_PCT", 0, 50) ?? 5,
    ethUsd: num(env, "ETH_USD", 1, 1_000_000),
    sample: num(env, "RARITY_SAMPLE", 50, 20_000) ?? 1500,
    concurrency: num(env, "METADATA_CONCURRENCY", 1, 32) ?? 8,
    gateways: env.IPFS_GATEWAYS ? env.IPFS_GATEWAYS.split(/[,\s]+/).filter(Boolean).map((g) => (g.endsWith("/") ? g : `${g}/`)) : DEFAULT_IPFS_GATEWAYS,
    cacheDir: env.METADATA_CACHE_DIR || defaults.cacheDir,
    mode: (env.PLAN_MODE ?? "auto").toLowerCase() === "tiers" ? "tiers" : "auto",
    openseaKey: env.OPENSEA_API_KEY || undefined,
    openseaChain: env.OPENSEA_CHAIN || undefined,
    weth: env.WETH_ADDRESS ? getAddress(env.WETH_ADDRESS) : undefined,
    valuation: {
      ...DEFAULT_VALUATION,
      holdTopPct: (num(env, "HOLD_TOP_PCT", 0, 100) ?? DEFAULT_VALUATION.holdTopPct * 100) / 100,
      holdMinScore: num(env, "HOLD_MIN_SCORE", 0, 100) ?? DEFAULT_VALUATION.holdMinScore,
      holdMinUsd: num(env, "HOLD_MIN_USD", 0, 1_000_000) ?? DEFAULT_VALUATION.holdMinUsd,
      minListUsd: num(env, "MIN_LIST_USD", 0, 1_000_000) ?? DEFAULT_VALUATION.minListUsd,
      deadAfterBlocks: (num(env, "DEAD_AFTER_HOURS", 1, 24 * 365) ?? 48) * 36_000,
    },
  };
}
