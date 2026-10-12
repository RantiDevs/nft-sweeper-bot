import type { Address, PublicClient } from "viem";
import { Mutex } from "./util.js";

/**
 * Hands out nonces locally so a wallet can fire txs back-to-back without
 * waiting for each to be mined. Call `resync` after any send error or
 * receipt timeout to re-read the pending nonce from the chain.
 */
export class NonceManager {
  private next = new Map<Address, number>();
  private locks = new Map<Address, Mutex>();

  constructor(private client: Pick<PublicClient, "getTransactionCount">) {}

  private lock(a: Address): Mutex {
    let m = this.locks.get(a);
    if (!m) this.locks.set(a, (m = new Mutex()));
    return m;
  }

  /** Reserves a nonce, runs `send` with it, and only commits it if `send` succeeds. */
  async use<T>(a: Address, send: (nonce: number) => Promise<T>): Promise<T> {
    return this.lock(a).run(async () => {
      let n = this.next.get(a);
      if (n === undefined) {
        n = await this.client.getTransactionCount({ address: a, blockTag: "pending" });
      }
      try {
        const res = await send(n);
        this.next.set(a, n + 1);
        return res;
      } catch (e) {
        this.next.delete(a);
        throw e;
      }
    });
  }

  resync(a: Address): void {
    this.next.delete(a);
  }
}
