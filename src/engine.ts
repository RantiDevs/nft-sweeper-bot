import { formatEther, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { GasBudget } from "./budget.js";
import type { Config } from "./config.js";
import { MintDetector, type HotMint, type MintObservation } from "./detector.js";
import { isNftContract } from "./erc165.js";
import {
  parseMintLog,
  TRANSFER_BATCH_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_TOPIC,
  ZERO_TOPIC,
} from "./logs.js";
import { FeeOracle } from "./fees.js";
import { mintFor, type MintContext } from "./minter.js";
import { NonceManager } from "./nonce.js";
import type { State } from "./state.js";
import { errMsg, log, mapLimit, sleep } from "./util.js";
import type { Wallet } from "./wallets.js";

const MAX_LOG_RANGE = 2000n;
const RETRY_AFTER_MS = 30_000;
const DRY_RUN_REPEAT_MS = 5 * 60_000;
const TX_FETCH_CONCURRENCY = 25;
const HEARTBEAT_MS = 60_000;
/** Extra attempts within one round for wallets that hit transient RPC errors. */
const ROUND_RETRIES = 3;
const RETRY_BACKOFF_MS = 750;

type RpcLog = { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex };

export class Engine {
  readonly detector: MintDetector;
  private nonces: NonceManager;
  private budget: GasBudget;
  private feeOracle: FeeOracle;
  private ourAddresses: Set<Address>;
  private logRange = MAX_LOG_RANGE;
  private cursor = 0n;
  private head = 0n;
  private inflight = new Map<Address, Promise<void>>();
  private lastRound = new Map<Address, number>();
  private nftCheck = new Map<Address, Promise<boolean>>();
  private preferred = new Map<Address, string>();
  private stopping = false;
  private stats = { minted: 0, failed: 0, dryRun: 0, rounds: 0 };

  constructor(
    private publicClient: PublicClient,
    private wallets: Wallet[],
    private cfg: Config,
    private state: State,
  ) {
    this.ourAddresses = new Set(wallets.map((w) => w.account.address));
    this.nonces = new NonceManager(publicClient);
    this.budget = new GasBudget(cfg.totalGasBudgetWei, () => state.gasSpent());
    this.feeOracle = new FeeOracle(publicClient, {
      multiplier: cfg.baseFeeMultiplier,
      minPriorityFeeWei: cfg.priorityFeeWei,
    });
    this.detector = new MintDetector({
      ...cfg,
      thresholdsFor: (c) =>
        cfg.allowlist.has(c)
          ? { minUniqueMinters: cfg.allowlistMinUniqueMinters, minMintTxs: cfg.allowlistMinMintTxs }
          : undefined,
    });
  }

  stop(): void {
    this.stopping = true;
  }

  /** Waits for in-flight mint rounds so nothing is left half-recorded. */
  async drain(): Promise<void> {
    await Promise.allSettled(this.inflight.values());
  }

  /** Starts scanning `windowBlocks` back from the current head. */
  async init(): Promise<void> {
    this.head = await this.retry(() => this.publicClient.getBlockNumber());
    const window = BigInt(this.cfg.windowBlocks);
    this.cursor = this.head > window ? this.head - window : 0n;
  }

  async run(): Promise<void> {
    await this.init();
    let lastBeat = 0;

    while (!this.stopping) {
      try {
        await this.tick();
      } catch (e) {
        log("loop error:", errMsg(e));
      }
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        this.heartbeat();
      }
      await sleep(this.cfg.pollIntervalMs);
    }
  }

  async tick(): Promise<void> {
    this.head = await this.publicClient.getBlockNumber();
    while (this.cursor <= this.head && !this.stopping) {
      const end = this.cursor + this.logRange - 1n;
      const to = end < this.head ? end : this.head;
      await this.ingest(this.cursor, to);
      this.cursor = to + 1n;
    }
    this.detector.prune(this.head);
    await this.act();
  }

  private heartbeat(): void {
    log(
      `♥ head ${this.head} | tracking ${this.detector.size()} collections | in-flight ${this.inflight.size} | ` +
        `minted ${this.stats.minted} failed ${this.stats.failed} dry-run ${this.stats.dryRun} | ` +
        `gas spent ${formatEther(this.state.gasSpent())}/${formatEther(this.cfg.totalGasBudgetWei)} ETH`,
    );
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

  private async getLogs(fromBlock: bigint, toBlock: bigint, topics: (Hex | Hex[] | null)[]): Promise<RpcLog[]> {
    const params = { fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics };
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
    if (this.cfg.denylist.has(c) || this.state.isBad(c)) return false;
    return this.cfg.allowlist.size === 0 || this.cfg.allowlist.has(c);
  }

  async ingest(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const logs = await this.fetchMintLogs(fromBlock, toBlock);
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
      if (this.ourAddresses.has(minter)) return;
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

  private async isNft(c: Address): Promise<boolean> {
    if (!this.cfg.requireErc165 || this.cfg.allowlist.has(c)) return true;
    let p = this.nftCheck.get(c);
    if (!p) {
      p = isNftContract(this.publicClient, c);
      this.nftCheck.set(c, p);
      // Don't cache RPC failures; the next round asks again.
      p.catch(() => this.nftCheck.delete(c));
    }
    return p;
  }

  /** Starts a mint round for each hot collection without blocking block ingestion. */
  async act(): Promise<void> {
    if (this.stopping) return;
    const hot = this.detector.hot().filter((h) => {
      if (this.inflight.has(h.collection) || this.state.isBad(h.collection)) return false;
      const wait = this.cfg.dryRun ? DRY_RUN_REPEAT_MS : RETRY_AFTER_MS;
      return Date.now() - (this.lastRound.get(h.collection) ?? 0) >= wait;
    });
    if (hot.length === 0) return;
    if (this.wallets.length > 0 && !this.cfg.dryRun && this.budget.exhausted()) {
      log("gas budget exhausted; not minting (raise TOTAL_GAS_BUDGET_ETH to continue)");
      return;
    }
    for (const h of hot) {
      this.lastRound.set(h.collection, Date.now());
      const p = this.round(h)
        .catch((e) => log(`round error ${h.collection}:`, errMsg(e)))
        .finally(() => this.inflight.delete(h.collection));
      this.inflight.set(h.collection, p);
    }
  }

  private async round(hot: HotMint): Promise<void> {
    const tag = `${hot.collection} (${hot.uniqueMinters} minters / ${hot.mintTxs} txs)`;
    if (!(await this.isNft(hot.collection))) {
      this.state.markBad(hot.collection, "does not report ERC-721/1155 via ERC-165");
      this.detector.forget(hot.collection);
      log(`SKIP ${tag}: not an ERC-721/1155 contract`);
      return;
    }
    const t = hot.templates[0];
    log(`HOT ${tag} via ${t.target} selector ${t.input.slice(0, 10)} (${hot.templates.length} pattern(s))`);
    if (this.wallets.length === 0) return;

    const ctx: MintContext = {
      publicClient: this.publicClient,
      cfg: this.cfg,
      state: this.state,
      nonces: this.nonces,
      budget: this.budget,
      fees: this.feeOracle,
      preferred: this.preferred,
    };
    // Prove the mint works with one wallet before the rest pile in, so a
    // broken template costs one simulation per round, not one per wallet.
    const eligible = this.wallets.filter(
      (w) => this.state.mintCount(hot.collection, w.account.address) < this.cfg.maxMintsPerCollection,
    );
    if (eligible.length === 0) return;
    // Scout until one wallet gets a definitive answer (transient RPC errors don't count).
    let pending = eligible;
    for (let attempt = 0; pending.length > 0 && attempt <= ROUND_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
      const [scout, ...rest] = pending;
      const first = await this.mintOne(hot, scout, ctx, tag);
      if (first === "skipped-sim" || this.state.isBad(hot.collection) || this.stopping) return;
      if (first === "retry") continue;
      pending = rest;
      break;
    }
    // Everyone else in parallel; wallets that hit transient errors get re-queued.
    for (let attempt = 0; pending.length > 0 && attempt <= ROUND_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
      const results = await mapLimit(pending, this.cfg.walletConcurrency, (w) => this.mintOne(hot, w, ctx, tag));
      if (this.state.isBad(hot.collection) || this.stopping) return;
      pending = pending.filter((_, i) => results[i] === "retry");
    }
  }

  private async mintOne(hot: HotMint, w: Wallet, ctx: MintContext, tag: string): Promise<string> {
    if (this.stopping) return "stopped";
    const res = await mintFor(hot, w, ctx);
    if (res.status === "skipped" && res.retry) return "retry";
    if (res.status === "minted") this.stats.minted++;
    if (res.status === "failed") this.stats.failed++;
    if (res.status === "dry-run") this.stats.dryRun++;
    if (res.status !== "skipped" || !res.reason.startsWith("per-collection")) {
      log(`${res.status.toUpperCase()} ${w.label} ${tag}`, JSON.stringify(res, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    if (res.status === "skipped" && res.reason.startsWith("simulation")) return "skipped-sim";
    return res.status;
  }
}
