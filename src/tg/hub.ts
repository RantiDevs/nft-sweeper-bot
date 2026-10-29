import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatEther, parseEther, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { makeWakeSource } from "../rpc.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Config } from "../config.js";
import { FeeOracle } from "../fees.js";
import { EthPriceOracle } from "../price.js";
import { collectNfts, recoverEth, type CollectResult, type RecoverResult } from "../ops.js";
import { Session, type SessionEvent } from "../session.js";
import { OpenSeaClient } from "../market/opensea.js";
import { analyzeHoldings, heldTokens } from "../rarity/analyze.js";
import { parseTiers, type PlanSummary } from "../rarity/plan.js";
import { State } from "../state.js";
import { errMsg, log, mapLimit, Semaphore } from "../util.js";
import { Watcher } from "../watcher.js";
import { makeWallets, type Wallet } from "../wallets.js";
import { stateFile, type TgConfig } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { defaultSettings, type UserRecord, type UserSettings, type UserStore } from "./store.js";

interface Runtime {
  rec: UserRecord;
  wallets: Wallet[];
  state: State;
  session: Session;
  cfg: Config;
}

export interface HubDeps {
  publicClient: PublicClient;
  /** Client for the block watcher; defaults to publicClient. */
  watchClient?: PublicClient;
  chain: Chain;
  transport: Transport;
  tg: TgConfig;
  store: UserStore;
  /** Live ETH/USD price; defaults to the public feeds. Tests inject a fixed one. */
  price?: EthPriceOracle;
  /** Mint results for one user (already filtered by their notification setting). */
  onUserEvent: (userId: number, e: SessionEvent) => void;
  /** Operational alerts for admins (RPC stalls, key failures). */
  onAdminAlert: (text: string) => void;
}

const aad = (userId: number, address: Address) => `${userId}:${address.toLowerCase()}`;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Runs every user's Session on a single shared Watcher. Each user has their own
 * wallets (keys encrypted at rest), settings, gas budget and state file; the
 * chain is scanned once no matter how many users there are.
 */
export class Hub {
  readonly watcher: Watcher;
  private runtimes = new Map<number, Runtime>();
  private feeOracle: FeeOracle;
  private gate: Semaphore;
  private planGate: Semaphore;
  readonly price: EthPriceOracle;
  private priceTimer?: NodeJS.Timeout;
  private opensea: OpenSeaClient;
  private stallTimer?: NodeJS.Timeout;
  private stalled = false;
  private alertedStall = false;
  private lastStallAlert = 0;

  constructor(private deps: HubDeps) {
    const { tg, publicClient } = deps;
    this.feeOracle = new FeeOracle(publicClient, {
      multiplier: tg.base.baseFeeMultiplier,
      minPriorityFeeWei: tg.base.priorityFeeWei,
      useSuggestedTip: tg.base.useSuggestedTip,
    });
    this.gate = new Semaphore(tg.maxConcurrentMints);
    this.planGate = new Semaphore(tg.maxConcurrentPlans);
    this.price = deps.price ?? new EthPriceOracle({ fallback: tg.plan.ethUsd });
    this.opensea = new OpenSeaClient({ apiKey: tg.plan.openseaKey, chainSlug: tg.plan.openseaChain });
    this.watcher = new Watcher(deps.watchClient ?? publicClient, {
      actionClient: publicClient,
      windowBlocks: tg.base.windowBlocks,
      backfillBlocks: tg.base.backfillBlocks,
      liveFeed: tg.base.liveFeed,
      seaDrop: tg.base.drops ? tg.base.seaDropAddress : undefined,
      onWake: makeWakeSource(tg.base),
      pollIntervalMs: tg.base.pollIntervalMs,
      onAlert: (t) => deps.onAdminAlert(t),
      vet: { explorerApi: tg.base.explorerApi, requireVerified: tg.base.requireVerified, trace: tg.base.vetTrace },
      heartbeatExtra: () => `users ${this.runtimes.size} | in-flight ${[...this.runtimes.values()].reduce((a, r) => a + r.session.busy, 0)}`,
    });
  }

  // ── Startup / shutdown ──────────────────────────────────────────────────
  /** Loads every active user. A user whose keys cannot be decrypted is skipped and reported, not fatal. */
  loadAll(): void {
    for (const rec of this.deps.store.all()) {
      if (rec.status !== "active") continue;
      try {
        this.activate(rec);
      } catch (e) {
        log(`failed to load user ${rec.id}:`, errMsg(e));
        this.deps.onAdminAlert(`⚠️ Could not load user ${rec.id}: ${errMsg(e)} (wrong MASTER_KEY or corrupted data file?)`);
      }
    }
  }

  async start(): Promise<void> {
    this.stallTimer = setInterval(() => this.checkStall(), 15_000);
    this.stallTimer.unref?.();
    // Keep the dollar price warm so notifications never have to wait for a feed.
    void this.price.get();
    this.priceTimer = setInterval(() => void this.price.get(), 60_000);
    this.priceTimer.unref?.();
    await this.watcher.run();
  }

  async stop(): Promise<void> {
    if (this.stallTimer) clearInterval(this.stallTimer);
    if (this.priceTimer) clearInterval(this.priceTimer);
    this.watcher.stop();
    for (const r of this.runtimes.values()) r.session.stop();
    await this.drain();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((r) => r.session.drain()));
  }

  private checkStall(): void {
    const quietMs = Date.now() - this.watcher.lastOkAt;
    const limit = this.deps.tg.stallAlertSec * 1000;
    if (!this.stalled && quietMs > limit) {
      this.stalled = true;
      // A flaky RPC can stall and recover many times an hour; one alert per 15 minutes is enough.
      if (Date.now() - this.lastStallAlert > 15 * 60_000) {
        this.lastStallAlert = Date.now();
        this.alertedStall = true;
        this.deps.onAdminAlert(`🚨 No chain progress for ${Math.round(quietMs / 1000)}s: RPC down or rate limited? Mints are paused until it recovers.`);
      }
    } else if (this.stalled && quietMs <= limit) {
      this.stalled = false;
      if (this.alertedStall) {
        this.alertedStall = false;
        this.deps.onAdminAlert("✅ Chain watching recovered.");
      }
    }
  }

  // ── Users ───────────────────────────────────────────────────────────────
  has(userId: number): boolean {
    return this.runtimes.has(userId);
  }

  record(userId: number): UserRecord | undefined {
    return this.deps.store.get(userId);
  }

  /** Creates a user (dry-run, no wallets yet) and starts their session. */
  register(id: number, username: string | undefined, role: "admin" | "user"): UserRecord {
    const { tg, store } = this.deps;
    const cap = (value: bigint, ceiling: string) => formatEther(min(value, parseEther(ceiling)));
    const rec = store.create({
      id,
      username,
      role,
      status: "active",
      createdAt: Date.now(),
      wallets: [],
      settings: defaultSettings({
        maxGasCostEth: cap(tg.base.maxGasCostWei, tg.ceilingMaxGasCostEth),
        totalGasBudgetEth: cap(tg.base.totalGasBudgetWei, tg.ceilingTotalGasBudgetEth),
        minUniqueMinters: tg.base.minUniqueMinters,
        minMintTxs: tg.base.minMintTxs,
      }),
    });
    this.activate(rec);
    return rec;
  }

  /** The operator's ceilings are a hard limit: a user saved under higher ones is brought down at startup. */
  private clampToCeilings(rec: UserRecord): void {
    const { tg, store } = this.deps;
    const s = rec.settings;
    let changed = false;
    if (parseEther(s.maxGasCostEth) > parseEther(tg.ceilingMaxGasCostEth)) {
      s.maxGasCostEth = tg.ceilingMaxGasCostEth;
      changed = true;
    }
    if (parseEther(s.totalGasBudgetEth) > parseEther(tg.ceilingTotalGasBudgetEth)) {
      s.totalGasBudgetEth = tg.ceilingTotalGasBudgetEth;
      changed = true;
    }
    if (changed) {
      store.save();
      log(`user ${rec.id}: gas limits lowered to the operator's ceilings`);
    }
  }

  private activate(rec: UserRecord): Runtime {
    const { tg, chain, transport, publicClient } = this.deps;
    this.clampToCeilings(rec);
    const key = (w: UserRecord["wallets"][number]) => decrypt(w.enc, tg.masterKey, aad(rec.id, w.address)) as `0x${string}`;
    const accounts = rec.wallets.map((w) => {
      const account = privateKeyToAccount(key(w));
      if (account.address !== w.address) throw new Error(`wallet ${w.address} does not match its stored key`);
      return account;
    });
    mkdirSync(dirname(stateFile(tg, rec.id)), { recursive: true });
    const state = new State(stateFile(tg, rec.id));
    const rt = {
      rec,
      wallets: makeWallets(accounts, chain, transport),
      state,
      cfg: this.effective(rec),
    } as Runtime;
    rt.session = new Session({
      publicClient,
      feeOracle: this.feeOracle,
      state,
      config: () => rt.cfg,
      wallets: () => rt.wallets,
      gate: this.gate,
      name: String(rec.id),
      onEvent: (e) => {
        if (rt.rec.settings.notify) this.deps.onUserEvent(rec.id, e);
      },
    });
    rt.session.paused = rec.settings.paused;
    this.runtimes.set(rec.id, rt);
    this.watcher.subscribe(rt.session);
    return rt;
  }

  private effective(rec: UserRecord): Config {
    const s = rec.settings;
    const base = this.deps.tg.base;
    return {
      ...base,
      dryRun: s.dryRun,
      sweepAll: s.sweep ?? true, // users stored before this setting existed get sweep mode
      maxGasCostWei: parseEther(s.maxGasCostEth),
      totalGasBudgetWei: parseEther(s.totalGasBudgetEth),
      minUniqueMinters: s.minUniqueMinters,
      minMintTxs: s.minMintTxs,
      maxMintsPerCollection: s.maxMintsPerCollection,
      maxWalletsPerCollection: s.walletsPerCollection ?? 0,
      allowlist: new Set(s.allowlist),
      denylist: new Set(s.denylist),
      walletConcurrency: Math.min(base.walletConcurrency, 25),
    };
  }

  private rt(userId: number): Runtime {
    const rt = this.runtimes.get(userId);
    if (!rt) throw new Error("No active session for this user");
    return rt;
  }

  /** Applies and persists a settings change; takes effect on the next round. */
  update(userId: number, patch: Partial<UserSettings>): UserSettings {
    const rt = this.rt(userId);
    Object.assign(rt.rec.settings, patch);
    this.deps.store.save();
    rt.cfg = this.effective(rt.rec);
    rt.session.paused = rt.rec.settings.paused;
    return rt.rec.settings;
  }

  setBanned(userId: number, banned: boolean): boolean {
    const rec = this.deps.store.get(userId);
    if (!rec) return false;
    rec.status = banned ? "banned" : "active";
    this.deps.store.save();
    const rt = this.runtimes.get(userId);
    if (banned && rt) {
      rt.session.stop();
      this.watcher.unsubscribe(rt.session);
      this.runtimes.delete(userId);
    } else if (!banned && !rt) {
      this.activate(rec);
    }
    return true;
  }

  // ── Wallets ─────────────────────────────────────────────────────────────
  wallets(userId: number): Wallet[] {
    return this.rt(userId).wallets;
  }

  state(userId: number): State {
    return this.rt(userId).state;
  }

  session(userId: number): Session {
    return this.rt(userId).session;
  }

  /** Generates `count` fresh wallets for the user; keys are encrypted before they touch disk. */
  addWallets(userId: number, count: number): Address[] {
    const rt = this.rt(userId);
    const { tg, store, chain, transport } = this.deps;
    const room = tg.maxWalletsPerUser - rt.rec.wallets.length;
    if (count < 1 || count > room) throw new Error(room <= 0 ? "Wallet limit reached" : `You can add at most ${room} more wallet(s)`);
    const keys = Array.from({ length: count }, () => generatePrivateKey());
    const accounts = keys.map((k) => privateKeyToAccount(k));
    accounts.forEach((a, i) => rt.rec.wallets.push({ address: a.address, enc: encrypt(keys[i], tg.masterKey, aad(userId, a.address)) }));
    store.save();
    // Re-derive labels for the full list so w01.. stay in creation order.
    const all = makeWallets([...rt.wallets.map((w) => w.account), ...accounts], chain, transport);
    rt.wallets = all;
    return accounts.map((a) => a.address);
  }

  /** Decrypted private keys, for /export only. */
  exportKeys(userId: number): { label: string; address: Address; key: string }[] {
    const rt = this.rt(userId);
    return rt.rec.wallets.map((w, i) => ({
      label: rt.wallets[i].label,
      address: w.address,
      key: decrypt(w.enc, this.deps.tg.masterKey, aad(userId, w.address)),
    }));
  }

  async balances(userId: number): Promise<{ label: string; address: Address; wei: bigint | null }[]> {
    const rt = this.rt(userId);
    return mapLimit(rt.wallets, 10, async (w) => ({
      label: w.label,
      address: w.account.address,
      wei: await this.deps.publicClient.getBalance({ address: w.account.address }).catch(() => null),
    }));
  }

  collect(userId: number, vault: Address, send: boolean): Promise<CollectResult> {
    const rt = this.rt(userId);
    return collectNfts({ publicClient: this.deps.publicClient, wallets: rt.wallets, state: rt.state, vault, send });
  }

  recover(userId: number, to: Address, send: boolean): Promise<RecoverResult> {
    return recoverEth({ publicClient: this.deps.publicClient, wallets: this.rt(userId).wallets, to, send });
  }

  /** ETH price in USD for a user: their own override if set, otherwise the live price. */
  async ethUsd(userId?: number): Promise<number | undefined> {
    const own = userId === undefined ? undefined : this.runtimes.get(userId)?.rec.settings.ethUsd;
    return own ?? (await this.price.get());
  }

  // ── Flip planning ───────────────────────────────────────────────────────
  /** Ranks the user's NFTs by rarity and builds their sell/hold plan. */
  async plan(userId: number, onProgress?: (done: number, total: number) => void): Promise<PlanSummary> {
    const rt = this.rt(userId);
    const { plan } = this.deps.tg;
    const s = rt.rec.settings;
    const ethUsd = await this.ethUsd(userId);
    return this.planGate.run(() =>
      analyzeHoldings(
        this.deps.publicClient,
        heldTokens(rt.wallets, rt.state),
        { sample: plan.sample, concurrency: plan.concurrency, cacheDir: plan.cacheDir, gateways: plan.gateways },
        {
          tiers: s.tiers ? parseTiers(s.tiers) : plan.tiers,
          feePct: s.feePct ?? plan.feePct,
          ethUsd,
          gasSpentWei: rt.state.gasSpent(),
          mode: s.tiers ? "tiers" : plan.mode,
          valuation: plan.valuation,
        },
        onProgress,
        { opensea: this.opensea, weth: plan.weth, valuation: plan.valuation },
      ),
    );
  }

  // ── Stats ───────────────────────────────────────────────────────────────
  summary() {
    const rts = [...this.runtimes.values()];
    return {
      users: this.deps.store.count(),
      active: rts.length,
      wallets: rts.reduce((a, r) => a + r.wallets.length, 0),
      live: rts.filter((r) => !r.rec.settings.dryRun && !r.rec.settings.paused && r.wallets.length > 0).length,
      tracking: this.watcher.detector.size(),
      head: this.watcher.currentHead,
      minted: rts.reduce((a, r) => a + r.session.stats.minted, 0),
      gasSpentWei: rts.reduce((a, r) => a + r.state.gasSpent(), 0n),
      inflight: rts.reduce((a, r) => a + r.session.busy, 0),
    };
  }
}
