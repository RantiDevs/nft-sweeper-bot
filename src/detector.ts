import { type Address, type Hex } from "viem";
import { BLOCKED_SELECTORS, selectorOf } from "./calldata.js";

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
  /** The most recent free mint tx; this is the template we replay. */
  template: MintObservation;
  uniqueMinters: number;
  mintTxs: number;
}

export interface DetectorOptions {
  windowBlocks: number;
  minUniqueMinters: number;
  minMintTxs: number;
}

/**
 * Keeps a sliding window of mint activity per collection and flags collections
 * that many distinct wallets are minting for free right now.
 *
 * A collection is disqualified for the window if anyone paid ETH to mint it,
 * so paid mints with a few free allowlist claims are not mistaken for free ones.
 */
export class MintDetector {
  private byCollection = new Map<Address, MintObservation[]>();

  constructor(private opts: DetectorOptions) {}

  add(obs: MintObservation): void {
    const arr = this.byCollection.get(obs.collection) ?? [];
    if (!arr.some((o) => o.txHash === obs.txHash)) arr.push(obs);
    this.byCollection.set(obs.collection, arr);
  }

  prune(head: bigint): void {
    const cutoff = head - BigInt(this.opts.windowBlocks);
    for (const [c, arr] of this.byCollection) {
      const kept = arr.filter((o) => o.blockNumber > cutoff);
      if (kept.length) this.byCollection.set(c, kept);
      else this.byCollection.delete(c);
    }
  }

  hot(): HotMint[] {
    const out: HotMint[] = [];
    for (const [collection, arr] of this.byCollection) {
      if (arr.some((o) => o.value > 0n)) continue;
      const replayable = arr.filter((o) => !BLOCKED_SELECTORS.has(selectorOf(o.input)));
      if (replayable.length === 0) continue;
      const uniqueMinters = new Set(arr.map((o) => o.minter)).size;
      if (uniqueMinters < this.opts.minUniqueMinters || arr.length < this.opts.minMintTxs) continue;
      const template = replayable.reduce((a, b) => (b.blockNumber > a.blockNumber ? b : a));
      out.push({ collection, template, uniqueMinters, mintTxs: arr.length });
    }
    return out.sort((a, b) => b.uniqueMinters - a.uniqueMinters);
  }
}
