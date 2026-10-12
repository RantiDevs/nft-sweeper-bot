import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Address } from "viem";

interface StateData {
  /** collection -> wallet -> successful mint txs sent */
  minted: Record<string, Record<string, number>>;
  /** collections whose replayed mint did not deliver a token to us */
  bad: string[];
}

export class State {
  private data: StateData = { minted: {}, bad: [] };

  constructor(private file: string) {
    if (existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  mintCount(collection: Address, wallet: Address): number {
    return this.data.minted[collection]?.[wallet] ?? 0;
  }

  recordMint(collection: Address, wallet: Address): void {
    const m = (this.data.minted[collection] ??= {});
    m[wallet] = (m[wallet] ?? 0) + 1;
    this.save();
  }

  isBad(collection: Address): boolean {
    return this.data.bad.includes(collection);
  }

  markBad(collection: Address): void {
    if (!this.isBad(collection)) this.data.bad.push(collection);
    this.save();
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
