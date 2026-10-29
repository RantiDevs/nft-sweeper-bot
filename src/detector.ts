import { type Address, type Hex } from "viem";
import { BLOCKED_SELECTORS, retargetCalldata, selectorOf } from "./calldata.js";

/** One observed transaction that minted tokens of `collection` (from == 0x0). */
export interface MintObservation {
  collection: Address;
  txHash: Hex;
  blockNumber: bigint;
  /** tx.from: the wallet that paid for the mint. */
  minter: Address;
  /** tx.to: the contract called (the collection itself or a separate minter). */
  target: Address;
  input: Hex;
  value: bigint;
}

export interface HotMint {
  collection: Address;
  /**
   * Candidate txs to replay, best first. Each is the newest tx of a distinct
   * call "pattern" (target + calldata with the minter's address masked out),
   * ranked by how many distinct wallets used that pattern. The crowd's most
   * common way of minting is the one most likely to work for us too.
   */
  templates: MintObservation[];
  uniqueMinters: number;
  mintTxs: number;
  /** Wall-clock ms when the bot first saw this collection mint (for latency reporting). */
  firstSeenAt?: number;
}

export interface DetectorOptions {
  windowBlocks: number;
  minUniqueMinters: number;
  minMintTxs: number;
  /** Lower thresholds for specific collections (e.g. allowlisted snipes). */
  thresholdsFor?: (collection: Address) => { minUniqueMinters: number; minMintTxs: number } | undefined;
  /** Max candidate templates returned per collection. */
  maxTemplates?: number;
}

const MASK = "0x000000000000000000000000000000000000dEaD" as Address;

/** Normalised call shape: identical for two wallets doing the "same" mint. */
export function patternKey(o: MintObservation): string {
  return `${o.target}:${retargetCalldata(o.input, o.minter, MASK)}`;
}

/**
 * Keeps a sliding window of mint activity per collection and flags collections
 * that many distinct wallets are minting for free right now.
 *
 * A collection is disqualified for the window if anyone paid ETH to mint it,
 * so paid mints with a few free allowlist claims are not mistaken for free ones.
 */
export class MintDetector {
  private byCollection = new Map<Address, Map<Hex, MintObservation>>();
  private firstSeen = new Map<Address, number>();

  constructor(private opts: DetectorOptions) {}

  add(obs: MintObservation): void {
    if (!this.firstSeen.has(obs.collection)) this.firstSeen.set(obs.collection, Date.now());
    let m = this.byCollection.get(obs.collection);
    if (!m) this.byCollection.set(obs.collection, (m = new Map()));
    m.set(obs.txHash, obs);
  }

  forget(collection: Address): void {
    this.byCollection.delete(collection);
  }

  prune(head: bigint): void {
    const cutoff = head - BigInt(this.opts.windowBlocks);
    for (const [c, m] of this.byCollection) {
      for (const [h, o] of m) if (o.blockNumber <= cutoff) m.delete(h);
      if (m.size === 0) {
        this.byCollection.delete(c);
        this.firstSeen.delete(c);
      }
    }
  }

  size(): number {
    return this.byCollection.size;
  }

  /**
   * Free-mint collections meeting the thresholds. `floor` overrides the
   * constructor thresholds, so several consumers (e.g. Telegram users with
   * different settings) can share one detector and filter the result further.
   */
  hot(floor?: { minUniqueMinters: number; minMintTxs: number }): HotMint[] {
    const out: HotMint[] = [];
    for (const [collection, m] of this.byCollection) {
      const arr = [...m.values()];
      if (arr.some((o) => o.value > 0n)) continue;
      const t = floor ?? this.opts.thresholdsFor?.(collection) ?? this.opts;
      const uniqueMinters = new Set(arr.map((o) => o.minter)).size;
      if (uniqueMinters < t.minUniqueMinters || arr.length < t.minMintTxs) continue;

      const patterns = new Map<string, { minters: Set<Address>; latest: MintObservation }>();
      for (const o of arr) {
        if (o.input.length < 10 || BLOCKED_SELECTORS.has(selectorOf(o.input))) continue;
        const k = patternKey(o);
        const p = patterns.get(k);
        if (!p) patterns.set(k, { minters: new Set([o.minter]), latest: o });
        else {
          p.minters.add(o.minter);
          if (o.blockNumber > p.latest.blockNumber) p.latest = o;
        }
      }
      if (patterns.size === 0) continue;
      const templates = [...patterns.values()]
        .sort((a, b) => b.minters.size - a.minters.size || Number(b.latest.blockNumber - a.latest.blockNumber))
        .slice(0, this.opts.maxTemplates ?? 3)
        .map((p) => p.latest);
      out.push({ collection, templates, uniqueMinters, mintTxs: arr.length, firstSeenAt: this.firstSeen.get(collection) });
    }
    return out.sort((a, b) => b.uniqueMinters - a.uniqueMinters);
  }
}
