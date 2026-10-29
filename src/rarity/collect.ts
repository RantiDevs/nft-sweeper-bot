import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi, type Address, type PublicClient } from "viem";
import { errMsg, mapLimit } from "../util.js";
import { extractTraits, hasRaritySignal, scoreCollection, type Scored, type Trait } from "./score.js";
import { loadMetadata, type TextFetcher } from "./uri.js";

const abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
]);

export interface RarityOptions {
  /** Max tokens whose metadata is fetched to estimate trait frequencies (your tokens are always included). */
  sample: number;
  /** Concurrent metadata downloads per collection. */
  concurrency: number;
  /** Directory for the metadata cache (shared across users and runs). */
  cacheDir?: string;
  gateways?: string[];
  fetchText?: TextFetcher;
}

export interface CollectionRarity {
  collection: Address;
  supply?: number;
  /** Tokens whose metadata was read and scored. */
  scoredCount: number;
  failed: number;
  /** What the ranks are relative to: every token, a sample of the collection, or only your own tokens. */
  basis: "collection" | "sample" | "yours";
  /** Present when tokens could not be ranked; explains why. */
  unrankedReason?: string;
  scores: Map<string, Scored>;
}

/** Without a known supply, rank against your own tokens only if you hold at least this many. */
const MIN_OWN_BASIS = 30;

type CacheFile = Record<string, Trait[] | null>;

function cachePath(dir: string, collection: Address): string {
  return join(dir, `${collection.toLowerCase()}.json`);
}

function readCache(dir: string | undefined, collection: Address): CacheFile {
  if (!dir) return {};
  const p = cachePath(dir, collection);
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CacheFile) : {};
  } catch {
    return {};
  }
}

function writeCache(dir: string | undefined, collection: Address, data: CacheFile): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const p = cachePath(dir, collection);
  writeFileSync(`${p}.tmp`, JSON.stringify(data));
  renameSync(`${p}.tmp`, p);
}

/** Deterministic sample (same collection → same sample, so cached metadata is reused). */
function sampleIds(start: bigint, supply: number, size: number, seed: string): bigint[] {
  if (supply <= size) return Array.from({ length: supply }, (_, i) => start + BigInt(i));
  const picked = new Set<number>();
  let h = createHash("sha256").update(seed).digest();
  let i = 0;
  while (picked.size < size) {
    if (i + 4 > h.length) {
      h = createHash("sha256").update(h).digest();
      i = 0;
    }
    picked.add(h.readUInt32BE(i) % supply);
    i += 4;
  }
  return [...picked].map((k) => start + BigInt(k));
}

/**
 * Ranks the given token ids of an ERC-721 collection by trait rarity, measured
 * against the whole collection (or a deterministic sample of it).
 */
export async function rankCollection(
  client: PublicClient,
  collection: Address,
  heldIds: string[],
  opts: RarityOptions,
): Promise<CollectionRarity> {
  const base: CollectionRarity = { collection, scoredCount: 0, failed: 0, basis: "collection", scores: new Map() };
  const read = (id: bigint) => client.readContract({ address: collection, abi, functionName: "tokenURI", args: [id] });

  let supply: number | undefined;
  try {
    const s = await client.readContract({ address: collection, abi, functionName: "totalSupply" });
    if (s > 0n && s < 10_000_000n) supply = Number(s);
  } catch {
    supply = undefined;
  }

  // Ids usually run 0..n-1 or 1..n. Probe which.
  let ids: bigint[];
  if (supply !== undefined) {
    const start = await read(0n).then(() => 0n, () => 1n);
    ids = sampleIds(start, supply, opts.sample, collection.toLowerCase());
  } else if (heldIds.length >= MIN_OWN_BASIS) {
    ids = [];
  } else {
    return { ...base, unrankedReason: "collection size unknown (no totalSupply), so rarity can't be measured" };
  }
  const all = new Set<string>([...ids.map(String), ...heldIds]);
  const idList = [...all];

  const uris = new Map<string, string>();
  let failed = 0;
  await mapLimit(idList, 25, async (id) => {
    try {
      uris.set(id, await read(BigInt(id)));
    } catch {
      failed++;
    }
  });

  const distinctUris = new Set(uris.values());
  if (uris.size >= 3 && distinctUris.size === 1) {
    return { ...base, supply, failed, unrankedReason: "not revealed yet (every token has the same metadata URI)" };
  }

  const cache = readCache(opts.cacheDir, collection);
  const traits = new Map<string, Trait[] | null>();
  let cacheDirty = false;
  await mapLimit(idList.filter((id) => uris.has(id)), opts.concurrency, async (id) => {
    const uri = uris.get(id)!;
    const key = createHash("sha256").update(uri).digest("hex").slice(0, 32);
    if (key in cache) {
      traits.set(id, cache[key]);
      return;
    }
    try {
      const t = extractTraits(await loadMetadata(uri, { gateways: opts.gateways, fetchText: opts.fetchText }));
      traits.set(id, t);
      cache[key] = t;
      cacheDirty = true;
    } catch {
      failed++;
    }
  });
  if (cacheDirty) {
    try {
      writeCache(opts.cacheDir, collection, cache);
    } catch (e) {
      void errMsg(e); // cache is an optimisation only
    }
  }

  const withTraits = [...traits].filter(([, t]) => t && t.length > 0).map(([id, t]) => ({ id, traits: t! }));
  const heldScorable = heldIds.filter((id) => traits.get(id)?.length);
  if (withTraits.length < 2 || heldScorable.length === 0) {
    return {
      ...base, supply, failed,
      unrankedReason: traits.size === 0 ? "metadata could not be loaded" : "metadata has no traits",
    };
  }

  const scored = scoreCollection(withTraits, supply);
  if (!hasRaritySignal(scored)) {
    return { ...base, supply, failed, scoredCount: scored.length, unrankedReason: "every token has the same traits" };
  }
  const scores = new Map(scored.map((s) => [s.id, s]));
  return {
    ...base,
    supply,
    failed,
    scoredCount: scored.length,
    basis: supply === undefined ? "yours" : scored.length < supply ? "sample" : "collection",
    scores,
  };
}
