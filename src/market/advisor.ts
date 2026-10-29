import type { Address, PublicClient } from "viem";
import { ZERO_ADDRESS_STR } from "../logs.js";
import type { CollectionRarity } from "../rarity/collect.js";
import type { HeldToken, PlanOptions, PlanRow, PlanSummary } from "../rarity/plan.js";
import { errMsg } from "../util.js";
import type { OpenSeaClient } from "./opensea.js";
import { currentOwners, pricedSales, readTransfers } from "./sales.js";
import { snapshot } from "./stats.js";
import { assess, decide, DEFAULT_VALUATION, type CollectionMarket, type ValuationConfig } from "./valuation.js";
import { filterWash } from "./wash.js";

export interface MarketOptions {
  opensea?: OpenSeaClient;
  /** WETH contract, so accepted offers (paid in WETH) count as priced sales. */
  weth?: Address;
  valuation?: ValuationConfig;
  /** Blocks per hour, for converting "24h" windows (Robinhood Chain: ~36000). */
  blocksPerHour?: number;
}

/** Reads a collection's sales and holders and measures its market. Never throws. */
export async function gatherMarket(
  client: PublicClient,
  collection: Address,
  held: HeldToken[],
  supply: number | undefined,
  opts: MarketOptions,
): Promise<CollectionMarket | { error: string }> {
  try {
    const head = await client.getBlockNumber();
    const bph = opts.blocksPerHour ?? 36_000;

    // Start just before our own mints: the collection can't have trades older than its mints.
    const txs = held.filter((h) => h.tx).slice(0, 5).map((h) => h.tx as `0x${string}`);
    const blocks = await Promise.all(txs.map((hash) => client.getTransactionReceipt({ hash }).then((r) => r.blockNumber).catch(() => undefined)));
    const known = blocks.filter((b): b is bigint => b !== undefined);
    const from = known.length ? known.reduce((a, b) => (a < b ? a : b)) - 5_000n : head - BigInt(bph) * 72n;

    const transfers = await readTransfers(client, collection, from < 0n ? 0n : from, head);
    const mints = transfers.filter((t) => t.from === ZERO_ADDRESS_STR);
    const firstMint = mints.length ? mints.reduce((a, b) => (a.block < b.block ? a : b)).block : from;

    const sales = await pricedSales(client, transfers, { weth: opts.weth });
    const wash = filterWash(sales, { roundTripBlocks: bph * 24 * 30 });
    const snap = snapshot({
      clean: wash.clean,
      washShare: wash.washShare,
      owners: currentOwners(transfers),
      supply: supply ?? (mints.length || undefined),
      headBlock: head,
      recentBlocks: bph * 24,
    });
    const os = opts.opensea ? await opts.opensea.stats(collection) : undefined;
    return { snap, opensea: os, ageBlocks: Number(head - firstMint) };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/** Automatic plan: value every token from market data + rarity and decide hold/sell/dead/wait. */
export function buildAutoPlan(
  held: HeldToken[],
  rarity: Map<string, CollectionRarity>,
  markets: Map<string, CollectionMarket | { error: string }>,
  opts: PlanOptions & { valuation?: ValuationConfig },
): PlanSummary {
  const cfg = opts.valuation ?? DEFAULT_VALUATION;
  const assessments = new Map<string, ReturnType<typeof assess>>();
  for (const [c, m] of markets) if (!("error" in m)) assessments.set(c, assess(m, cfg));

  const rows: PlanRow[] = held.map((h) => {
    if (h.standard === "erc1155") return { ...h, action: "WAIT", note: "ERC-1155 edition: no per-token traits; price it by hand" };
    const m = markets.get(h.collection);
    if (!m || "error" in m) return { ...h, action: "WAIT", note: `market data unavailable${m ? `: ${m.error}` : ""}` };
    const r = rarity.get(h.collection);
    const s = r?.scores.get(h.tokenId);
    const d = decide({ assessment: assessments.get(h.collection)!, percentile: s?.percentile, ethUsd: opts.ethUsd, cfg });
    return {
      ...h,
      action: d.action,
      priceUsd: d.listUsd,
      listEth: d.listEth,
      valueEth: d.valueEth,
      valueUsd: d.valueUsd,
      health: assessments.get(h.collection)!.health,
      percentile: s?.percentile,
      rank: s?.rank,
      outOf: r?.scoredCount,
      basis: r?.basis,
      note: d.reason + (s ? "" : r?.unrankedReason ? ` (${r.unrankedReason})` : ""),
    };
  });

  const groups = ["HOLD", "SELL", "DEAD", "WAIT"] as const;
  const byTier = groups.map((g) => {
    const rs = rows.filter((r) => r.action === g);
    return { label: g, count: rs.length, listUsd: g === "SELL" ? rs.reduce((a, r) => a + (r.priceUsd ?? 0), 0) : 0 };
  });
  const sells = rows.filter((r) => r.action === "SELL");
  const listUsd = sells.reduce((a, r) => a + (r.priceUsd ?? 0), 0);
  const proceedsUsd = listUsd * (1 - opts.feePct / 100);
  const holdValueUsd = rows.filter((r) => r.action === "HOLD").reduce((a, r) => a + (r.valueUsd ?? 0), 0);
  const gasSpentUsd = opts.ethUsd !== undefined ? (Number(opts.gasSpentWei) / 1e18) * opts.ethUsd : undefined;
  return {
    rows,
    byTier,
    hold: rows.filter((r) => r.action === "HOLD").length,
    wait: rows.filter((r) => r.action === "WAIT").length,
    dead: rows.filter((r) => r.action === "DEAD").length,
    listUsd,
    proceedsUsd,
    holdValueUsd,
    gasSpentUsd,
    profitIfAllSellUsd: gasSpentUsd !== undefined ? proceedsUsd - gasSpentUsd : undefined,
    breakEvenPct: gasSpentUsd !== undefined && proceedsUsd > 0 ? Math.min(100, (gasSpentUsd / proceedsUsd) * 100) : undefined,
  };
}
