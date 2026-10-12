/**
 * Global gas kill switch shared by all wallets. Each send reserves its
 * worst-case cost up front, so N wallets firing concurrently cannot overshoot
 * the budget; the reservation is replaced by the real cost once mined.
 */
export class GasBudget {
  private reserved = 0n;

  constructor(private limit: bigint, private spent: () => bigint) {}

  tryReserve(wei: bigint): boolean {
    if (this.spent() + this.reserved + wei > this.limit) return false;
    this.reserved += wei;
    return true;
  }

  release(wei: bigint): void {
    this.reserved = this.reserved > wei ? this.reserved - wei : 0n;
  }

  exhausted(): boolean {
    return this.spent() + this.reserved >= this.limit;
  }
}
