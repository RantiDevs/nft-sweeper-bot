import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enrich, type Enriched } from "../radar-enrich.js";
import { emptyState, runRadar, type Platform, type RadarState } from "../radar.js";
import { errMsg, log, mapLimit, safeRename } from "../util.js";

/**
 * Runs the drop radar on a timer inside the bot. Each pass reads only the blocks since the last pass (bookmarks live in
 * data/radar.json, which the Supabase sync mirrors), checks every announced free mint on-chain and on OpenSea, and tells
 * the admins about each new one that passes. Never sends a transaction.
 */

export interface RadarServiceOptions {
  dataDir: string;
  intervalMs: number;
  windowSec: number;
  lookbackHours: number;
  openseaKey?: string;
  platforms?: Platform[];
  rpcOverrides?: Record<number, string[]>;
  notify: (html: string) => void;
  /** Called once for each collection that passes every check (used by auto-mint). */
  onWorthy?: (h: Enriched) => void;
  usd?: (amount: number) => string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatHit(h: Enriched): string {
  const when = h.state === "LIVE" ? "LIVE now" : `opens in ${Math.round(h.opensInSec / 60)} min`;
  const left = h.remaining !== undefined && h.max !== undefined ? `${h.remaining}/${h.max} left` : "supply unknown";
  const price = h.floorUsd === undefined ? "floor unknown" : `floor $${h.floorUsd.toFixed(2)}`;
  const link = h.slug ? `https://opensea.io/collection/${h.slug}` : "";
  return [
    `🔭 <b>Free mint · ${esc(h.chain)}</b> (${h.drop.platform})`,
    `${when} · max ${h.drop.maxPerWallet}/wallet · ${left}`,
    `${price} · ${h.owners ?? "?"} holders · ${h.sales24h ?? "?"} sales/24h`,
    `<code>${h.drop.nft}</code>`,
    link ? `<a href="${link}">OpenSea</a>` : "",
    `<i>Checked on-chain (supply, test mint). A floor is not a sale price; most free mints lose value fast.</i>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class RadarService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private state: RadarState;
  private told = new Set<string>();
  /** Result of the last pass, for the /radar command. */
  last?: { at: number; results: Enriched[]; chainsOk: number; chainsTotal: number; partial: string[] };

  constructor(private o: RadarServiceOptions) {
    this.state = this.load();
  }

  private file() {
    return join(this.o.dataDir, "radar.json");
  }

  private load(): RadarState {
    try {
      if (existsSync(this.file())) {
        const s = JSON.parse(readFileSync(this.file(), "utf8")) as RadarState;
        if (s && typeof s.bookmarks === "object" && typeof s.ann === "object") return s;
      }
    } catch (e) {
      log("radar: ignoring unreadable state file:", errMsg(e));
    }
    return emptyState();
  }

  private save() {
    const tmp = `${this.file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    safeRename(tmp, this.file());
  }

  start(): void {
    const tick = () => void this.pass().catch((e) => log("radar pass failed:", errMsg(e)));
    setTimeout(tick, 15_000);
    this.timer = setInterval(tick, this.o.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Safe to call from a command; overlapping calls are ignored. */
  async pass(): Promise<Enriched[]> {
    if (this.running) return this.last?.results ?? [];
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const r = await runRadar({
        windowSec: this.o.windowSec,
        lookbackHours: this.o.lookbackHours,
        platforms: this.o.platforms,
        rpcOverrides: this.o.rpcOverrides,
        state: this.state,
        nowSec: now,
        perChainBudgetMs: 40_000,
      });
      this.save();
      const results = await mapLimit(r.hits, 4, (h) => enrich(h, r.rpcs.get(h.chainId)!, this.o.openseaKey, now));
      this.last = {
        at: Date.now(),
        results,
        chainsOk: r.reports.filter((x) => x.ok).length,
        chainsTotal: r.reports.length,
        partial: r.reports.filter((x) => !x.ok || /partial/.test(x.note)).map((x) => `${x.chain}: ${x.note}`),
      };
      for (const h of results) {
        if (h.verdict !== "WORTH A LOOK") continue;
        const key = `${h.chainId}:${h.drop.nft}:${h.drop.startTime}`;
        if (this.told.has(key)) continue;
        this.told.add(key);
        this.o.notify(formatHit(h));
        try {
          this.o.onWorthy?.(h);
        } catch (e) {
          log("onWorthy failed:", errMsg(e));
        }
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  summary(): string {
    if (!this.last) return "The radar has not finished its first pass yet (it starts about 15 seconds after the bot, and the first pass takes a few minutes).";
    const mins = Math.round((Date.now() - this.last.at) / 60_000);
    const good = this.last.results.filter((r) => r.verdict === "WORTH A LOOK");
    const lines = [`🔭 <b>Radar</b> · last pass ${mins} min ago · ${this.last.chainsOk}/${this.last.chainsTotal} chains reachable`];
    lines.push(good.length ? `${good.length} free mint(s) worth a look:` : "No free public mint passes the checks right now.");
    for (const h of good.slice(0, 5)) lines.push("", formatHit(h));
    const skipped = this.last.results.length - good.length;
    if (skipped) lines.push("", `${skipped} other free mint(s) were skipped (sold out, no price, tiny floor, or too few holders).`);
    if (this.last.partial.length) lines.push("", `<i>Not fully covered: ${esc(this.last.partial.slice(0, 6).map((p) => p.split(":")[0]).join(", "))}${this.last.partial.length > 6 ? "…" : ""}</i>`);
    return lines.join("\n");
  }
}
