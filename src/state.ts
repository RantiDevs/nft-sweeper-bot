import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type Address } from "viem";
import type { Standard } from "./logs.js";

export interface Holding {
  collection: Address;
  standard: Standard;
  tokenId: string;
  amount: string;
  tx: string;
}

interface StateData {
  /** collection -> wallet -> successful mint txs sent */
  minted: Record<string, Record<string, number>>;
  /** collection -> reason it is never minted again */
  bad: Record<string, string>;
  /** wallet -> NFTs it minted that have not been collected to the vault yet */
  holdings: Record<string, Holding[]>;
  /** total wei spent on gas by all our wallets (decimal string) */
  gasSpentWei: string;
}

const empty = (): StateData => ({ minted: {}, bad: {}, holdings: {}, gasSpentWei: "0" });

/**
 * Persistent bot state. Writes are atomic (write temp file, rename) so a crash
 * or Ctrl-C mid-write never corrupts it.
 */
export class State {
  private data: StateData = empty();

  constructor(private file: string) {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      // Older state files stored `bad` as an array.
      if (Array.isArray(raw.bad)) raw.bad = Object.fromEntries(raw.bad.map((c: string) => [c, "legacy"]));
      this.data = { ...empty(), ...raw };
    }
  }

  mintCount(collection: Address, wallet: Address): number {
    return this.data.minted[collection]?.[wallet] ?? 0;
  }

  recordMint(collection: Address, wallet: Address, holdings: Holding[]): void {
    const m = (this.data.minted[collection] ??= {});
    m[wallet] = (m[wallet] ?? 0) + 1;
    (this.data.holdings[wallet] ??= []).push(...holdings);
    this.save();
  }

  holdings(wallet: Address): Holding[] {
    return this.data.holdings[wallet] ?? [];
  }

  removeHolding(wallet: Address, h: Holding): void {
    this.data.holdings[wallet] = this.holdings(wallet).filter(
      (x) => !(x.collection === h.collection && x.tokenId === h.tokenId),
    );
    this.save();
  }

  isBad(collection: Address): boolean {
    return collection in this.data.bad;
  }

  markBad(collection: Address, reason: string): void {
    this.data.bad[collection] = reason;
    this.save();
  }

  gasSpent(): bigint {
    return BigInt(this.data.gasSpentWei);
  }

  addGasSpent(wei: bigint): void {
    this.data.gasSpentWei = (this.gasSpent() + wei).toString();
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
