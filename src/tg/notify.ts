import { formatEther, type Address, type Hex } from "viem";
import type { SessionEvent } from "../session.js";
import { fmtWei } from "../money.js";
import { errMsg, log, sleep } from "../util.js";

const SKIP_NOTICE_GAP_MS = 15 * 60_000;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Splits long text on line boundaries to stay under Telegram's 4096 character limit. */
export function chunk(text: string, max = 3800): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > max && cur) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

export interface SendApi {
  sendMessage(chatId: number, text: string, other?: { parse_mode?: "HTML"; link_preview_options?: { is_disabled: boolean } }): Promise<unknown>;
}

/**
 * Pushes bot events to users and admins. Messages to one chat are spaced out
 * (Telegram allows ~1 message/second per chat); delivery failures, such as a
 * user who blocked the bot, are logged and never break minting.
 */
export class Notifier {
  private chains = new Map<number, Promise<void>>();

  constructor(
    private api: SendApi,
    private adminIds: number[],
    private explorer?: string,
    /** Current ETH/USD price, for showing gas in dollars. */
    private price: () => number | undefined = () => undefined,
  ) {}

  send(chatId: number, html: string): Promise<void> {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const part of chunk(html)) {
        try {
          await this.api.sendMessage(chatId, part, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        } catch (e) {
          log(`telegram send to ${chatId} failed:`, errMsg(e));
          break;
        }
        await sleep(350);
      }
    });
    this.chains.set(chatId, next);
    void next.finally(() => {
      if (this.chains.get(chatId) === next) this.chains.delete(chatId);
    });
    return next;
  }

  admins(html: string): void {
    for (const id of this.adminIds) void this.send(id, html);
  }

  /** Resolves when every queued message has been delivered (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }

  private tx(h: Hex): string {
    return this.explorer ? `<a href="${this.explorer}/tx/${h}">${short(h)}</a>` : `<code>${short(h)}</code>`;
  }

  private col(a: Address): string {
    return this.explorer ? `<a href="${this.explorer}/address/${a}">${short(a)}</a>` : `<code>${short(a)}</code>`;
  }

  /** When each user was last told about a skipped round, so a run of skips is one message, not dozens. */
  private lastSkipNotice = new Map<number, number>();

  event(userId: number, e: SessionEvent): void {
    // Most free mints are gated (allowlists, proofs, owner-only) and simply cannot be copied; telling
    // the user about each one would bury everything useful. A skip is only worth a message when
    // the user can do something about it (fund a wallet, raise the budget), and at most every 15 min.
    if (e.type === "gas-wait") {
      const last = this.lastSkipNotice.get(userId) ?? 0;
      if (Date.now() - last < SKIP_NOTICE_GAP_MS) return;
      this.lastSkipNotice.set(userId, Date.now());
    }
    if (e.type === "round" && e.minted + e.wouldMint + e.failed === 0) {
      const actionable = /balance|BUDGET|base fee/i.test(e.note ?? "");
      const last = this.lastSkipNotice.get(userId) ?? 0;
      if (!actionable || Date.now() - last < SKIP_NOTICE_GAP_MS) return;
      this.lastSkipNotice.set(userId, Date.now());
    }
    const text = this.format(e);
    if (text) void this.send(userId, text);
  }

  format(e: SessionEvent): string | undefined {
    switch (e.type) {
      case "round": {
        const lines: string[] = [];
        if (e.minted > 0) {
          lines.push(
            `✅ <b>Minted ${e.tokens} NFT${e.tokens === 1 ? "" : "s"}</b> from ${this.col(e.collection)} with ${e.minted} wallet${e.minted === 1 ? "" : "s"}`,
            `Gas paid: ${fmtWei(e.gasWei, this.price())}`,
            `Tx: ${e.txs.slice(0, 3).map((h) => this.tx(h)).join(", ")}${e.txs.length > 3 ? ` +${e.txs.length - 3} more` : ""}`,
          );
        }
        if (e.wouldMint > 0) {
          lines.push(`🧪 <b>Dry run:</b> ${e.wouldMint} wallet${e.wouldMint === 1 ? "" : "s"} could mint ${this.col(e.collection)} (nothing sent). Use /live to mint for real.`);
        }
        if (e.failed > 0) lines.push(`⚠️ ${e.failed} failed on ${this.col(e.collection)}${e.note ? `: ${esc(e.note.slice(0, 160))}` : ""}`);
        if (e.minted + e.wouldMint === 0 && e.failed === 0 && e.skipped > 0) {
          lines.push(`⏭ Skipped ${this.col(e.collection)}${e.note ? `: ${esc(e.note.slice(0, 160))}` : ""}`);
        }
        return lines.join("\n") || undefined;
      }
      case "gas-wait": {
        const px = this.price();
        const money = (wei: bigint) => (px ? `${fmtWei(wei, px)}` : `${formatEther(wei)} ETH`);
        return `⛽ <b>Waiting for cheaper gas.</b> A mint costs about ${money(e.costWei)} right now; your cap is ${money(e.capWei)}. I'll keep checking and mint when it drops. Raise the cap with <code>/set maxgas</code> if you'd rather pay the current price.`;
      }
      case "bad":
        return `🚫 Blocked ${this.col(e.collection)}: ${esc(e.reason)}`;
      case "budget-exhausted":
        return "🛑 <b>Gas budget reached</b>: minting is paused. Raise it with <code>/set budget 0.05</code> (ETH).";
      case "hot":
        return undefined;
    }
  }
}
