import { randomBytes } from "node:crypto";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { formatEther, getAddress, isAddress, parseEther, type Address } from "viem";
import { parseTiers, planCsv, tierLabel } from "../rarity/plan.js";
import { formatPlan } from "../rarity/report.js";
import { fmtUsd, fmtWei, parseMoney } from "../money.js";
import { errMsg, log } from "../util.js";
import type { TgConfig } from "./config.js";
import type { Hub } from "./hub.js";
import { chunk, esc, short, type Notifier } from "./notify.js";
import type { UserRecord, UserSettings, UserStore } from "./store.js";

export interface BotDeps {
  tg: TgConfig;
  hub: Hub;
  store: UserStore;
  notifier: Notifier;
}

interface Pending {
  kind: "live" | "collect" | "recover" | "export";
  token: string;
  exp: number;
  data?: unknown;
}

const CONFIRM_TTL_MS = 60_000;


const HELP = [
  "<b>Wallets</b>",
  "/newwallets <code>n</code> – create wallets",
  "/wallets – balances · /deposit – addresses to fund",
  "<b>Running</b>",
  "/status · /settings · /pause · /resume",
  "/dry – simulate only (default) · /live – really mint",
  "/mode <code>sweep|hot</code> – sweep = every new free NFT that passes safety checks; hot = only crowded mints",
  "<code>/set maxgas|budget|minminters|mintxs|maxper|wallets value</code> (maxgas and budget are in dollars, e.g. <code>/set budget 2</code>; wallets = how many wallets mint each collection, 0 = all)",
  "<b>Targets</b>",
  "/allow <code>0x…</code> /unallow – snipe only these collections",
  "/deny <code>0x…</code> /undeny – never mint these · /lists",
  "<b>Your NFTs</b>",
  "/nfts · /vault <code>0x…</code> · /collect – move NFTs to your vault",
  "/plan – rank your NFTs by trait rarity: what to hold, what to sell at which price",
  "/tiers <code>hold:15,25:10,12.5:25,5:50</code> · <code>/set ethprice 3000</code> · <code>/set fee 5</code>",
  "/recover <code>0x…</code> – send leftover ETH out · /export – show keys",
  "/notify <code>on|off</code>",
].join("\n");

const ADMIN_HELP = "\n<b>Admin</b>\n/invite · /users · /ban <code>id</code> · /unban <code>id</code> · /stats · /broadcast <code>text</code>";

function parseAddress(s: string | undefined): Address | undefined {
  return s && isAddress(s, { strict: false }) ? getAddress(s) : undefined;
}

function parseEthArg(s: string): bigint | undefined {
  return /^\d{1,3}(\.\d{1,18})?$/.test(s) ? parseEther(s) : undefined;
}

function intIn(s: string, lo: number, hi: number): number | undefined {
  const n = Number(s);
  return /^\d+$/.test(s) && n >= lo && n <= hi ? n : undefined;
}

export function registerHandlers(bot: Bot, d: BotDeps): void {
  const { tg, hub, store, notifier } = d;
  const pending = new Map<number, Pending>();
  const lastSeen = new Map<number, number>();

  const say = (ctx: Context, html: string, extra: Record<string, unknown> = {}) =>
    ctx.reply(html, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

  const sayLong = async (ctx: Context, html: string) => {
    for (const part of chunk(html)) await say(ctx, part);
  };

  // ── Gatekeeping ─────────────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return; // groups never get wallet commands
    const now = Date.now();
    const last = lastSeen.get(ctx.from.id) ?? 0;
    if (now - last < tg.commandGapMs) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    lastSeen.set(ctx.from.id, now);
    if (lastSeen.size > 5000) for (const [k, t] of lastSeen) if (now - t > 60_000) lastSeen.delete(k);
    await next();
  });

  bot.catch((err) => {
    log("bot error:", errMsg(err.error));
    err.ctx.reply("Something went wrong on my side. Try again in a moment.").catch(() => {});
  });

  function cmd(
    names: string | string[],
    fn: (ctx: Context, u: UserRecord, args: string[]) => Promise<unknown>,
    opts: { admin?: boolean } = {},
  ) {
    bot.command(names, async (ctx) => {
      const u = hub.record(ctx.from!.id);
      if (!u || !hub.has(u.id)) {
        if (u?.status === "banned") return;
        return void (await say(ctx, "Send /start first."));
      }
      if (opts.admin && u.role !== "admin") return;
      const args = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
      await fn(ctx, u, args);
    });
  }

  function ask(ctx: Context, kind: Pending["kind"], html: string, data?: unknown) {
    const token = randomBytes(4).toString("hex");
    pending.set(ctx.from!.id, { kind, token, exp: Date.now() + CONFIRM_TTL_MS, data });
    const kb = new InlineKeyboard().text("✅ Confirm", `c:${token}`).text("✖ Cancel", `x:${token}`);
    return say(ctx, `${html}\n\n<i>Confirm within 60 seconds.</i>`, { reply_markup: kb });
  }

  // ── Onboarding ──────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const id = ctx.from!.id;
    const code = String(ctx.match ?? "").trim();
    const isAdmin = tg.adminIds.includes(id);
    let u = hub.record(id);
    if (u?.status === "banned") return;
    if (!u) {
      if (store.count() >= tg.maxUsers && !isAdmin) return void (await say(ctx, "The bot is full right now. Ask the operator."));
      const ok = isAdmin || tg.openRegistration || (code !== "" && store.consumeInvite(code));
      if (!ok) return void (await say(ctx, "🔒 This bot is invite-only. Ask the operator for an invite link."));
      u = hub.register(id, ctx.from!.username, isAdmin ? "admin" : "user");
    } else if (isAdmin && u.role !== "admin") {
      u.role = "admin";
      store.save();
    }
    await say(
      ctx,
      [
        "👋 <b>Robinhood Chain free-mint sweeper</b>",
        "I watch the chain for free mints that many wallets are minting right now, and mint them from <b>your</b> wallets.",
        "",
        "1. /newwallets 5 – I generate wallets for you",
        "2. /deposit – send a little ETH (gas) to them",
        "3. You start in <b>dry-run</b>: I only report what I would mint. /live turns real minting on.",
        "",
        "⚠️ These wallets are <b>custodial</b>: the bot's server holds their keys (encrypted). Only fund what you can afford to lose, and use /collect to move NFTs to your own wallet.",
        "",
        HELP + (u.role === "admin" ? ADMIN_HELP : ""),
      ].join("\n"),
    );
  });

  cmd("help", async (ctx, u) => say(ctx, HELP + (u.role === "admin" ? ADMIN_HELP : "")));

  // ── Wallets ─────────────────────────────────────────────────────────────
  cmd("newwallets", async (ctx, u, args) => {
    const n = intIn(args[0] ?? "", 1, tg.maxWalletsPerUser);
    if (n === undefined) return say(ctx, `Usage: <code>/newwallets 5</code> (1–${tg.maxWalletsPerUser}; you have ${u.wallets.length})`);
    let addrs: Address[];
    try {
      addrs = hub.addWallets(u.id, n);
    } catch (e) {
      return say(ctx, esc(errMsg(e)));
    }
    await sayLong(ctx, [`✅ Created ${addrs.length} wallet(s). Send gas ETH (Robinhood Chain only) to:`, ...addrs.map((a) => `<code>${a}</code>`)].join("\n"));
  });

  cmd("wallets", async (ctx, u) => {
    if (u.wallets.length === 0) return say(ctx, "No wallets yet. Try <code>/newwallets 5</code>.");
    const [rows, px] = await Promise.all([hub.balances(u.id), hub.ethUsd(u.id)]);
    const total = rows.reduce((a, r) => a + (r.wei ?? 0n), 0n);
    const holdings = hub.state(u.id);
    await sayLong(
      ctx,
      [
        ...rows.map((r) => `${r.label} <code>${short(r.address)}</code> ${r.wei === null ? "?" : fmtWei(r.wei, px)} · ${holdings.holdings(r.address).length} NFT`),
        `<b>Total ${fmtWei(total, px)}</b>`,
      ].join("\n"),
    );
  });

  cmd("deposit", async (ctx, u) => {
    if (u.wallets.length === 0) return say(ctx, "No wallets yet. Try <code>/newwallets 5</code>.");
    await sayLong(ctx, ["Send gas ETH on <b>Robinhood Chain (4663)</b> to any of these:", ...u.wallets.map((w, i) => `w${String(i + 1).padStart(2, "0")} <code>${w.address}</code>`)].join("\n"));
  });

  // ── Status & settings ───────────────────────────────────────────────────
  /** An ETH amount as dollars (plus ETH), when the price is known. */
  const cap = (ethStr: string, px: number | undefined) => (px === undefined ? `${ethStr} ETH` : `${fmtUsd(Number(ethStr) * px)} (${ethStr} ETH)`);

  const settingsText = (u: UserRecord, px: number | undefined) => {
    const s = u.settings;
    return [
      `Mode: <b>${s.dryRun ? "🧪 dry-run" : "🔴 LIVE"}</b>${s.paused ? " (paused)" : ""}`,
      `Per-tx gas cap: ${cap(s.maxGasCostEth, px)} <i>(max ${cap(tg.ceilingMaxGasCostEth, px)})</i>`,
      `Total gas budget: ${cap(s.totalGasBudgetEth, px)} <i>(max ${cap(tg.ceilingTotalGasBudgetEth, px)})</i>`,
      ...(px !== undefined ? [`ETH price: ${fmtUsd(px)}${u.settings.ethUsd ? " (set by you)" : " (live)"}`] : []),
      `Strategy: <b>${s.sweep ?? true ? "sweep every new vetted free mint" : `hot only (≥ ${s.minUniqueMinters} wallets / ${s.minMintTxs} txs minting free)`}</b>`,
      `Mints per collection per wallet: ${s.maxMintsPerCollection} · wallets per collection: ${s.walletsPerCollection ? s.walletsPerCollection : "all"}`,
      `Allowlist: ${s.allowlist.length} · Denylist: ${s.denylist.length} · Notifications: ${s.notify ? "on" : "off"}`,
      `Vault: ${s.vault ? `<code>${short(s.vault)}</code>` : "not set"}`,
    ].join("\n");
  };

  cmd("settings", async (ctx, u) => say(ctx, settingsText(u, await hub.ethUsd(u.id))));

  cmd("status", async (ctx, u) => {
    const sess = hub.session(u.id);
    const st = hub.state(u.id);
    const g = hub.summary();
    const held = u.wallets.reduce((a, w) => a + st.holdings(w.address).length, 0);
    const px = await hub.ethUsd(u.id);
    await say(
      ctx,
      [
        settingsText(u, px),
        "",
        `Wallets: ${u.wallets.length} · NFTs held: ${held}`,
        `Gas spent: ${fmtWei(st.gasSpent(), px)} of ${cap(u.settings.totalGasBudgetEth, px)}`,
        `This session: ${sess.stats.minted} minted · ${sess.stats.failed} failed · ${sess.stats.dryRun} dry-run`,
        `Chain: head ${g.head} · tracking ${g.tracking} free-mint collections`,
      ].join("\n"),
    );
  });

  // Money limits are typed in dollars ("2" or "$2"; "0.001eth" for ETH). Gas is paid in ETH, so
  // dollars are converted at the current price and stored as ETH.
  const moneySetter = (field: "maxGasCostEth" | "totalGasBudgetEth", ceiling: string) => (v: string, px?: number): Partial<UserSettings> | string => {
    const m = parseMoney(v, px);
    if (!m.ok) return m.error;
    const wei = parseEthArg(m.eth);
    if (wei === undefined || wei === 0n) return "That amount is too small or invalid";
    if (wei > parseEther(ceiling)) return `Max allowed is ${px === undefined ? `${ceiling} ETH` : fmtUsd(Number(ceiling) * px)}`;
    return { [field]: m.eth } as Partial<UserSettings>;
  };

  const setters: Record<string, (v: string, px?: number) => Partial<UserSettings> | string> = {
    maxgas: moneySetter("maxGasCostEth", tg.ceilingMaxGasCostEth),
    budget: moneySetter("totalGasBudgetEth", tg.ceilingTotalGasBudgetEth),
    minminters: (v) => {
      const n = intIn(v, 1, 1000);
      return n === undefined ? "Give a number between 1 and 1000" : { minUniqueMinters: n };
    },
    mintxs: (v) => {
      const n = intIn(v, 1, 10_000);
      return n === undefined ? "Give a number between 1 and 10000" : { minMintTxs: n };
    },
    wallets: (v) => {
      const n = intIn(v, 0, 100);
      return n === undefined ? "Give a number from 0 (all wallets) to 100" : { walletsPerCollection: n };
    },
    ethprice: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 1_000_000 ? { ethUsd: n } : "Give the ETH price in USD, e.g. 3000";
    },
    fee: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 50 ? { feePct: n } : "Give marketplace fee + royalty in percent, e.g. 5";
    },
    maxper: (v) => {
      const n = intIn(v, 1, 10);
      return n === undefined ? "Give a number between 1 and 10" : { maxMintsPerCollection: n };
    },
  };

  cmd("set", async (ctx, u, args) => {
    const fn = setters[(args[0] ?? "").toLowerCase()];
    if (!fn || args.length < 2) return say(ctx, `Usage: <code>/set ${Object.keys(setters).join("|")} value</code>`);
    const px = await hub.ethUsd(u.id);
    const r = fn(args[1], px);
    if (typeof r === "string") return say(ctx, `❌ ${esc(r)}`);
    hub.update(u.id, r);
    await say(ctx, `✅ Updated.\n${settingsText(u, px)}`);
  });

  cmd("mode", async (ctx, u, args) => {
    const v = (args[0] ?? "").toLowerCase();
    if (v !== "sweep" && v !== "hot") return say(ctx, "Usage: <code>/mode sweep</code> (every new vetted free NFT) or <code>/mode hot</code> (only crowded mints)");
    hub.update(u.id, { sweep: v === "sweep" });
    await say(ctx, v === "sweep" ? "🧹 Sweep mode: I'll mint every new collection that passes the safety checks." : "🔥 Hot mode: I'll wait until many wallets are minting a collection.");
  });

  cmd("tiers", async (ctx, u, args) => {
    const spec = args.join("");
    if (!spec) {
      const cur = u.settings.tiers ? parseTiers(u.settings.tiers) : tg.plan.tiers;
      return say(
        ctx,
        [
          "Tiers, rarest first:",
          ...cur.map((t) => `${tierLabel(t)}: ${t.pct}%`),
          "",
          "Change: <code>/tiers hold:15,25:10,12.5:25,5:50</code> · reset: <code>/tiers default</code>",
        ].join("\n"),
      );
    }
    if (spec.toLowerCase() === "default") {
      hub.update(u.id, { tiers: undefined });
      return say(ctx, "Tiers reset to the default.");
    }
    try {
      parseTiers(spec);
    } catch (e) {
      return say(ctx, `❌ ${esc(errMsg(e))}`);
    }
    hub.update(u.id, { tiers: spec });
    await say(ctx, "✅ Tiers updated. Run /plan to apply them.");
  });

  const planning = new Set<number>();
  cmd("plan", async (ctx, u) => {
    if (planning.has(u.id)) return say(ctx, "Already analysing your NFTs, hang on.");
    const held = u.wallets.reduce((a, w) => a + hub.state(u.id).holdings(w.address).length, 0);
    if (held === 0) return say(ctx, "No NFTs yet. Once the bot mints some, /plan ranks them.");
    planning.add(u.id);
    try {
      await say(ctx, `🔎 Ranking ${held} NFT(s) by trait rarity against their full collections. This can take a few minutes for big collections.`);
      const plan = await hub.plan(u.id);
      await say(ctx, formatPlan(plan, { html: true }));
      await ctx.replyWithDocument(new InputFile(Buffer.from(planCsv(plan.rows)), "flip-plan.csv"), {
        caption: "Every NFT, rarest first, with its action and target price.",
      });
    } finally {
      planning.delete(u.id);
    }
  });

  cmd("dry", async (ctx, u) => {
    hub.update(u.id, { dryRun: true });
    await say(ctx, "🧪 Dry-run on: I'll simulate and report, but send nothing.");
  });

  cmd("live", async (ctx, u) => {
    if (u.wallets.length === 0) return say(ctx, "Create and fund wallets first: <code>/newwallets 5</code>.");
    if (!u.settings.dryRun) return say(ctx, "Already live.");
    const livePx = await hub.ethUsd(u.id);
    await ask(
      ctx,
      "live",
      `🔴 <b>Go live?</b> I will spend real ETH on gas from your ${u.wallets.length} wallet(s) whenever a free mint qualifies.\n` +
        `Caps: ${cap(u.settings.maxGasCostEth, livePx)} per tx, ${cap(u.settings.totalGasBudgetEth, livePx)} in total.`,
    );
  });

  cmd("pause", async (ctx, u) => {
    hub.update(u.id, { paused: true });
    await say(ctx, "⏸ Paused. /resume to continue.");
  });
  cmd("resume", async (ctx, u) => {
    hub.update(u.id, { paused: false });
    await say(ctx, "▶️ Resumed.");
  });
  cmd("notify", async (ctx, u, args) => {
    const v = (args[0] ?? "").toLowerCase();
    if (v !== "on" && v !== "off") return say(ctx, "Usage: <code>/notify on</code> or <code>/notify off</code>");
    hub.update(u.id, { notify: v === "on" });
    await say(ctx, `Notifications ${v}.`);
  });

  // ── Allow / deny lists ──────────────────────────────────────────────────
  const listCmd = (name: string, field: "allowlist" | "denylist", add: boolean) =>
    cmd(name, async (ctx, u, args) => {
      const a = parseAddress(args[0]);
      if (!a) return say(ctx, `Usage: <code>/${name} 0x…</code>`);
      const list = new Set(u.settings[field]);
      if (add) {
        if (list.size >= 200) return say(ctx, "List is full (200).");
        list.add(a);
      } else list.delete(a);
      hub.update(u.id, { [field]: [...list] });
      const hint = field === "allowlist" && add ? "\nSnipe mode: I now mint <b>only</b> allowlisted collections, on the first free mint I see." : "";
      await say(ctx, `✅ ${field} now has ${list.size} address(es).${hint}`);
    });
  listCmd("allow", "allowlist", true);
  listCmd("unallow", "allowlist", false);
  listCmd("deny", "denylist", true);
  listCmd("undeny", "denylist", false);

  cmd("lists", async (ctx, u) =>
    sayLong(
      ctx,
      [
        `<b>Allowlist</b> (${u.settings.allowlist.length})`,
        ...u.settings.allowlist.map((a) => `<code>${a}</code>`),
        `<b>Denylist</b> (${u.settings.denylist.length})`,
        ...u.settings.denylist.map((a) => `<code>${a}</code>`),
      ].join("\n"),
    ),
  );

  // ── NFTs, vault, recovery, export ───────────────────────────────────────
  cmd("nfts", async (ctx, u) => {
    const st = hub.state(u.id);
    const byCollection = new Map<string, number>();
    for (const w of u.wallets) for (const h of st.holdings(w.address)) byCollection.set(h.collection, (byCollection.get(h.collection) ?? 0) + 1);
    if (byCollection.size === 0) return say(ctx, "No NFTs minted yet.");
    await sayLong(ctx, [...byCollection].map(([c, n]) => `<code>${short(c)}</code> × ${n}`).join("\n"));
  });

  cmd("vault", async (ctx, u, args) => {
    const a = parseAddress(args[0]);
    if (!a) return say(ctx, `Usage: <code>/vault 0x…</code> (your own wallet; currently ${u.settings.vault ? `<code>${u.settings.vault}</code>` : "not set"})`);
    hub.update(u.id, { vault: a });
    await say(ctx, `✅ Vault set to <code>${a}</code>. /collect moves your NFTs there.`);
  });

  cmd("collect", async (ctx, u) => {
    const vault = u.settings.vault;
    if (!vault) return say(ctx, "Set a destination first: <code>/vault 0x…</code>");
    const plan = await hub.collect(u.id, vault, false);
    if (plan.planned === 0) return say(ctx, "Nothing to collect.");
    await ask(ctx, "collect", `Move <b>${plan.planned}</b> NFT(s) to <code>${vault}</code>? Each transfer costs a little gas from the holding wallet.`, { vault });
  });

  cmd("recover", async (ctx, u, args) => {
    const to = parseAddress(args[0]);
    if (!to) return say(ctx, "Usage: <code>/recover 0x…</code> – sends leftover ETH from all your wallets to that address.");
    const plan = await hub.recover(u.id, to, false);
    if (plan.total === 0n) return say(ctx, "Nothing worth recovering (balances don't cover the transfer fee).");
    await ask(ctx, "recover", `Send about <b>${fmtWei(plan.total, await hub.ethUsd(u.id))}</b> from your wallets to <code>${to}</code>?`, { to });
  });

  cmd("export", async (ctx, u) => {
    if (!tg.allowExport) return say(ctx, "Key export is disabled by the operator.");
    if (u.wallets.length === 0) return say(ctx, "No wallets yet.");
    await ask(ctx, "export", `🔑 Show the <b>private keys</b> of your ${u.wallets.length} wallet(s) here? Anyone who sees this chat can steal the funds. The message deletes itself after ${tg.exportTtlSec}s.`);
  });

  // ── Confirmations ───────────────────────────────────────────────────────
  bot.callbackQuery(/^(c|x):([0-9a-f]{8})$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = ctx.from.id;
    const [, action, token] = ctx.match as RegExpMatchArray;
    const p = pending.get(id);
    const clear = () => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const u = hub.record(id);
    if (!u || !hub.has(id)) return;
    if (!p || p.token !== token || p.exp < Date.now()) {
      await clear();
      return void (await say(ctx, "That confirmation expired. Run the command again."));
    }
    pending.delete(id);
    await clear();
    if (action === "x") return void (await say(ctx, "Cancelled."));

    switch (p.kind) {
      case "live":
        hub.update(id, { dryRun: false });
        return void (await say(ctx, "🔴 <b>Live.</b> I'll mint qualifying free mints from your wallets. /dry to stop sending."));
      case "collect": {
        await say(ctx, "Moving NFTs…");
        const r = await hub.collect(id, (p.data as { vault: Address }).vault, true);
        const bad = r.lines.filter((l) => !l.startsWith("moved")).slice(0, 5).map((l) => esc(l.slice(0, 200)));
        return void (await sayLong(ctx, [`Moved ${r.moved}/${r.planned}.${r.failed ? ` ${r.failed} failed:` : ""}`, ...bad].join("\n")));
      }
      case "recover": {
        await say(ctx, "Sending…");
        const r = await hub.recover(id, (p.data as { to: Address }).to, true);
        return void (await say(ctx, `Sent ${fmtWei(r.total, await hub.ethUsd(id))} from ${r.sent} wallet(s).${r.failed ? ` ${r.failed} failed.` : ""}`));
      }
      case "export": {
        if (!tg.allowExport) return;
        const body = hub.exportKeys(id).map((k) => `${k.label} <code>${k.address}</code>\n<code>${k.key}</code>`).join("\n\n");
        const sent = await say(ctx, `🔑 <b>Private keys</b> (deleting in ${tg.exportTtlSec}s)\n\n${body}`);
        const t = setTimeout(() => ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => {}), tg.exportTtlSec * 1000);
        t.unref?.();
        return;
      }
    }
  });

  // ── Admin ───────────────────────────────────────────────────────────────
  cmd(
    "invite",
    async (ctx) => {
      const code = store.createInvite(ctx.from!.id);
      const link = ctx.me.username ? `https://t.me/${ctx.me.username}?start=${code}` : `/start ${code}`;
      await say(ctx, `Single-use invite (valid 7 days):\n${link}`);
    },
    { admin: true },
  );

  cmd(
    "users",
    async (ctx) => {
      const rows = store.all().slice(0, 60).map((r) => `${r.id}${r.username ? ` @${esc(r.username)}` : ""} · ${r.role} · ${r.status} · ${r.wallets.length}w · ${r.settings.dryRun ? "dry" : "live"}`);
      await sayLong(ctx, [`${store.count()} user(s), ${store.openInvites()} open invite(s)`, ...rows].join("\n"));
    },
    { admin: true },
  );

  const banCmd = (name: string, banned: boolean) =>
    cmd(
      name,
      async (ctx, _u, args) => {
        const id = Number(args[0]);
        if (!Number.isSafeInteger(id) || id <= 0) return say(ctx, `Usage: <code>/${name} telegram_id</code>`);
        if (tg.adminIds.includes(id)) return say(ctx, "Admins configured in ADMIN_IDS can't be banned.");
        if (!hub.setBanned(id, banned)) return say(ctx, "Unknown user.");
        await say(ctx, banned ? `🚫 Banned ${id}; their session is stopped (wallets and funds untouched).` : `✅ Unbanned ${id}.`);
      },
      { admin: true },
    );
  banCmd("ban", true);
  banCmd("unban", false);

  cmd(
    "stats",
    async (ctx) => {
      const s = hub.summary();
      await say(
        ctx,
        [
          `Users: ${s.users} (${s.active} active, ${s.live} live)`,
          `Wallets: ${s.wallets}`,
          `Chain head ${s.head} · tracking ${s.tracking} collections`,
          `Minted: ${s.minted} · in flight ${s.inflight}`,
          `Gas spent (all users): ${fmtWei(s.gasSpentWei, await hub.ethUsd())}`,
        ].join("\n"),
      );
    },
    { admin: true },
  );

  cmd(
    "broadcast",
    async (ctx, _u, args) => {
      const text = args.join(" ");
      if (!text) return say(ctx, "Usage: <code>/broadcast message</code>");
      const targets = store.all().filter((r) => r.status === "active");
      for (const r of targets) void notifier.send(r.id, `📢 ${esc(text)}`);
      await say(ctx, `Sending to ${targets.length} user(s).`);
    },
    { admin: true },
  );
}
