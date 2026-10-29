/**
 * Live ETH/USD price from public feeds, so every amount can be shown in dollars without
 * the operator typing a price. Several independent sources are queried and the median is
 * used, a single wrong feed can't move it, and the last good price is kept if all feeds
 * fail. A manual `fallback` (ETH_USD) is used only when no feed has ever answered.
 */

export type PriceSource = { name: string; url: string; parse: (body: unknown) => number | undefined };

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export const DEFAULT_SOURCES: PriceSource[] = [
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    parse: (b) => num((b as { data?: { amount?: string } })?.data?.amount),
  },
  {
    name: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=ETHUSD",
    parse: (b) => {
      const result = (b as { result?: Record<string, { c?: string[] }> })?.result;
      return num(result && Object.values(result)[0]?.c?.[0]);
    },
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    parse: (b) => num((b as { ethereum?: { usd?: number } })?.ethereum?.usd),
  },
];

export interface PriceOptions {
  sources?: PriceSource[];
  fetchFn?: typeof fetch;
  /** Manual price used only until a feed has answered. */
  fallback?: number;
  /** How long a fetched price is reused. */
  ttlMs?: number;
  timeoutMs?: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class EthPriceOracle {
  private last?: { price: number; at: number };
  private inflight?: Promise<number | undefined>;

  constructor(private opts: PriceOptions = {}) {}

  /** The newest known price without any network call (undefined if none and no fallback). */
  peek(): number | undefined {
    return this.last?.price ?? this.opts.fallback;
  }

  /** True when the price comes from the manual fallback or a feed that stopped answering. */
  get stale(): boolean {
    return !this.last || Date.now() - this.last.at > (this.opts.ttlMs ?? 60_000) * 10;
  }

  async get(): Promise<number | undefined> {
    const ttl = this.opts.ttlMs ?? 60_000;
    if (this.last && Date.now() - this.last.at < ttl) return this.last.price;
    this.inflight ??= this.refresh().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async refresh(): Promise<number | undefined> {
    const f = this.opts.fetchFn ?? fetch;
    const results = await Promise.all(
      (this.opts.sources ?? DEFAULT_SOURCES).map(async (s) => {
        try {
          const res = await f(s.url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000), headers: { accept: "application/json" } });
          return res.ok ? s.parse(await res.json()) : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const prices = results.filter((p): p is number => p !== undefined);
    if (prices.length > 0) {
      const price = median(prices);
      // One lone feed that jumps far from the last good price is more likely wrong than right.
      const jump = this.last ? Math.abs(price / this.last.price - 1) : 0;
      if (prices.length >= 2 || jump < 0.4) {
        this.last = { price, at: Date.now() };
        return price;
      }
    }
    return this.peek();
  }
}
