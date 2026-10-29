/**
 * Global gas kill switch shared by all wallets. Each send reserves its
 * worst-case cost up front, so N wallets firing concurrently cannot overshoot
 * the budget; the reservation is replaced by the real cost once mined.
 * `limit` may be a function so a Telegram user can change theirs live.
 */
export class GasBudget {
  private reserved = 0n;

  constructor(private limit: bigint | (() => bigint), private spent: () => bigint) {}

  private cap(): bigint {
    return typeof this.limit === "function" ? this.limit() : this.limit;
  }

  tryReserve(wei: bigint): boolean {
    if (this.spent() + this.reserved + wei > this.cap()) return false;
    this.reserved += wei;
    return true;
  }

  release(wei: bigint): void {
    this.reserved = this.reserved > wei ? this.reserved - wei : 0n;
  }

  exhausted(): boolean {
    return this.spent() + this.reserved >= this.cap();
  }
}
