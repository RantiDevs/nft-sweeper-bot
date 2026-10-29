import type { Address } from "viem";
import { sleep } from "../util.js";

/**
 * Optional OpenSea data (floor price, owners, recent volume). Everything here is best
 * effort: a missing key, an unknown chain, a rate limit or a bad response yields
 * `undefined`, never an exception, so valuation falls back to on-chain sales.
 *
 * API v2 paths used (verify against docs.opensea.io, they may change):
 *   GET /api/v2/chains                                  list chains and their slugs
 *   GET /api/v2/chain/{chain}/contract/{address}        contract -> collection slug
 *   GET /api/v2/collections/{slug}/stats                floor, volume, owners
 */

export interface OpenSeaStats {
  floorEth?: number;
  owners?: number;
  salesTotal?: number;
  sales24h?: number;
  volume24hEth?: number;
}

export interface OpenSeaOptions {
  apiKey?: string;
  /** Override the chain slug; otherwise it is looked up from /chains. */
  chainSlug?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const ETHLIKE = new Set(["ETH", "WETH"]);

export class OpenSeaClient {
  private chain?: string;
  private slugs = new Map<Address, string | null>();

  constructor(private opts: OpenSeaOptions) {
    this.chain = opts.chainSlug;
  }

  get enabled(): boolean {
    return !!this.opts.apiKey;
  }

  private async get(path: string, retries = 2): Promise<unknown | undefined> {
    if (!this.opts.apiKey) return undefined;
    const f = this.opts.fetchFn ?? fetch;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await f(`${this.opts.baseUrl ?? "https://api.opensea.io"}${path}`, {
          headers: { accept: "application/json", "x-api-key": this.opts.apiKey },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
        });
        if (res.status === 429 && i < retries) {
          await sleep(1000 * (i + 1));
          continue;
        }
        return res.ok ? await res.json() : undefined;
      } catch {
        if (i === retries) return undefined;
      }
    }
    return undefined;
  }

  private async chainSlug(): Promise<string | undefined> {
    if (this.chain) return this.chain;
    const body = (await this.get("/api/v2/chains")) as { chains?: { chain?: string; name?: string }[] } | undefined;
    const hit = body?.chains?.find((c) => /robinhood/i.test(`${c.chain} ${c.name}`));
    this.chain = hit?.chain;
    return this.chain;
  }

  /** The chain slug OpenSea uses for this chain (looked up once), or undefined if it is not listed. */
  async discoverChain(): Promise<string | undefined> {
    return this.chainSlug();
  }

  private async collectionSlug(address: Address): Promise<string | undefined> {
    const known = this.slugs.get(address);
    if (known !== undefined) return known ?? undefined;
    const chain = await this.chainSlug();
    if (!chain) return undefined;
    const body = (await this.get(`/api/v2/chain/${chain}/contract/${address}`)) as { collection?: string } | undefined;
    this.slugs.set(address, body?.collection ?? null);
    return body?.collection;
  }

  async stats(address: Address): Promise<OpenSeaStats | undefined> {
    if (!this.enabled) return undefined;
    const slug = await this.collectionSlug(address);
    if (!slug) return undefined;
    const body = (await this.get(`/api/v2/collections/${encodeURIComponent(slug)}/stats`)) as
      | {
          total?: { floor_price?: number; floor_price_symbol?: string; num_owners?: number; sales?: number };
          intervals?: { interval?: string; sales?: number; volume?: number }[];
        }
      | undefined;
    if (!body?.total) return undefined;
    const day = body.intervals?.find((i) => i.interval === "one_day");
    const t = body.total;
    return {
      // A floor quoted in another currency is not comparable with ETH, so it is dropped.
      floorEth: t.floor_price && ETHLIKE.has((t.floor_price_symbol ?? "").toUpperCase()) ? t.floor_price : undefined,
      owners: t.num_owners,
      salesTotal: t.sales,
      sales24h: day?.sales,
      volume24hEth: day?.volume,
    };
  }
}
