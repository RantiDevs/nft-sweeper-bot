import type { Address, PublicClient } from "viem";
import type { State } from "../state.js";
import { errMsg } from "../util.js";
import type { Wallet } from "../wallets.js";
import { rankCollection, type CollectionRarity, type RarityOptions } from "./collect.js";
import { buildAutoPlan, gatherMarket, type MarketOptions } from "../market/advisor.js";
import type { CollectionMarket, ValuationConfig } from "../market/valuation.js";
import { buildPlan, type HeldToken, type PlanOptions, type PlanSummary } from "./plan.js";

/** Everything the bot minted into these wallets and still holds (from state). */
export function heldTokens(wallets: Wallet[], state: State): HeldToken[] {
  return wallets.flatMap((w) =>
    state.holdings(w.account.address).map((h) => ({
      wallet: w.account.address,
      collection: h.collection,
      tokenId: h.tokenId,
      standard: h.standard,
      amount: h.amount,
      tx: h.tx,
    })),
  );
}

/**
 * Ranks every collection you hold and builds the sell/hold plan. Collections are
 * analysed one at a time so a large bag doesn't hammer the RPC or IPFS gateways;
 * a collection that fails is reported as WAIT instead of failing the whole plan.
 */
export async function analyzeHoldings(
  client: PublicClient,
  held: HeldToken[],
  rarityOpts: RarityOptions,
  planOpts: PlanOptions & { valuation?: ValuationConfig },
  onProgress?: (done: number, total: number) => void,
  market: MarketOptions = {},
): Promise<PlanSummary> {
  const byCollection = new Map<string, string[]>();
  for (const h of held) {
    if (h.standard !== "erc721") continue;
    const ids = byCollection.get(h.collection) ?? [];
    ids.push(h.tokenId);
    byCollection.set(h.collection, ids);
  }
  const rarity = new Map<string, CollectionRarity>();
  let done = 0;
  for (const [collection, ids] of byCollection) {
    try {
      rarity.set(collection, await rankCollection(client, collection as Address, ids, rarityOpts));
    } catch (e) {
      rarity.set(collection, {
        collection: collection as Address, scoredCount: 0, failed: 0, basis: "collection", scores: new Map(),
        unrankedReason: `analysis failed: ${errMsg(e)}`,
      });
    }
    onProgress?.(++done, byCollection.size);
  }
  if (planOpts.mode === "tiers") return buildPlan(held, rarity, planOpts);

  const markets = new Map<string, CollectionMarket | { error: string }>();
  for (const c of byCollection.keys()) {
    markets.set(c, await gatherMarket(client, c as Address, held.filter((h) => h.collection === c), rarity.get(c)?.supply, market));
  }
  return buildAutoPlan(held, rarity, markets, planOpts);
}
