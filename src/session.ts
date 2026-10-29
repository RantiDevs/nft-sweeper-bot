import { formatEther, type Address, type Hex, type PublicClient } from "viem";
import { GasBudget } from "./budget.js";
import type { Config } from "./config.js";
import { patternKey, type HotMint } from "./detector.js";
import { dropSignature, isArmable, mintCalldata, resolveFeeRecipient, type Drop } from "./drops.js";
import type { FeeOracle } from "./fees.js";
import { mintFor, type MintContext, type MintOutcome } from "./minter.js";
import { NonceManager } from "./nonce.js";
import type { State } from "./state.js";
import { errMsg, log, mapLimit, Semaphore, sleep } from "./util.js";
import type { OfferHelpers, Subscriber } from "./watcher.js";
import type { Wallet } from "./wallets.js";

const RETRY_AFTER_MS = 30_000;
const DRY_RUN_REPEAT_MS = 5 * 60_000;
const SNIPE_RETRY_MS = 2_000;
/** While gas is above the cap, look again this often (the cost is re-measured every 20 s at most). */
const GAS_WAIT_RECHECK_MS = 15_000;
/** Longest a failing collection waits between looks, as a multiple of the normal gap (4^6 would be 4096x). */
const MAX_BACKOFF_FACTOR = 256;
/** Start probing this long before a drop's announced start (clocks differ by a second or two). */
const DROP_EARLY_MS = 1_500;
/** How long after its start time a drop keeps being probed before giving up. */
const DROP_MAX_WAIT_MS = 15 * 60_000;
const DROP_PLACEHOLDER_MINTER = "0x000000000000000000000000000000000000dEaD" as const;
const BUDGET_NOTICE_MS = 10 * 60_000;
/** Extra attempts within one round for wallets that hit transient RPC errors. */
const ROUND_RETRIES = 3;
const RETRY_BACKOFF_MS = 750;

export type SessionEvent =
  | { type: "hot"; collection: Address; uniqueMinters: number; mintTxs: number; target: Address; selector: Hex }
  | {
      type: "round";
      collection: Address;
      dryRun: boolean;
      minted: number;
      tokens: number;
      failed: number;
      /** Simulated OK in dry-run mode. */
      wouldMint: number;
      /** Skipped for any reason other than already holding one. */
      skipped: number;
      gasWei: bigint;
      txs: Hex[];
      /** First failure/skip reason, for a one-line explanation. */
      note?: string;
    }
  | { type: "bad"; collection: Address; reason: string }
  /** Minting is on hold because a mint currently costs more than the user's per-mint cap. */
  | { type: "gas-wait"; costWei: bigint; capWei: bigint }
  | { type: "budget-exhausted" };

export interface SessionDeps {
  publicClient: PublicClient;
  feeOracle: FeeOracle;
  state: State;
  /** Read live so wallets or settings changed at runtime apply to the next round. */
  config: () => Config;
  wallets: () => Wallet[];
  /** Optional cap on concurrent mint attempts across ALL sessions (shared RPC protection). */
  gate?: Semaphore;
  onEvent?: (e: SessionEvent) => void;
  /** Prefix for log lines, e.g. a Telegram user id. */
  name?: string;
}

/**
 * One owner's mint-execution side: their wallets, limits, gas budget, nonces
 * and state. Reacts to hot mints offered by a shared Watcher.
 */
export class Session implements Subscriber {
  readonly nonces: NonceManager;
  readonly budget: GasBudget;
  paused = false;
  readonly stats = { minted: 0, failed: 0, dryRun: 0 };
  private inflight = new Map<Address, Promise<void>>();
  private lastRound = new Map<Address, number>();
  private preferred = new Map<Address, string>();
  private gasHints = new Map<Address, { pattern: string; gas: bigint }>();
  /** Consecutive rounds per collection that ended without a mint. */
  private failStreak = new Map<Address, number>();
  private roundGate: Semaphore;
  private dryReported = new Set<Address>();
  private lastBudgetNotice = 0;
  private stopping = false;

  constructor(private deps: SessionDeps) {
    this.nonces = new NonceManager(deps.publicClient);
    this.roundGate = new Semaphore(deps.config().maxConcurrentRounds);
    this.budget = new GasBudget(() => deps.config().totalGasBudgetWei, () => deps.state.gasSpent());
  }

  private get tag(): string {
    return this.deps.name ? `[${this.deps.name}] ` : "";
  }

  // ── Subscriber ──────────────────────────────────────────────────────────
  wants(c: Address): boolean {
    const cfg = this.deps.config();
    if (cfg.denylist.has(c) || this.deps.state.isBad(c)) return false;
    return cfg.allowlist.size === 0 || cfg.allowlist.has(c);
  }

  owns(a: Address): boolean {
    return this.deps.wallets().some((w) => w.account.address === a);
  }

  /**
   * How many distinct free minters a collection needs before this owner acts on it:
   * allowlisted collections use the snipe thresholds, sweep mode acts on the first free
   * mint it sees (vetting does the filtering), hot mode waits for a crowd.
   */
  private thresholds(cfg: Config, collection?: Address): { minUniqueMinters: number; minMintTxs: number } {
    if (collection ? cfg.allowlist.has(collection) : cfg.allowlist.size > 0) {
      return { minUniqueMinters: cfg.allowlistMinUniqueMinters, minMintTxs: cfg.allowlistMinMintTxs };
    }
    return cfg.sweepAll ? { minUniqueMinters: 1, minMintTxs: 1 } : { minUniqueMinters: cfg.minUniqueMinters, minMintTxs: cfg.minMintTxs };
  }

  floor(): { minUniqueMinters: number; minMintTxs: number } | undefined {
    // Nothing to mint with means nothing to watch for: no checks, no RPC load, nothing wrongly blocked.
    if (this.paused || this.stopping || this.deps.wallets().length === 0) return undefined;
    return this.thresholds(this.deps.config());
  }

  offer(hot: HotMint[], helpers: OfferHelpers): void {
    if (this.paused || this.stopping || this.deps.wallets().length === 0) return;
    if (Date.now() < this.gasWaitUntil) return; // gas is too dear for now: no rounds, no RPC calls
    const cfg = this.deps.config();
    const due = hot.filter((h) => {
      if (!this.wants(h.collection) || this.inflight.has(h.collection)) return false;
      const t = this.thresholds(cfg, h.collection);
      if (h.uniqueMinters < t.minUniqueMinters || h.mintTxs < t.minMintTxs) return false;
      // Snipe targets are retried quickly (simulating is free); crowd mints back off.
      const base = cfg.dryRun ? DRY_RUN_REPEAT_MS : cfg.allowlist.has(h.collection) ? SNIPE_RETRY_MS : RETRY_AFTER_MS;
      // A collection that keeps failing (gated, sold out) is looked at less and less often.
      const backoff = Math.min(4 ** Math.min(this.failStreak.get(h.collection) ?? 0, 6), MAX_BACKOFF_FACTOR);
      return Date.now() - (this.lastRound.get(h.collection) ?? 0) >= base * backoff;
    });
    if (this.lastRound.size > 2000) {
      const cutoff = Date.now() - 3600_000;
      for (const [c, t] of this.lastRound) if (t < cutoff) this.lastRound.delete(c);
    }
    if (due.length === 0) return;
    if (this.deps.wallets().length > 0 && !cfg.dryRun && this.budget.exhausted()) {
      if (Date.now() - this.lastBudgetNotice > BUDGET_NOTICE_MS) {
        this.lastBudgetNotice = Date.now();
        log(`${this.tag}gas budget exhausted; not minting (raise TOTAL_GAS_BUDGET_ETH to continue)`);
        this.deps.onEvent?.({ type: "budget-exhausted" });
      }
      return;
    }
    for (const h of due) {
      this.lastRound.set(h.collection, Date.now());
      const p = this.roundGate.run(() => this.round(h, cfg, helpers))
        .catch((e) => log(`${this.tag}round error ${h.collection}:`, errMsg(e)))
        .finally(() => this.inflight.delete(h.collection));
      this.inflight.set(h.collection, p);
    }
  }

  // ── Drops announced ahead of time ───────────────────────────────────────
  private armed = new Map<Address, { sig: string; cancel: () => void }>();

  /**
   * A creator announced a drop on-chain. If it is free and about to start, prepare everything now,
   * wait without using the network, and mint the moment it opens.
   */
  offerDrop(drop: Drop, helpers: OfferHelpers): void {
    const cfg = this.deps.config();
    if (!cfg.drops || this.paused || this.stopping || this.deps.wallets().length === 0) return;
    // Hot mode and allowlist-only mode do not chase every announcement.
    if (!cfg.sweepAll && !cfg.allowlist.has(drop.nft)) return;
    if (!isArmable(drop, Math.floor(Date.now() / 1000), cfg.dropLeadSec)) return;

    const sig = dropSignature(drop);
    const current = this.armed.get(drop.nft);
    if (current?.sig === sig) return; // same terms announced again: nothing new
    if (!current && this.armed.size >= cfg.maxArmedDrops) return;
    current?.cancel(); // the creator changed the terms: start over with the new ones

    let cancelled = false;
    const entry = { sig, cancel: () => (cancelled = true) };
    this.armed.set(drop.nft, entry);
    void this.runDrop(drop, cfg, helpers, () => cancelled)
      .catch((e) => log(`${this.tag}drop error ${drop.nft}:`, errMsg(e)))
      .finally(() => {
        if (this.armed.get(drop.nft) === entry) this.armed.delete(drop.nft);
      });
  }

  get armedDrops(): number {
    return this.armed.size;
  }

  private async runDrop(drop: Drop, cfg: Config, helpers: OfferHelpers, cancelled: () => boolean): Promise<void> {
    const { state, publicClient } = this.deps;
    const tag = `${drop.nft} (announced drop)`;
    const wallets = this.deps.wallets();
    const sniped = cfg.allowlist.has(drop.nft);
    if (wallets.filter((w) => state.mintCount(drop.nft, w.account.address) < cfg.maxMintsPerCollection).length === 0) return;

    // 1. Everything that can be settled before the drop opens, settled now.
    const feeRecipient = await resolveFeeRecipient(publicClient, drop).catch(() => undefined);
    if (!feeRecipient) {
      log(`${this.tag}SKIP ${tag}: no fee recipient the drop accepts`);
      return;
    }
    const data = mintCalldata(drop, feeRecipient, cfg.dropQuantity);
    const hot: HotMint = {
      collection: drop.nft,
      uniqueMinters: 0,
      mintTxs: 0,
      firstSeenAt: Date.now(),
      // The mint call is built here, not copied: `minter` is a placeholder that appears nowhere in the data.
      templates: [
        {
          collection: drop.nft,
          txHash: `0x${"0".repeat(64)}`,
          blockNumber: drop.block,
          minter: DROP_PLACEHOLDER_MINTER,
          target: drop.seaDrop,
          input: data,
          value: 0n,
        },
      ],
    };
    const probeFrom = wallets[0].account.address;
    const [isNft, vet] = await Promise.all([
      cfg.requireErc165 && !sniped ? helpers.isNft(drop.nft) : Promise.resolve(true),
      // Before it opens the mint reverts, so only the static checks mean anything yet.
      helpers.vet(hot, probeFrom, { requireVerified: sniped ? false : cfg.requireVerified, trace: false, simulate: false }),
    ]);
    if (!isNft) return this.block(drop.nft, "does not report ERC-721/1155 via ERC-165");
    if (!vet.ok && !vet.retryable) return this.block(drop.nft, vet.reason);
    const opensIn = Math.max(0, drop.startTime - Math.floor(Date.now() / 1000));
    log(`${this.tag}ARMED ${tag}: free, opens in ${opensIn}s, ${wallets.length} wallet(s), up to ${Math.min(cfg.dropQuantity, drop.maxPerWallet)} per wallet`);

    // 2. Wait quietly (no network) until just before the start.
    const startMs = drop.startTime * 1000 - DROP_EARLY_MS;
    while (Date.now() < startMs) {
      if (cancelled() || this.stopping) return;
      await sleep(Math.min(1000, startMs - Date.now()));
    }

    // 3. Ask for free: would the mint succeed right now and put a token in the wallet?
    const balances = new Map(wallets.map((w) => [w.account.address, publicClient.getBalance({ address: w.account.address })] as const));
    for (const p of balances.values()) p.catch(() => {});
    const deadline = Math.min(drop.endTime * 1000, drop.startTime * 1000 + DROP_MAX_WAIT_MS);
    let verified = false;
    let opened = false;
    while (Date.now() < deadline) {
      if (cancelled() || this.stopping || this.paused) return;
      const status = await helpers.probe(probeFrom, drop.nft, drop.seaDrop, data).catch(() => "reverts" as const);
      if (status === "delivers") {
        opened = verified = true;
        break;
      }
      if (status === "no-delivery") return this.block(drop.nft, "simulated drop mint would not deliver the NFT to your wallet");
      if (status === "unsupported") {
        // This RPC cannot simulate: a plain eth_call still tells us whether the mint is open.
        opened = await publicClient.call({ account: probeFrom, to: drop.seaDrop, data, value: 0n }).then(() => true, () => false);
        if (opened) break;
      }
      await sleep(cfg.dropPollMs);
    }
    if (!opened) {
      log(`${this.tag}drop ${drop.nft} did not open for us before it ended or the wait limit`);
      return;
    }

    // 4. Open. Gas is a fixed figure (it cannot be estimated before the drop opens), so no wallet waits for the node.
    while (!(await this.costOk(cfg)) && Date.now() < deadline) {
      if (cancelled() || this.stopping) return;
      await sleep(5_000); // the drop is open but too dear to mint right now; gas may come back down
    }
    if (cfg.requireVerified && !sniped) {
      const again = await helpers.vet(hot, probeFrom, { requireVerified: true, trace: false, simulate: false });
      if (!again.ok) return log(`${this.tag}WAIT ${tag}: ${again.reason}`);
    }
    const key = patternKey(hot.templates[0]);
    this.preferred.set(drop.nft, key);
    this.gasHints.set(drop.nft, { pattern: key, gas: cfg.dropGasLimit });
    const run = this.execute(hot, cfg, tag, wallets, balances, Date.now(), cfg.fastMode && verified);
    this.inflight.set(drop.nft, run);
    try {
      await run;
    } finally {
      this.inflight.delete(drop.nft);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  get busy(): number {
    return this.inflight.size;
  }

  stop(): void {
    this.stopping = true;
  }

  /** Waits for in-flight mint rounds so nothing is left half-recorded. */
  async drain(): Promise<void> {
    await Promise.allSettled(this.inflight.values());
  }

  // ── Rounds ──────────────────────────────────────────────────────────────
  private block(collection: Address, reason: string): void {
    this.deps.state.markBad(collection, reason);
    this.deps.onEvent?.({ type: "bad", collection, reason });
    log(`${this.tag}BLOCKED ${collection}: ${reason}`);
  }

  private lastGasWaitLog = 0;
  private gasWaitUntil = 0;

  /**
   * True if a typical mint costs no more than the per-mint cap right now. When it does not, nothing
   * else is worth doing: no per-collection checks, no simulations, no RPC load. Cost swings with the
   * price of posting data to Ethereum, so this is re-measured every 20 seconds.
   */
  private async costOk(cfg: Config): Promise<boolean> {
    const oracle = this.deps.feeOracle as { mintCost?: (c: PublicClient) => Promise<{ costWei: bigint }> };
    if (typeof oracle.mintCost !== "function") return true;
    let costWei: bigint;
    try {
      costWei = (await oracle.mintCost(this.deps.publicClient)).costWei;
    } catch {
      return true; // cannot measure: let the per-mint checks decide
    }
    if (costWei <= cfg.maxGasCostWei) return true;
    if (Date.now() - this.lastGasWaitLog > 60_000) {
      this.lastGasWaitLog = Date.now();
      log(`${this.tag}WAITING for cheaper gas: a mint costs about ${formatEther(costWei)} ETH now, the cap is ${formatEther(cfg.maxGasCostWei)} ETH`);
      this.deps.onEvent?.({ type: "gas-wait", costWei, capWei: cfg.maxGasCostWei });
    }
    return false;
  }

  private async round(hot: HotMint, cfg: Config, helpers: OfferHelpers): Promise<void> {
    if (!(await this.costOk(cfg))) {
      // Gas is too dear for any mint right now. That says nothing about this collection, so it is not
      // counted as a visit; everything just pauses briefly and is re-measured.
      this.gasWaitUntil = Date.now() + GAS_WAIT_RECHECK_MS;
      this.lastRound.delete(hot.collection);
      return;
    }
    const { state } = this.deps;
    const tag = `${hot.collection} (${hot.uniqueMinters} minters / ${hot.mintTxs} txs)`;
    const roundStart = Date.now();
    const sniped = cfg.allowlist.has(hot.collection);
    const wallets = this.deps.wallets();
    // Wallet balances, the ERC-165 check and the whole safety screen start at the same time,
    // so the round waits for the slowest of them, not for all of them one after another.
    const balances = new Map(
      wallets.map((w) => [w.account.address, this.deps.publicClient.getBalance({ address: w.account.address })] as const),
    );
    for (const p of balances.values()) p.catch(() => {}); // errors surface where the balance is used
    // An allowlisted collection is the owner's own choice, so it skips the verification
    // requirement and the ERC-165 check but is still traced and simulated.
    const [isNft, vet] = await Promise.all([
      cfg.requireErc165 && !sniped ? helpers.isNft(hot.collection) : Promise.resolve(true),
      helpers.vet(hot, wallets[0]?.account.address ?? hot.templates[0].minter, {
        requireVerified: sniped ? false : cfg.requireVerified,
        trace: cfg.vetTrace,
      }),
    ]);
    if (!isNft) return this.block(hot.collection, "does not report ERC-721/1155 via ERC-165");
    if (!vet.ok) {
      if (vet.retryable) {
        log(`${this.tag}WAIT ${tag}: ${vet.reason}`);
        return;
      }
      return this.block(hot.collection, vet.reason);
    }
    return this.execute(hot, cfg, tag, wallets, balances, roundStart, cfg.fastMode && vet.deliveryVerified === true);
  }

  /**
   * Mints a vetted collection from the wallets. `fast` means a free simulation already proved the
   * mint delivers, so every wallet can start at once without waiting for the first receipt.
   */
  private async execute(
    hot: HotMint,
    cfg: Config,
    tag: string,
    wallets: Wallet[],
    balances: Map<Address, Promise<bigint>>,
    roundStart: number,
    fast: boolean,
  ): Promise<void> {
    const { state } = this.deps;
    const t = hot.templates[0];
    log(`${this.tag}HOT ${tag} via ${t.target} selector ${t.input.slice(0, 10)} (${hot.templates.length} pattern(s))`);
    if (wallets.length === 0) return;
    this.deps.onEvent?.({
      type: "hot",
      collection: hot.collection,
      uniqueMinters: hot.uniqueMinters,
      mintTxs: hot.mintTxs,
      target: t.target,
      selector: t.input.slice(0, 10) as Hex,
    });

    const ctx: MintContext = {
      publicClient: this.deps.publicClient,
      cfg,
      state,
      nonces: this.nonces,
      budget: this.budget,
      fees: this.deps.feeOracle,
      preferred: this.preferred,
      gasHints: this.gasHints,
      balances,
      onSent: (_w, at) => {
        if (sentLogged) return;
        sentLogged = true;
        const seen = hot.firstSeenAt ? `${at - hot.firstSeenAt} ms after the bot first saw this collection mint` : "first-seen time unknown";
        log(`${this.tag}FIRST TX SENT for ${tag}: ${at - roundStart} ms after the checks began, ${seen}`);
      },
    };
    let sentLogged = false;
    const tally = { minted: 0, tokens: 0, failed: 0, wouldMint: 0, skipped: 0, gasWei: 0n, txs: [] as Hex[], note: undefined as string | undefined };

    // Prove the mint works with one wallet before the rest pile in, so a
    // broken template costs one simulation per round, not one per wallet.
    let eligible = wallets.filter((w) => state.mintCount(hot.collection, w.account.address) < cfg.maxMintsPerCollection);
    if (cfg.maxWalletsPerCollection > 0) {
      // Gas saver: only N wallets take part per collection. Pick those holding the fewest NFTs
      // so gas and holdings spread across wallets instead of draining the first few.
      const already = wallets.filter((w) => state.mintCount(hot.collection, w.account.address) > 0).length;
      const held = (w: Wallet) => state.holdings(w.account.address).length;
      eligible = eligible.sort((a, b) => held(a) - held(b)).slice(0, Math.max(0, cfg.maxWalletsPerCollection - already));
    }
    if (eligible.length > 0) {
      await this.runWallets(hot, eligible, ctx, tag, tally, fast);
      // Remember how it went: a collection that gave nothing is retried later and later.
      // A collection that is gated or sold out fails again next time, so it is looked at less and less.
      // A skip caused by gas price, an empty wallet or the budget says nothing about the collection.
      const circumstantial = /per-tx cap|base fee|balance|BUDGET|rpc:/i.test(tally.note ?? "");
      if (tally.minted + tally.wouldMint > 0 || circumstantial) this.failStreak.delete(hot.collection);
      else this.failStreak.set(hot.collection, (this.failStreak.get(hot.collection) ?? 0) + 1);
      const repeatDryRun =
        cfg.dryRun && tally.wouldMint > 0 && tally.minted + tally.failed === 0 && this.dryReported.has(hot.collection);
      if (cfg.dryRun && tally.wouldMint > 0) this.dryReported.add(hot.collection);
      // Dry-run repeats every few minutes; tell the user about each collection once.
      if (!repeatDryRun && tally.minted + tally.failed + tally.wouldMint + tally.skipped > 0) {
        this.deps.onEvent?.({ type: "round", collection: hot.collection, dryRun: cfg.dryRun, ...tally });
      }
    }
  }

  private async runWallets(
    hot: HotMint,
    eligible: Wallet[],
    ctx: MintContext,
    tag: string,
    tally: { minted: number; tokens: number; failed: number; wouldMint: number; skipped: number; gasWei: bigint; txs: Hex[]; note: string | undefined },
    fast = false,
  ): Promise<void> {
    const one = (w: Wallet) => this.mintOne(hot, w, ctx, tag, tally);
    let pending = eligible;

    if (fast && !ctx.cfg.dryRun && eligible.length > 1) {
      // Fast path: the free simulation already proved the mint delivers to a wallet, so the
      // first wallet does not need a receipt before the others go. The moment it has chosen
      // the mint call and its gas, every other wallet starts in parallel and reuses both.
      const [scout, ...rest] = eligible;
      let release!: (ok: boolean) => void;
      const prepared = new Promise<boolean>((r) => (release = r));
      const scoutCtx: MintContext = { ...ctx, onPrepared: (ok) => release(ok) };
      const scoutRun = this.mintOne(hot, scout, scoutCtx, tag, tally);
      const restRun = (await prepared)
        ? mapLimit(rest, ctx.cfg.walletConcurrency, one)
        : Promise.resolve<string[]>(rest.map(() => "not-started"));
      const [first, others] = await Promise.all([scoutRun, restRun]);
      if (first === "skipped-sim" || this.deps.state.isBad(hot.collection) || this.stopping) return;
      pending = [...(first === "retry" ? [scout] : []), ...rest.filter((_, i) => others[i] === "retry" || others[i] === "not-started")];
      // Anything left over (transient RPC errors) goes through the normal retry loop below.
    } else {
      // Scout until one wallet gets a definitive answer (transient RPC errors don't count).
      for (let attempt = 0; pending.length > 0 && attempt <= ROUND_RETRIES; attempt++) {
        if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
        const [scout, ...rest] = pending;
        const first = await one(scout);
        if (first === "skipped-sim" || this.deps.state.isBad(hot.collection) || this.stopping) return;
        if (first === "retry") continue;
        pending = rest;
        break;
      }
    }
    // Everyone else in parallel; wallets that hit transient errors get re-queued.
    for (let attempt = 0; pending.length > 0 && attempt <= ROUND_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
      const results = await mapLimit(pending, ctx.cfg.walletConcurrency, one);
      if (this.deps.state.isBad(hot.collection) || this.stopping) return;
      pending = pending.filter((_, i) => results[i] === "retry");
    }
  }

  private async mintOne(
    hot: HotMint,
    w: Wallet,
    ctx: MintContext,
    tag: string,
    tally: { minted: number; tokens: number; failed: number; wouldMint: number; skipped: number; gasWei: bigint; txs: Hex[]; note: string | undefined },
  ): Promise<string> {
    if (this.stopping) return "stopped";
    const exec = () => mintFor(hot, w, ctx);
    const res: MintOutcome = await (this.deps.gate ? this.deps.gate.run(exec) : exec());
    if (res.status === "skipped" && res.retry) return "retry";
    if (res.status === "minted") {
      this.stats.minted++;
      tally.minted++;
      tally.tokens += res.tokens;
      tally.gasWei += res.gasPaidWei;
      tally.txs.push(res.hash);
    } else if (res.status === "failed") {
      this.stats.failed++;
      tally.failed++;
      tally.note ??= res.reason;
    } else if (res.status === "dry-run") {
      this.stats.dryRun++;
      tally.wouldMint++;
    } else if (!res.reason.startsWith("per-collection")) {
      tally.skipped++;
      tally.note ??= res.reason;
    }
    if (res.status !== "skipped" || !res.reason.startsWith("per-collection")) {
      log(`${this.tag}${res.status.toUpperCase()} ${w.label} ${tag}`, JSON.stringify(res, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    if (res.status === "skipped" && res.reason.startsWith("simulation")) return "skipped-sim";
    return res.status;
  }

  describeBudget(): string {
    const cfg = this.deps.config();
    return `${formatEther(this.deps.state.gasSpent())}/${formatEther(cfg.totalGasBudgetWei)} ETH`;
  }
}
