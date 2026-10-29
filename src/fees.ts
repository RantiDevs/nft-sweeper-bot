import type { PublicClient } from "viem";

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Latest block base fee; what you actually pay per gas (plus the tip). */
  baseFeePerGas?: bigint;
}

/**
 * EIP-1559 fees with generous base-fee headroom, cached briefly.
 *
 * Hot mints are exactly when base fee climbs; a tx whose maxFeePerGas falls
 * below the current base fee is stranded (queued, never mined). Bidding
 * `baseFee * multiplier + tip` keeps txs includable through a spike; you only
 * ever pay the actual base fee + tip, and per-tx caps are checked against this
 * worst case.
 *
 * The tip defaults to the configured minimum (0). Arbitrum Orbit chains order
 * transactions first-come-first-served, so a tip buys no priority and only adds
 * cost; set `useSuggestedTip` to follow the node's suggestion on other chains.
 */
/**
 * A representative mint-sized call (132 bytes of call data to an ordinary address). On this chain the
 * gas a transaction needs is dominated by the cost of posting its data to Ethereum, which can swing by
 * 100x within the hour, so the cost of a mint is measured, not assumed.
 */
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD" as const;
const PROBE_TO = "0x00000000000000000000000000000000DeaDBeef" as const;
const PROBE_DATA = `0x161ac21f${"3f9a1c7e5b2d8046".repeat(16)}` as const;
/** Typical gas for the mint's own execution, added to the measured data-posting part. */
const TYPICAL_EXECUTION_GAS = 150_000n;
const MINT_COST_TTL_MS = 20_000;

export class FeeOracle {
  private cached?: { at: number; fees: Fees };
  private mintProbe?: { at: number; gas: bigint };

  constructor(
    private client: Pick<PublicClient, "getBlock" | "estimateMaxPriorityFeePerGas">,
    private opts: { multiplier: number; minPriorityFeeWei: bigint; useSuggestedTip?: boolean; ttlMs?: number },
  ) {}

  async get(): Promise<Fees> {
    const ttl = this.opts.ttlMs ?? 2000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.fees;
    const [block, suggested] = await Promise.all([
      this.client.getBlock({ blockTag: "latest" }),
      this.opts.useSuggestedTip ? this.client.estimateMaxPriorityFeePerGas().catch(() => 0n) : Promise.resolve(0n),
    ]);
    const base = block.baseFeePerGas ?? 0n;
    const tip = suggested > this.opts.minPriorityFeeWei ? suggested : this.opts.minPriorityFeeWei;
    const mult = BigInt(Math.round(this.opts.multiplier * 100));
    const fees: Fees = { maxFeePerGas: (base * mult) / 100n + tip, maxPriorityFeePerGas: tip, baseFeePerGas: base };
    this.cached = { at: Date.now(), fees };
    return fees;
  }

  /**
   * What a typical mint costs RIGHT NOW (gas units and wei), measured with a real gas estimate of a
   * mint-sized call and cached for 20 seconds. One cheap call lets the bot hold off all work while gas
   * is too dear, instead of checking every collection just to find out.
   */
  async mintCost(client: Pick<PublicClient, "estimateGas">): Promise<{ gas: bigint; costWei: bigint }> {
    if (!this.mintProbe || Date.now() - this.mintProbe.at > MINT_COST_TTL_MS) {
      const gas = await client.estimateGas({ account: PROBE_FROM, to: PROBE_TO, data: PROBE_DATA });
      this.mintProbe = { at: Date.now(), gas };
    }
    const fees = await this.get();
    const price = (fees.baseFeePerGas ?? fees.maxFeePerGas) + fees.maxPriorityFeePerGas;
    const gas = this.mintProbe.gas + TYPICAL_EXECUTION_GAS;
    return { gas, costWei: gas * price };
  }

  /** Fees for replacing a stuck tx: fresh quote, but at least +30% on both fields. */
  async bump(prev: Fees): Promise<Fees> {
    this.cached = undefined;
    const fresh = await this.get();
    const up = (x: bigint) => (x * 130n) / 100n + 1n;
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    return {
      baseFeePerGas: fresh.baseFeePerGas,
      maxFeePerGas: max(fresh.maxFeePerGas, up(prev.maxFeePerGas)),
      maxPriorityFeePerGas: max(fresh.maxPriorityFeePerGas, up(prev.maxPriorityFeePerGas)),
    };
  }
}
