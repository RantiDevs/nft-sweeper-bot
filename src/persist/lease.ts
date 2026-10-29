import { randomUUID } from "node:crypto";
import { errMsg, log, sleep } from "../util.js";
import type { SupabaseKV } from "./supabase.js";

/**
 * A lock in Supabase that lets exactly one copy of the bot run at a time.
 *
 * Two copies would fight over one Telegram bot (it only allows one reader) and over the same wallets'
 * transaction counters, which can strand or double-send transactions. A copy takes the lock for 90
 * seconds and renews it every 30. If a copy dies, the lock simply runs out and the next one takes over,
 * which is also what lets a Render redeploy hand over cleanly (the new copy waits for the old one).
 */
export class Lease {
  readonly holder = randomUUID();
  private timer?: NodeJS.Timeout;
  private lastRenewedAt = 0;

  constructor(
    private kv: SupabaseKV,
    private name = "sweeper-bot",
    private ttlSeconds = 90,
  ) {}

  /** Take the lock, waiting up to `waitMs` for a previous copy to let go of it. */
  async acquire(waitMs = 150_000, pollMs = 5000): Promise<void> {
    const deadline = Date.now() + waitMs;
    let announced = false;
    for (;;) {
      let got = false;
      try {
        got = await this.kv.acquire(this.name, this.holder, this.ttlSeconds);
      } catch (e) {
        if (Date.now() >= deadline) throw new Error(`could not reach Supabase to take the run lock: ${errMsg(e)}`);
      }
      if (got) {
        this.lastRenewedAt = Date.now();
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("another copy of the bot is already running (it holds the Supabase lock). Stop it first, or wait about 90 seconds after it stops.");
      }
      if (!announced) {
        announced = true;
        log("another copy holds the run lock; waiting for it to finish (up to 2.5 minutes)…");
      }
      await sleep(pollMs);
    }
  }

  /** Keep the lock alive. `onLost` fires if it can no longer be held; the caller should exit. */
  start(onLost: (why: string) => void): void {
    const every = (this.ttlSeconds * 1000) / 3;
    this.timer = setInterval(async () => {
      try {
        if (await this.kv.acquire(this.name, this.holder, this.ttlSeconds)) {
          this.lastRenewedAt = Date.now();
          return;
        }
        onLost("the run lock was taken by another copy");
      } catch (e) {
        // Supabase unreachable. The lock is still ours until it expires; after that we cannot know.
        if (Date.now() - this.lastRenewedAt > this.ttlSeconds * 1000) onLost(`could not renew the run lock for ${this.ttlSeconds}s (${errMsg(e)})`);
      }
    }, every);
    this.timer.unref?.();
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.kv.release(this.name, this.holder).catch(() => {});
  }
}
