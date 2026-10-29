import { getAddress, getContractAddress, type Address, type Hex, type PublicClient } from "viem";
import { decodeDrop, PUBLIC_DROP_UPDATED, type Drop } from "./drops.js";
import { MintDetector, type HotMint, type MintObservation } from "./detector.js";
import { isNftContract } from "./erc165.js";
import { Vetter, type ProbeStatus, type VetOptions, type VetResult } from "./vet.js";
import {
  parseMintLog,
  TRANSFER_BATCH_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_TOPIC,
  ZERO_TOPIC,
} from "./logs.js";
import { errMsg, log, mapLimit, sleep } from "./util.js";

const MAX_LOG_RANGE = 2000n;
/** Parallel getTransaction calls while scanning. Public RPCs rate limit hard; paid ones can take more. */
const TX_FETCH_CONCURRENCY = Number(process.env.RPC_CONCURRENCY) > 0 ? Number(process.env.RPC_CONCURRENCY) : 8;
const HEARTBEAT_MS = 60_000;
const MAX_RANGE_FAILURES = 5;

type LiveTx = { hash: string; from: string; to: string | null; input: string; value: string; blockNumber: string | null; nonce?: string };
type LiveBlock = { transactions: LiveTx[] };

class FeedUnsupported extends Error {}
const isFeedUnsupported = (e: unknown) =>
  e instanceof FeedUnsupported || /not found|not supported|unsupported|disabled|does not exist|method/i.test(errMsg(e));

/** If further behind than this, catch up with the cheaper log scan before switching to the live feed. */
const CATCH_UP_BLOCKS = 600n;
const MAX_PREFETCH = 16;
const MAX_STEPS_PER_TICK = 50;

type RpcLog = { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex };

/**
 * Something that reacts to hot mints: one CLI wallet set, or one Telegram
 * user. The watcher scans the chain once and fans the result out to all of
 * them, so adding users does not add RPC load for block scanning.
 */
export interface Subscriber {
  /** False for collections this subscriber never wants (deny/allow lists, known-bad). */
  wants(collection: Address): boolean;
  /** True for the subscriber's own wallets; their mints are not counted as organic activity. */
  owns(minter: Address): boolean;
  /** Lowest thresholds this subscriber could act on; undefined while paused/inactive. */
  floor(): { minUniqueMinters: number; minMintTxs: number } | undefined;
  /** Called every tick with all free-mint collections at or above the combined floor. Must not block. */
  offer(hot: HotMint[], helpers: OfferHelpers): void;
  /** A drop announced on-chain (price, start and end time) before it opens. Must not block. */
  offerDrop?(drop: Drop, helpers: OfferHelpers): void;
}

/** Shared, cached checks the watcher provides so every subscriber doesn't repeat RPC work. */
export interface OfferHelpers {
  isNft: (collection: Address) => Promise<boolean>;
  /** Safety screening; `probeFrom` is a wallet address used to simulate the mint for tracing. */
  /** Free simulation of a mint call from `from`: is it open, and would a token land in `from`? */
  probe: (from: Address, collection: Address, to: Address, data: Hex) => Promise<ProbeStatus>;
  vet: (hot: HotMint, probeFrom: Address, opts?: { requireVerified?: boolean; trace?: boolean; simulate?: boolean }) => Promise<VetResult>;
}

export interface WatcherOptions {
  windowBlocks: number;
  /** Blocks to scan back at startup (default: the whole window). */
  backfillBlocks?: number;
  /**
   * Fast discovery: fetch the next blocks, their transactions and the mint logs in ONE batched
   * request per tick, instead of getBlockNumber + getLogs + one getTransaction per mint.
   * Falls back automatically if the RPC cannot do it.
   */
  liveFeed?: boolean;
  /** Client for the checks done on a candidate (code, ERC-165, simulation). Defaults to the watching client. */
  actionClient?: PublicClient;
  /** SeaDrop contract whose drop announcements to follow (undefined: off). */
  seaDrop?: Address;
  /** Called whenever a push source (WebSocket) reports a new head, to wake the loop immediately. */
  onWake?: (wake: () => void) => void;
  pollIntervalMs: number;
  /** Extra text appended to the periodic heartbeat log line. */
  heartbeatExtra?: () => string;
  /** Operational problems worth a human's attention (skipped block ranges). */
  onAlert?: (text: string) => void;
  /** Defaults used by the shared vetter (verification lookups and tracing). */
  vet?: Partial<VetOptions>;
}

export class Watcher {
  readonly detector: MintDetector;
  private subscribers = new Set<Subscriber>();
  private logRange = MAX_LOG_RANGE;
  private cursor = 0n;
  private head = 0n;
  private stopping = false;
  /** When a tick last finished successfully; used to detect a stalled RPC. */
  lastOkAt = Date.now();
  private failures = 0;
  private feedOk: boolean;
  private wakeResolve?: () => void;
  /** Wall-clock time the newest observation was recorded (for latency reporting). */
  lastObservedAt = 0;
  private nftCheck = new Map<Address, Promise<boolean>>();
  private vetter: Vetter;

  constructor(private publicClient: PublicClient, private opts: WatcherOptions) {
    this.feedOk = opts.liveFeed === true;
    opts.onWake?.(() => this.wakeResolve?.());
    this.vetter = new Vetter(opts.actionClient ?? publicClient, { requireVerified: false, trace: true, ...opts.vet });
    // Thresholds are applied per subscriber through `floor`; the detector only
    // enforces "every observed mint was free".
    this.detector = new MintDetector({ windowBlocks: opts.windowBlocks, minUniqueMinters: 1, minMintTxs: 1 });
  }

  subscribe(s: Subscriber): void {
    this.subscribers.add(s);
  }

  unsubscribe(s: Subscriber): void {
    this.subscribers.delete(s);
  }

  stop(): void {
    this.stopping = true;
  }

  get stopped(): boolean {
    return this.stopping;
  }

  get currentHead(): bigint {
    return this.head;
  }

  /** Starts scanning `windowBlocks` back from the current head. */
  async init(): Promise<void> {
    this.head = await this.retry(() => this.publicClient.getBlockNumber());
    const window = BigInt(Math.min(this.opts.windowBlocks, this.opts.backfillBlocks ?? this.opts.windowBlocks));
    this.cursor = this.head > window ? this.head - window : 0n;
  }

  async run(): Promise<void> {
    await this.init();
    let lastBeat = 0;
    while (!this.stopping) {
      try {
        await this.tick();
        this.errorStreak = 0;
      } catch (e) {
        this.errorStreak++;
        log(`loop error (${this.errorStreak} in a row):`, errMsg(e));
      }
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        log(
          `♥ head ${this.head} | tracking ${this.detector.size()} collections | subscribers ${this.subscribers.size}` +
            (this.opts.heartbeatExtra ? ` | ${this.opts.heartbeatExtra()}` : ""),
        );
      }
      // After finding new blocks, look again at once; otherwise wait for the next poll or a push.
      // Healthy: poll fast. Struggling RPC: wait longer after each failure (up to 5 s) instead of hammering it.
      const pause = this.errorStreak ? Math.min(5000, this.opts.pollIntervalMs * 2 ** Math.min(this.errorStreak, 6)) : this.opts.pollIntervalMs;
      if (!this.advanced || this.errorStreak) await this.napOrWake(pause);
    }
  }

  private advanced = false;
  private errorStreak = 0;

  private napOrWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wakeResolve = undefined;
        resolve();
      }
      this.wakeResolve = done;
    });
  }

  async tick(): Promise<void> {
    this.advanced = false;
    if (this.feedOk && this.head - this.cursor <= CATCH_UP_BLOCKS) {
      try {
        // Keep stepping while there is a backlog (a few round trips at most), so one tick always
        // ends caught up with the chain.
        for (let i = 0; i < MAX_STEPS_PER_TICK && !this.stopping; i++) {
          const moved = await this.liveStep();
          this.advanced ||= moved;
          if (!moved || this.cursor > this.head) break;
        }
        this.detector.prune(this.head);
        this.lastOkAt = Date.now();
        this.dispatch();
        return;
      } catch (e) {
        if (!isFeedUnsupported(e)) throw e;
        log("fast block feed unavailable on this RPC; using the slower log scan:", errMsg(e));
        this.feedOk = false;
      }
    }
    this.head = await this.publicClient.getBlockNumber();
    while (this.cursor <= this.head && !this.stopping) {
      const end = this.cursor + this.logRange - 1n;
      const to = end < this.head ? end : this.head;
      try {
        await this.ingest(this.cursor, to);
        this.failures = 0;
      } catch (e) {
        // A range that keeps failing must not freeze every subscriber: after a few
        // attempts skip it, say so loudly, and move on to newer blocks.
        if (++this.failures < MAX_RANGE_FAILURES) throw e;
        const msg = `Skipped blocks ${this.cursor}-${to} after ${this.failures} failures: ${errMsg(e)}`;
        log(msg);
        this.opts.onAlert?.(`⚠️ ${msg}`);
        this.failures = 0;
      }
      this.cursor = to + 1n;
    }
    this.detector.prune(this.head);
    this.lastOkAt = Date.now();
    this.dispatch();
    this.advanced = false;
  }

  /**
   * One round trip: the chain head, the next K blocks with full transactions, and every
   * mint log from the cursor on, sent as a single JSON-RPC batch. Returns true if the
   * cursor moved. Blocks that don't exist yet come back null, so the bot learns of a new
   * block one round trip after it exists, with no separate "what is the head?" question.
   */
  async liveStep(): Promise<boolean> {
    const hex = (n: bigint) => `0x${n.toString(16)}`;
    const from = this.cursor;
    const behind = this.head >= from ? Number(this.head - from) + 1 : 1;
    const k = Math.min(MAX_PREFETCH, Math.max(2, behind));
    const rpc = (method: string, params: unknown[]) => this.publicClient.request({ method: method as never, params: params as never }) as Promise<unknown>;
    const [headHex, ...rest] = await Promise.all([
      rpc("eth_blockNumber", []),
      ...Array.from({ length: k }, (_, i) => rpc("eth_getBlockByNumber", [hex(from + BigInt(i)), true])),
      rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: "latest", topics: [TRANSFER_TOPIC, ZERO_TOPIC] }]),
      rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: "latest", topics: [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, ZERO_TOPIC] }]),
      ...(this.opts.seaDrop ? [rpc("eth_getLogs", [{ address: this.opts.seaDrop, fromBlock: hex(from), toBlock: "latest", topics: [PUBLIC_DROP_UPDATED] }])] : []),
    ]);
    if (typeof headHex !== "string") throw new FeedUnsupported("malformed eth_blockNumber reply");
    this.head = BigInt(headHex);
    const blocks = rest.slice(0, k) as (LiveBlock | null)[];
    const logs = [...(rest[k] as RpcLog[]), ...(rest[k + 1] as RpcLog[])];
    if (!Array.isArray(rest[k]) || !Array.isArray(rest[k + 1])) throw new FeedUnsupported("malformed eth_getLogs reply");

    // Only blocks that exist and are contiguous from the cursor count as seen.
    let last = from - 1n;
    const txs = new Map<string, LiveTx>();
    for (let i = 0; i < k; i++) {
      const b = blocks[i];
      if (b === null || b === undefined) break;
      if (typeof b !== "object" || !Array.isArray(b.transactions)) throw new FeedUnsupported("malformed eth_getBlockByNumber reply");
      last = from + BigInt(i);
      for (const t of b.transactions) if (typeof t === "object") txs.set(t.hash, t);
    }
    if (last < from) return false;

    const collectionsByTx = new Map<Hex, Set<Address>>();
    for (const l of logs) {
      if (BigInt(l.blockNumber) > last) continue; // the next round will fetch that block
      const m = parseMintLog(l);
      if (!m || !this.wanted(m.collection)) continue;
      let set = collectionsByTx.get(l.transactionHash);
      if (!set) collectionsByTx.set(l.transactionHash, (set = new Set()));
      set.add(m.collection);
    }
    for (const [hash, collections] of collectionsByTx) this.record(txs.get(hash), collections);

    // Drop announcements: a creator has set (or changed) a drop's price and start time.
    if (this.opts.seaDrop && Array.isArray(rest[k + 2])) this.handleDropLogs(rest[k + 2] as RpcLog[], last);

    // Brand-new contracts: warm the NFT check now, so the first mint finds it already answered.
    let warmed = 0;
    for (const t of txs.values()) {
      if (t.to === null && t.nonce !== undefined && warmed++ < 20) {
        try {
          void this.isNft(getContractAddress({ from: t.from as Address, nonce: BigInt(t.nonce) })).catch(() => {});
        } catch {
          // an address we cannot derive is simply not warmed
        }
      }
    }
    this.cursor = last + 1n;
    return true;
  }

  /** Turns a mint transaction into observations for each collection it minted. */
  private record(tx: LiveTx | undefined, collections: Set<Address>): void {
    if (!tx || !tx.to || tx.blockNumber == null) return;
    const minter = getAddress(tx.from);
    if (this.owned(minter)) return;
    for (const collection of collections) {
      this.detector.add({
        collection,
        txHash: tx.hash as Hex,
        blockNumber: BigInt(tx.blockNumber),
        minter,
        target: getAddress(tx.to),
        input: tx.input as Hex,
        value: BigInt(tx.value),
      });
      this.lastObservedAt = Date.now();
    }
  }

  private dispatch(): void {
    if (this.stopping) return;
    let minUnique = Infinity;
    let minTxs = Infinity;
    for (const s of this.subscribers) {
      const f = s.floor();
      if (!f) continue;
      minUnique = Math.min(minUnique, f.minUniqueMinters);
      minTxs = Math.min(minTxs, f.minMintTxs);
    }
    if (minUnique === Infinity) return;
    const hot = this.detector.hot({ minUniqueMinters: minUnique, minMintTxs: minTxs });
    if (hot.length === 0) return;
    const helpers = this.helpers();
    for (const s of this.subscribers) s.offer(hot, helpers);
  }

  private helpersCache?: OfferHelpers;

  /** The shared, cached checks handed to every subscriber. */
  helpers(): OfferHelpers {
    return (this.helpersCache ??= {
      isNft: (c) => this.isNft(c),
      probe: (from, collection, to, data) => this.vetter.probe(from, collection, to, data),
      vet: (h, from, o) => this.vetter.check(h, from, o),
    });
  }

  /** Decodes drop announcements up to block `upTo` and tells every subscriber that follows drops. */
  private handleDropLogs(logs: RpcLog[], upTo: bigint): void {
    for (const l of logs) {
      if (BigInt(l.blockNumber) > upTo) continue;
      const drop = decodeDrop(l);
      if (!drop) continue;
      for (const s of this.subscribers) {
        if (s.offerDrop && s.wants(drop.nft)) s.offerDrop(drop, this.helpers());
      }
    }
  }

  private async retry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i + 1 >= attempts || this.stopping) throw e;
        await sleep(Math.min(500 * 2 ** i, 8000));
      }
    }
  }

  private async getLogs(fromBlock: bigint, toBlock: bigint, topics: (Hex | Hex[] | null)[], address?: Address): Promise<RpcLog[]> {
    const params = { ...(address ? { address } : {}), fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics };
    return (await this.publicClient.request({ method: "eth_getLogs", params: [params as never] })) as RpcLog[];
  }

  /**
   * Fetches mint logs for [from, to]. If the RPC rejects the range (too many
   * results / range limit), it splits the range and shrinks future ranges.
   */
  async fetchMintLogs(from: bigint, to: bigint): Promise<RpcLog[]> {
    try {
      const [erc721, erc1155] = await Promise.all([
        this.getLogs(from, to, [TRANSFER_TOPIC, ZERO_TOPIC]),
        this.getLogs(from, to, [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, ZERO_TOPIC]),
      ]);
      return [...erc721, ...erc1155];
    } catch (e) {
      if (to <= from) throw e;
      const mid = from + (to - from) / 2n;
      this.logRange = (to - from + 1n) / 2n || 1n;
      return [...(await this.fetchMintLogs(from, mid)), ...(await this.fetchMintLogs(mid + 1n, to))];
    }
  }

  private wanted(c: Address): boolean {
    for (const s of this.subscribers) if (s.wants(c)) return true;
    return false;
  }

  private owned(a: Address): boolean {
    for (const s of this.subscribers) if (s.owns(a)) return true;
    return false;
  }

  async ingest(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const logs = await this.fetchMintLogs(fromBlock, toBlock);
    if (this.opts.seaDrop) {
      const dropLogs = await this.getLogs(fromBlock, toBlock, [PUBLIC_DROP_UPDATED], this.opts.seaDrop).catch(() => []);
      this.handleDropLogs(dropLogs, toBlock);
    }
    const collectionsByTx = new Map<Hex, Set<Address>>();
    for (const l of logs) {
      const m = parseMintLog(l);
      if (!m || !this.wanted(m.collection)) continue;
      let set = collectionsByTx.get(l.transactionHash);
      if (!set) collectionsByTx.set(l.transactionHash, (set = new Set()));
      set.add(m.collection);
    }

    await mapLimit([...collectionsByTx.keys()], TX_FETCH_CONCURRENCY, async (hash) => {
      const tx = await this.retry(() => this.publicClient.getTransaction({ hash }), 3).catch(() => null);
      if (!tx || !tx.to || tx.blockNumber === null) return;
      const minter = getAddress(tx.from);
      if (this.owned(minter)) return;
      for (const collection of collectionsByTx.get(hash)!) {
        const obs: MintObservation = {
          collection,
          txHash: tx.hash,
          blockNumber: tx.blockNumber,
          minter,
          target: getAddress(tx.to),
          input: tx.input,
          value: tx.value,
        };
        this.detector.add(obs);
      }
    });
  }

  /** Memoised ERC-165 check shared by every subscriber. RPC failures are not cached. */
  isNft(c: Address): Promise<boolean> {
    let p = this.nftCheck.get(c);
    if (!p) {
      p = isNftContract(this.opts.actionClient ?? this.publicClient, c);
      this.nftCheck.set(c, p);
      p.catch(() => this.nftCheck.delete(c));
    }
    return p;
  }
}
