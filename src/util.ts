/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Serialises async sections; callers queue behind whoever holds the lock. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

import { BaseError, ExecutionRevertedError } from "viem";

/** True when the node says the call itself reverts (as opposed to an RPC/network failure). */
export function isRevert(e: unknown): boolean {
  if (e instanceof BaseError && e.walk((x) => x instanceof ExecutionRevertedError)) return true;
  return /revert|invalid opcode|out of gas/i.test(errMsg(e)) || /revert/i.test(String((e as Error)?.message ?? ""));
}

export function errMsg(e: unknown): string {
  const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return msg.split("\n")[0];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

export class TimeoutError extends Error {}

/** Rejects if `p` has not settled within `ms`; guards against hung RPC calls. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
