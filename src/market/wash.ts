import type { Sale } from "./sales.js";

export interface WashResult {
  clean: Sale[];
  flagged: Sale[];
  /** Share of priced sales removed, 0..1. */
  washShare: number;
}

/**
 * Removes sales that look like a wallet trading with itself to fake price or volume.
 * These are on-chain heuristics and can misfire, so they only ever remove sales:
 *  - the buyer is the seller
 *  - a token returns to an earlier seller within `roundTripBlocks` (A to B to A)
 *  - the same pair of wallets trades with each other 3 or more times in the collection
 * Flagged sales are excluded BEFORE any floor or median is computed.
 */
export function filterWash(sales: Sale[], opts: { roundTripBlocks: number }): WashResult {
  const flagged = new Set<Sale>();

  for (const s of sales) if (s.from === s.to) flagged.add(s);

  const byToken = new Map<string, Sale[]>();
  for (const s of sales) byToken.set(s.tokenId, [...(byToken.get(s.tokenId) ?? []), s]);
  for (const list of byToken.values()) {
    list.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (Number(list[j].block - list[i].block) > opts.roundTripBlocks) break;
        if (list[j].to === list[i].from) {
          flagged.add(list[i]);
          flagged.add(list[j]);
        }
      }
    }
  }

  const byPair = new Map<string, Sale[]>();
  for (const s of sales) {
    const key = [s.from, s.to].sort().join("|");
    byPair.set(key, [...(byPair.get(key) ?? []), s]);
  }
  for (const list of byPair.values()) if (list.length >= 3) list.forEach((s) => flagged.add(s));

  return {
    clean: sales.filter((s) => !flagged.has(s)),
    flagged: sales.filter((s) => flagged.has(s)),
    washShare: sales.length ? flagged.size / sales.length : 0,
  };
}
