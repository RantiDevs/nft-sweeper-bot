import { decodeAbiParameters, getAddress, toEventSelector, zeroAddress, type Address, type Hex } from "viem";
import { SEADROP_ADDRESS, PUBLIC_DROP_UPDATED, decodeDrop } from "./drops.js";
import { mapLimit, sleep } from "./util.js";

/**
 * Drop radar: finds FREE, PUBLIC mints that are live now or open within a time window, on many chains, by reading
 * the creators' own on-chain announcements. It never sends a transaction.
 *
 * Platforms understood (free only; a platform that charges a protocol fee on top of a "free" price cannot be minted by
 * this bot, which never sends value):
 *   - OpenSea SeaDrop  (PublicDropUpdated)
 *   - thirdweb Drop contracts (ClaimConditionsUpdated)
 * Allowlist / signature / merkle-proof stages are ignored: a stranger's wallet cannot mint them.
 *
 * It keeps a bookmark per chain and platform, so after the first pass it reads only new blocks.
 */

export interface ChainSpec {
  name: string;
  chainId: number;
  rpcs: string[];
  symbol: string;
}

/** Public endpoints. Each is checked with eth_chainId before use, so a dead or wrong one is reported, not trusted. */
export const DEFAULT_CHAINS: ChainSpec[] = [
  { name: "Ethereum", chainId: 1, symbol: "ETH", rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"] },
  { name: "Base", chainId: 8453, symbol: "ETH", rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"] },
  { name: "Arbitrum", chainId: 42161, symbol: "ETH", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"] },
  { name: "Optimism", chainId: 10, symbol: "ETH", rpcs: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"] },
  { name: "Polygon", chainId: 137, symbol: "POL", rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"] },
  { name: "HyperEVM", chainId: 999, symbol: "HYPE", rpcs: ["https://rpc.hyperliquid.xyz/evm"] },
  { name: "Elysium", chainId: 99901, symbol: "HYPE", rpcs: ["https://rpc.elysium.kinetiq.xyz"] },
  { name: "Robinhood Chain", chainId: 4663, symbol: "ETH", rpcs: [] },
  { name: "Abstract", chainId: 2741, symbol: "ETH", rpcs: ["https://api.mainnet.abs.xyz"] },
  { name: "Ink", chainId: 57073, symbol: "ETH", rpcs: ["https://rpc-gel.inkonchain.com", "https://ink.drpc.org"] },
  { name: "Unichain", chainId: 130, symbol: "ETH", rpcs: ["https://mainnet.unichain.org"] },
  { name: "Soneium", chainId: 1868, symbol: "ETH", rpcs: ["https://rpc.soneium.org"] },
  { name: "Shape", chainId: 360, symbol: "ETH", rpcs: ["https://mainnet.shape.network"] },
  { name: "Sei", chainId: 1329, symbol: "SEI", rpcs: ["https://evm-rpc.sei-apis.com"] },
  { name: "Ronin", chainId: 2020, symbol: "RON", rpcs: ["https://api.roninchain.com/rpc"] },
  { name: "ApeChain", chainId: 33139, symbol: "APE", rpcs: ["https://apechain.calderachain.xyz/http", "https://rpc.apechain.com"] },
  { name: "Monad", chainId: 143, symbol: "MON", rpcs: ["https://rpc.monad.xyz"] },
  { name: "MegaETH", chainId: 4326, symbol: "ETH", rpcs: ["https://mainnet.megaeth.com/rpc"] },
  { name: "Flow EVM", chainId: 747, symbol: "FLOW", rpcs: ["https://mainnet.evm.nodes.onflow.org"] },
  { name: "BNB Chain", chainId: 56, symbol: "BNB", rpcs: ["https://bsc-dataseed.binance.org"] },
  { name: "Avalanche", chainId: 43114, symbol: "AVAX", rpcs: ["https://api.avax.network/ext/bc/C/rpc"] },
  { name: "Zora", chainId: 7777777, symbol: "ETH", rpcs: ["https://rpc.zora.energy"] },
  { name: "Blast", chainId: 81457, symbol: "ETH", rpcs: ["https://rpc.blast.io"] },
];

export type Platform = "seadrop" | "thirdweb";

/** One mintable stage, whatever platform announced it. */
export interface RadarDrop {
  platform: Platform;
  /** The NFT collection. */
  nft: Address;
  /** Contract the mint call goes to (SeaDrop for SeaDrop; the collection itself for thirdweb). */
  mintTo: Address;
  priceWei: bigint;
  startTime: number;
  endTime: number;
  maxPerWallet: number;
  /** Supply cap known from the announcement (thirdweb), if any. */
  maxClaimable?: bigint;
  /** thirdweb: the payment currency the claim must name. */
  currency?: Address;
  restrictFeeRecipients?: boolean;
  feeBps?: number;
  block: bigint;
}

export interface RadarHit {
  chain: string;
  chainId: number;
  symbol: string;
  drop: RadarDrop;
  state: "LIVE" | "SOON";
  /** Seconds until open (negative: already open). */
  opensInSec: number;
}

export interface ChainReport {
  chain: string;
  ok: boolean;
  note: string;
  announcements: number;
  tookMs: number;
}

export type Rpc = (method: string, params: unknown[]) => Promise<any>;

// ── thirdweb ────────────────────────────────────────────────────────────────
export const TW_CLAIM_CONDITIONS_UPDATED = toEventSelector(
  "ClaimConditionsUpdated((uint256,uint256,uint256,uint256,bytes32,uint256,address,string)[],bool)",
);
const twParams = [
  {
    type: "tuple[]",
    components: [
      { name: "startTimestamp", type: "uint256" },
      { name: "maxClaimableSupply", type: "uint256" },
      { name: "supplyClaimed", type: "uint256" },
      { name: "quantityLimitPerWallet", type: "uint256" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "pricePerToken", type: "uint256" },
      { name: "currency", type: "address" },
      { name: "metadata", type: "string" },
    ],
  },
  { type: "bool" },
] as const;
const ZERO_ROOT = "0x" + "00".repeat(32);
const BIG = 1_000_000;

/** Every public (no allowlist) condition of a thirdweb announcement. Free-ness is judged later. */
export function decodeThirdweb(log: { address: Address; data: Hex; blockNumber: Hex | bigint }): RadarDrop[] {
  try {
    const [conds] = decodeAbiParameters(twParams, log.data);
    const sorted = [...conds].sort((a, b) => (a.startTimestamp < b.startTimestamp ? -1 : 1));
    const nft = getAddress(log.address);
    return sorted.map((c, i) => {
      const next = sorted[i + 1];
      const start = Number(c.startTimestamp > 4_000_000_000n ? 4_000_000_000n : c.startTimestamp);
      return {
        platform: "thirdweb" as const,
        nft,
        mintTo: nft,
        // A condition with an allowlist root is not public: mark it unmintable by giving it a price we never accept.
        priceWei: c.merkleRoot === ZERO_ROOT ? c.pricePerToken : (1n << 255n),
        startTime: start,
        endTime: next ? Number(next.startTimestamp) : start + 365 * 86400,
        maxPerWallet: c.quantityLimitPerWallet > BigInt(BIG) ? BIG : Number(c.quantityLimitPerWallet),
        maxClaimable: c.maxClaimableSupply < (1n << 128n) ? c.maxClaimableSupply : undefined,
        currency: getAddress(c.currency),
        block: BigInt(log.blockNumber),
      };
    });
  } catch {
    return [];
  }
}

export function decodeSeaDrop(log: { address: Address; topics: readonly Hex[]; data: Hex; blockNumber: Hex | bigint }): RadarDrop | null {
  const d = decodeDrop(log);
  if (!d) return null;
  return {
    platform: "seadrop",
    nft: d.nft,
    mintTo: d.seaDrop,
    priceWei: d.mintPrice,
    startTime: d.startTime,
    endTime: d.endTime,
    maxPerWallet: d.maxPerWallet,
    restrictFeeRecipients: d.restrictFeeRecipients,
    feeBps: d.feeBps,
    block: d.block,
  };
}

/** Free, public, not over, sane times, opening within `windowSec`. */
export function isOpenSoon(d: RadarDrop, nowSec: number, windowSec: number): boolean {
  return d.priceWei === 0n && d.maxPerWallet > 0 && d.endTime > d.startTime && d.endTime > nowSec && d.startTime <= nowSec + windowSec;
}

// ── state kept between passes ──────────────────────────────────────────────
export interface StoredAnn {
  chainId: number;
  platform: Platform;
  block: string;
  drops: (Omit<RadarDrop, "priceWei" | "block" | "maxClaimable"> & { priceWei: string; block: string; maxClaimable?: string })[];
}
export interface RadarState {
  /** key `${chainId}:${platform}` -> last block fully scanned. */
  bookmarks: Record<string, string>;
  /** key `${chainId}:${platform}:${nft}` -> latest announcement for that collection. */
  ann: Record<string, StoredAnn>;
}
export const emptyState = (): RadarState => ({ bookmarks: {}, ann: {} });

const toStored = (d: RadarDrop): StoredAnn["drops"][number] => ({ ...d, priceWei: d.priceWei.toString(), block: d.block.toString(), maxClaimable: d.maxClaimable?.toString() });
const fromStored = (d: StoredAnn["drops"][number]): RadarDrop => ({ ...d, priceWei: BigInt(d.priceWei), block: BigInt(d.block), maxClaimable: d.maxClaimable ? BigInt(d.maxClaimable) : undefined });

// ── RPC ─────────────────────────────────────────────────────────────────────
export function makeRpc(urls: string[], timeoutMs: number): Rpc {
  let idx = 0;
  return async (method, params) => {
    let last: unknown;
    for (let i = 0; i < urls.length * 2; i++) {
      const url = urls[(idx + i) % urls.length];
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const j: any = await res.json();
        if (j.error) throw Object.assign(new Error(j.error.message ?? "rpc error"), { rpc: true });
        idx = (idx + i) % urls.length;
        return j.result;
      } catch (e: any) {
        last = e;
        if (e?.rpc) throw e; // the node answered: retrying elsewhere will not change a "range too large"
        await sleep(200 * (i + 1));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}

const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);

/** Scans upward from `from`, shrinking the range when the node complains. Returns the highest block fully covered. */
async function scanUp(
  rpc: Rpc,
  filter: { address?: Address; topics: string[] },
  from: bigint,
  to: bigint,
  startSpan: bigint,
  budgetMs: number,
  onLogs: (logs: any[]) => void,
): Promise<{ upTo: bigint; complete: boolean; note?: string }> {
  const deadline = Date.now() + budgetMs;
  let span = startSpan;
  let cursor = from;
  while (cursor <= to) {
    if (Date.now() > deadline) return { upTo: cursor - 1n, complete: false, note: "time budget reached; continuing next pass" };
    const hi = cursor + span - 1n < to ? cursor + span - 1n : to;
    try {
      onLogs(await rpc("eth_getLogs", [{ ...filter, fromBlock: hex(cursor), toBlock: hex(hi) }]));
      cursor = hi + 1n;
      if (span < startSpan) span = span * 2n > startSpan ? startSpan : span * 2n;
    } catch (e: any) {
      if (span <= 20n) return { upTo: cursor - 1n, complete: false, note: `getLogs refused: ${String(e?.message).slice(0, 70)}` };
      span = span / 4n || 1n;
    }
  }
  return { upTo: to, complete: true };
}

export interface RadarOptions {
  windowSec: number;
  /** How far back to look on a chain's FIRST pass. Later passes continue from the bookmark. */
  lookbackHours: number;
  chains?: ChainSpec[];
  /** Extra / override RPCs by chain id (for example the Robinhood Chain URL from .env). */
  rpcOverrides?: Record<number, string[]>;
  perChainBudgetMs?: number;
  nowSec?: number;
  state?: RadarState;
  /** Skip the thirdweb scan (it reads every contract's events, which some public RPCs refuse). */
  platforms?: Platform[];
}

export async function runRadar(opts: RadarOptions): Promise<{ hits: RadarHit[]; reports: ChainReport[]; rpcs: Map<number, Rpc>; state: RadarState }> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const chains = opts.chains ?? DEFAULT_CHAINS;
  const budget = opts.perChainBudgetMs ?? 45_000;
  const state = opts.state ?? emptyState();
  // thirdweb is OFF unless asked for: it needs address-less eth_getLogs, which free public RPCs refuse (tested on
  // Base: publicnode, mainnet.base.org and drpc all reject or rate-limit it), and its decoder has not been checked
  // against live logs. Turn it on with RADAR_PLATFORMS=seadrop,thirdweb and an RPC that allows it.
  const platforms = opts.platforms ?? ["seadrop"];
  const rpcs = new Map<number, Rpc>();

  const reports = await mapLimit(chains, 6, async (c): Promise<ChainReport> => {
    const t0 = Date.now();
    const urls = [...(opts.rpcOverrides?.[c.chainId] ?? []), ...c.rpcs];
    const done = (ok: boolean, note: string, announcements = 0): ChainReport => ({ chain: c.name, ok, note, announcements, tookMs: Date.now() - t0 });
    if (urls.length === 0) return done(false, "no RPC configured");
    try {
      const rpc = makeRpc(urls, 8000);
      const id = Number(BigInt(await rpc("eth_chainId", [])));
      if (id !== c.chainId) return done(false, `RPC answered chain ${id}, expected ${c.chainId}`);
      rpcs.set(c.chainId, rpc);

      const head = BigInt(await rpc("eth_blockNumber", []));
      const sample = 20_000n < head ? 20_000n : head - 1n;
      const [hb, ob] = await Promise.all([rpc("eth_getBlockByNumber", [hex(head), false]), rpc("eth_getBlockByNumber", [hex(head - sample), false])]);
      const secPerBlock = Math.max(0.05, (Number(BigInt(hb.timestamp)) - Number(BigInt(ob.timestamp))) / Number(sample));
      const firstFrom = head > BigInt(Math.ceil((opts.lookbackHours * 3600) / secPerBlock)) ? head - BigInt(Math.ceil((opts.lookbackHours * 3600) / secPerBlock)) : 0n;

      const notes: string[] = [];
      let seen = 0;
      for (const platform of platforms) {
        const bmKey = `${c.chainId}:${platform}`;
        if (platform === "seadrop") {
          const code = await rpc("eth_getCode", [SEADROP_ADDRESS, "latest"]);
          if (!code || code === "0x") {
            notes.push("no SeaDrop");
            continue;
          }
        }
        const from = state.bookmarks[bmKey] ? BigInt(state.bookmarks[bmKey]) + 1n : firstFrom;
        const filter = platform === "seadrop" ? { address: SEADROP_ADDRESS, topics: [PUBLIC_DROP_UPDATED] } : { topics: [TW_CLAIM_CONDITIONS_UPDATED] };
        const found: any[] = [];
        const r = await scanUp(rpc, filter, from, head, platform === "seadrop" ? 10_000n : 2_000n, budget / platforms.length, (l) => found.push(...l));
        if (r.upTo >= from) state.bookmarks[bmKey] = r.upTo.toString();
        for (const l of found) {
          const drops = platform === "seadrop" ? [decodeSeaDrop({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber })].filter((d): d is RadarDrop => !!d) : decodeThirdweb(l);
          if (drops.length === 0) continue;
          const key = `${c.chainId}:${platform}:${drops[0].nft}`;
          const prev = state.ann[key];
          if (prev && BigInt(prev.block) > drops[0].block) continue;
          state.ann[key] = { chainId: c.chainId, platform, block: drops[0].block.toString(), drops: drops.map(toStored) };
        }
        seen += Object.values(state.ann).filter((a) => a.chainId === c.chainId && a.platform === platform).length;
        notes.push(`${platform} ${r.complete ? "up to date" : "partial"}${r.note ? ` (${r.note})` : ""}`);
      }
      return done(true, `${notes.join("; ")} (${secPerBlock.toFixed(2)}s/block)`, seen);
    } catch (e: any) {
      return done(false, String(e?.message ?? e).slice(0, 100));
    }
  });

  // Forget announcements that are over, so the state does not grow without limit.
  for (const [k, a] of Object.entries(state.ann)) if (a.drops.every((d) => d.endTime < now - 3600)) delete state.ann[k];

  const hits: RadarHit[] = [];
  for (const a of Object.values(state.ann)) {
    const c = chains.find((x) => x.chainId === a.chainId);
    if (!c) continue;
    for (const s of a.drops) {
      const d = fromStored(s);
      if (!isOpenSoon(d, now, opts.windowSec)) continue;
      const opensIn = d.startTime - now;
      hits.push({ chain: c.name, chainId: c.chainId, symbol: c.symbol, drop: d, state: opensIn <= 0 ? "LIVE" : "SOON", opensInSec: opensIn });
    }
  }
  hits.sort((a, b) => a.opensInSec - b.opensInSec);
  return { hits, reports, rpcs, state };
}

export { zeroAddress };
