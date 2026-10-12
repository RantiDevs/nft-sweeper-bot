import type { PublicClient } from "viem";

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * EIP-1559 fees with generous base-fee headroom, cached briefly.
 *
 * Hot mints are exactly when base fee climbs; a tx whose maxFeePerGas falls
 * below the current base fee is stranded (queued, never mined). Bidding
 * `baseFee * multiplier + tip` keeps txs includable through a spike; you only
 * ever pay the actual base fee + tip, and per-tx caps are checked against this
 * worst case.
 */
export class FeeOracle {
  private cached?: { at: number; fees: Fees };

  constructor(
    private client: Pick<PublicClient, "getBlock" | "estimateMaxPriorityFeePerGas">,
    private opts: { multiplier: number; minPriorityFeeWei: bigint; ttlMs?: number },
  ) {}

  async get(): Promise<Fees> {
    const ttl = this.opts.ttlMs ?? 2000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.fees;
    const [block, suggested] = await Promise.all([
      this.client.getBlock({ blockTag: "latest" }),
      this.client.estimateMaxPriorityFeePerGas().catch(() => 0n),
    ]);
    const base = block.baseFeePerGas ?? 0n;
    const tip = suggested > this.opts.minPriorityFeeWei ? suggested : this.opts.minPriorityFeeWei;
    const mult = BigInt(Math.round(this.opts.multiplier * 100));
    const fees = { maxFeePerGas: (base * mult) / 100n + tip, maxPriorityFeePerGas: tip };
    this.cached = { at: Date.now(), fees };
    return fees;
  }

  /** Fees for replacing a stuck tx: fresh quote, but at least +30% on both fields. */
  async bump(prev: Fees): Promise<Fees> {
    this.cached = undefined;
    const fresh = await this.get();
    const up = (x: bigint) => (x * 130n) / 100n + 1n;
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    return {
      maxFeePerGas: max(fresh.maxFeePerGas, up(prev.maxFeePerGas)),
      maxPriorityFeePerGas: max(fresh.maxPriorityFeePerGas, up(prev.maxPriorityFeePerGas)),
    };
  }
}
