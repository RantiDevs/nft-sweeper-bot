import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { formatEther } from "viem";
import type { Enriched } from "../radar-enrich.js";
import { mintDrop } from "../mintdrop.js";
import { errMsg, log, Mutex, safeRename, sleep } from "../util.js";
import type { Hub } from "./hub.js";
import type { UserStore } from "./store.js";

/**
 * Automatic minting of radar finds, OFF by default and switched per user with /automint.
 *
 * What it does when a collection passes the radar's checks: waits for the public stage to open, then mints with every
 * wallet of each user who turned it on, through the same guarded path as /mintdrop (value 0, only mintPublic, each wallet
 * simulated first). On top of that:
 *   - the user's own mode applies: in dry-run it only simulates and reports;
 *   - a per-mint gas ceiling in dollars (a wallet whose worst-case gas cost is above it is skipped);
 *   - a daily spending ceiling in dollars, counted from the gas actually paid;
 *   - a collection is attempted once per user.
 */

export const DEFAULT_MAX_GAS_USD = 0.1;
export const DEFAULT_DAILY_USD = 1;

interface Ledger {
  day: string;
  usd: Record<string, number>;
}

export interface AutoMinterDeps {
  hub: Hub;
  store: UserStore;
  dataDir: string;
  notify: (userId: number, html: string) => void;
  quantity?: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class AutoMinter {
  private done = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  private perUser = new Map<number, Mutex>();
  private stopped = false;

  constructor(private d: AutoMinterDeps) {}

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }

  private ledgerFile() {
    return join(this.d.dataDir, "automint-ledger.json");
  }

  private ledger(): Ledger {
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (existsSync(this.ledgerFile())) {
        const l = JSON.parse(readFileSync(this.ledgerFile(), "utf8")) as Ledger;
        if (l.day === today) return l;
      }
    } catch {
      /* start a fresh day */
    }
    return { day: today, usd: {} };
  }

  private addSpend(userId: number, usd: number) {
    const l = this.ledger();
    l.usd[userId] = (l.usd[userId] ?? 0) + usd;
    const tmp = `${this.ledgerFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(l));
    safeRename(tmp, this.ledgerFile());
  }

  spentToday(userId: number): number {
    return this.ledger().usd[userId] ?? 0;
  }

  /** Called by the radar for every collection that passed its checks. */
  consider(h: Enriched): void {
    for (const u of this.d.store.all()) {
      if (u.status !== "active" || !u.settings.autoMint || u.wallets.length === 0) continue;
      const key = `${u.id}:${h.chainId}:${h.drop.nft}:${h.drop.startTime}`;
      if (this.done.has(key)) continue;
      this.done.add(key);
      const wait = Math.max(0, h.drop.startTime * 1000 - Date.now());
      const t = setTimeout(() => {
        this.timers.delete(t);
        void this.run(u.id, h).catch((e) => log("automint failed:", errMsg(e)));
      }, Math.min(wait, 3 * 3600_000));
      this.timers.add(t);
      if (wait > 5000) this.d.notify(u.id, `⏱ Auto-mint armed for <code>${h.drop.nft.slice(0, 10)}…</code> on ${esc(h.chain)}; it will fire when the stage opens in ${Math.round(wait / 60_000)} min.`);
    }
  }

  private lock(userId: number): Mutex {
    let m = this.perUser.get(userId);
    if (!m) this.perUser.set(userId, (m = new Mutex()));
    return m;
  }

  private async run(userId: number, h: Enriched): Promise<void> {
    if (this.stopped) return;
    await this.lock(userId).run(async () => {
      const u = this.d.store.get(userId);
      // Re-read the switch: the user may have turned it off while it waited.
      if (!u || u.status !== "active" || !u.settings.autoMint) return;
      const s = u.settings;
      const dailyCap = s.autoMintDailyUsd ?? DEFAULT_DAILY_USD;
      const gasCap = s.autoMintMaxGasUsd ?? DEFAULT_MAX_GAS_USD;
      const label = `${h.drop.nft.slice(0, 10)}… on ${esc(h.chain)}`;
      if (!h.nativeUsd) return this.d.notify(userId, `⏭ Auto-mint skipped ${label}: no dollar price for ${esc(h.symbol)}, so I can't enforce your gas ceiling.`);
      if (this.spentToday(userId) >= dailyCap) return this.d.notify(userId, `⏭ Auto-mint skipped ${label}: today's $${dailyCap} limit is used up.`);

      const maxGasWei = BigInt(Math.floor((gasCap / h.nativeUsd) * 1e18));
      const accounts = this.d.hub.exportKeys(userId).map((k) => privateKeyToAccount(k.key as `0x${string}`));
      const execute = !s.dryRun;

      // The stage may open a second or two after our timer; keep trying briefly.
      let out: Awaited<ReturnType<typeof mintDrop>> | undefined;
      let lastErr = "";
      for (let i = 0; i < 40 && !this.stopped; i++) {
        try {
          out = await mintDrop({ chainId: h.chainId, nft: h.drop.nft, accounts, execute, quantity: this.d.quantity ?? 1, maxGasWei });
          break;
        } catch (e) {
          lastErr = errMsg(e);
          if (!/opens in|not yet/i.test(lastErr)) break;
          await sleep(1000);
        }
      }
      if (!out) return this.d.notify(userId, `🛑 Auto-mint ${label} did not run: ${esc(lastErr.slice(0, 160))}`);

      const spentWei = out.results.reduce((a, r) => a + (r.status === "minted" || r.status === "failed" ? (r.costWei ?? 0n) : 0n), 0n);
      const spentUsd = Number(formatEther(spentWei)) * h.nativeUsd;
      if (spentUsd > 0) this.addSpend(userId, spentUsd);
      const minted = out.results.filter((r) => r.status === "minted");
      const lines = [
        `${execute ? "🤖" : "🧪"} <b>Auto-mint ${execute ? "" : "(dry run) "}${label}</b>`,
        esc(out.summary),
        execute ? `Gas paid ≈ $${spentUsd.toFixed(3)} · today $${this.spentToday(userId).toFixed(3)} of $${dailyCap}` : "Dry-run mode: nothing was sent. Use /live to mint for real.",
      ];
      const why = [...new Set(out.results.filter((r) => r.status === "skipped" || r.status === "failed").map((r) => r.note.slice(0, 70)))].slice(0, 3);
      if (why.length) lines.push(`<i>${why.map(esc).join(" · ")}</i>`);
      if (minted.length) lines.push("Consider selling promptly: free-mint floors usually fall.");
      this.d.notify(userId, lines.join("\n"));
    });
  }
}
