import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { defineChain, parseEther, type PublicClient } from "viem";
import { loadTgConfig, usersFile } from "../src/tg/config.js";
import { decrypt, encrypt, generateMasterKey, parseMasterKey } from "../src/tg/crypto.js";
import { registerHandlers } from "../src/tg/handlers.js";
import { EthPriceOracle } from "../src/price.js";
import { Hub } from "../src/tg/hub.js";
import { Notifier } from "../src/tg/notify.js";
import { UserStore } from "../src/tg/store.js";

const ADMIN = 1;
const ALICE = 100;
const BOB = 200;

describe("crypto", () => {
  const key = parseMasterKey(generateMasterKey());

  it("round-trips and binds ciphertext to its owner", () => {
    const blob = encrypt("0xsecret", key, "1:0xabc");
    expect(blob).not.toContain("secret");
    expect(decrypt(blob, key, "1:0xabc")).toBe("0xsecret");
    expect(() => decrypt(blob, key, "2:0xabc")).toThrow();
  });

  it("rejects the wrong key and tampered data", () => {
    const blob = encrypt("0xsecret", key, "a");
    expect(() => decrypt(blob, parseMasterKey(generateMasterKey()), "a")).toThrow();
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key, "a")).toThrow();
  });

  it("validates MASTER_KEY", () => {
    expect(() => parseMasterKey(undefined)).toThrow(/required/);
    expect(() => parseMasterKey("abcd")).toThrow(/32 bytes/);
  });
});

describe("UserStore", () => {
  it("persists users and consumes invites once", () => {
    const file = join(mkdtempSync(join(tmpdir(), "store-")), "users.json");
    const a = new UserStore(file);
    const code = a.createInvite(1);
    expect(a.consumeInvite(code)).toBe(true);
    expect(a.consumeInvite(code)).toBe(false);
    expect(a.consumeInvite("nope")).toBe(false);
    expect(new UserStore(file).openInvites()).toBe(0);
  });

  it("expires invites", () => {
    const store = new UserStore(join(mkdtempSync(join(tmpdir(), "store-")), "users.json"));
    expect(store.consumeInvite(store.createInvite(1, -1000))).toBe(false);
  });
});

// ── Bot conversation, with Telegram's API replaced by a recorder ───────────
function harness(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const tg = loadTgConfig({
    TELEGRAM_BOT_TOKEN: "123:abc",
    ADMIN_IDS: String(ADMIN),
    MASTER_KEY: generateMasterKey(),
    DATA_DIR: dir,
    COMMAND_GAP_MS: "0",
    EXPORT_TTL_SEC: "0",
    MAX_WALLETS_PER_USER: "6",
    ...extraEnv,
  });
  const store = new UserStore(usersFile(tg));
  const chain = defineChain({ id: 1337, name: "l", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const publicClient = {
    getBalance: vi.fn().mockResolvedValue(parseEther("0.5")),
    estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
  } as unknown as PublicClient;

  const calls: { method: string; payload: any }[] = [];
  const bot = new Bot("123:abc", {
    botInfo: { id: 1, is_bot: true, first_name: "b", username: "testbot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never,
  });
  let mid = 0;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "sendMessage") return { ok: true, result: { message_id: ++mid, chat: { id: (payload as any).chat_id, type: "private" }, date: 0, text: (payload as any).text } } as never;
    return { ok: true, result: true } as never;
  });
  const notifier = new Notifier(bot.api as never, tg.adminIds, undefined, () => 3000);
  const hub = new Hub({
    publicClient, chain, transport: (() => ({})) as never, tg, store,
    price: new EthPriceOracle({ sources: [], fallback: 3000 }), // fixed $3000, no network
    onUserEvent: (id, e) => notifier.event(id, e),
    onAdminAlert: (t) => notifier.admins(t),
  });
  registerHandlers(bot, { tg, hub, store, notifier });

  let uid = 0;
  const say = async (from: number, text: string, chatType = "private") => {
    const cmdLen = text.startsWith("/") ? text.split(/\s/)[0].length : 0;
    await bot.handleUpdate({
      update_id: ++uid,
      message: {
        message_id: ++uid, date: 0, chat: { id: from, type: chatType }, from: { id: from, is_bot: false, first_name: "u", username: `u${from}` }, text,
        ...(cmdLen ? { entities: [{ type: "bot_command", offset: 0, length: cmdLen }] } : {}),
      },
    } as never);
  };
  const press = async (from: number, data: string) => {
    await bot.handleUpdate({
      update_id: ++uid,
      callback_query: { id: String(uid), from: { id: from, is_bot: false, first_name: "u" }, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id: from, type: "private" } } },
    } as never);
  };
  /** Text of the messages sent to a chat since the last call. */
  const sent = (to: number) => {
    const out = calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === to).map((c) => c.payload.text as string);
    calls.length = 0;
    return out;
  };
  const lastKeyboardToken = () => {
    const c = [...calls].reverse().find((x) => x.payload.reply_markup);
    return (c!.payload.reply_markup.inline_keyboard[0][0].callback_data as string).slice(2);
  };
  return { tg, store, hub, bot, calls, say, press, sent, lastKeyboardToken, notifier, dir };
}

describe("telegram bot", () => {
  it("is invite-only: strangers get nothing, invites are single-use", async () => {
    const h = harness();
    await h.say(ALICE, "/start");
    expect(h.sent(ALICE)[0]).toMatch(/invite-only/);
    expect(h.hub.record(ALICE)).toBeUndefined();

    await h.say(ADMIN, "/start");
    expect(h.hub.record(ADMIN)?.role).toBe("admin");
    await h.say(ADMIN, "/invite");
    const code = /start=([\w-]+)/.exec(h.sent(ADMIN).join())![1];

    await h.say(ALICE, `/start ${code}`);
    expect(h.hub.record(ALICE)?.status).toBe("active");
    await h.say(BOB, `/start ${code}`);
    expect(h.hub.record(BOB)).toBeUndefined();
  });

  it("ignores groups, unregistered commands and non-admin admin commands", async () => {
    const h = harness({ OPEN_REGISTRATION: "true" });
    await h.say(ALICE, "/start", "supergroup");
    expect(h.calls).toHaveLength(0);
    await h.say(ALICE, "/wallets");
    expect(h.sent(ALICE)[0]).toMatch(/Send \/start first/);
    await h.say(ALICE, "/start");
    h.sent(ALICE);
    await h.say(ALICE, "/users");
    await h.say(ALICE, "/ban 5");
    expect(h.sent(ALICE)).toHaveLength(0);
  });

  it("creates wallets whose keys are encrypted on disk, enforces the wallet cap", async () => {
    const h = harness({ OPEN_REGISTRATION: "true" });
    await h.say(ALICE, "/start");
    h.sent(ALICE);
    await h.say(ALICE, "/newwallets 4");
    const addrs = h.sent(ALICE).join().match(/0x[0-9a-fA-F]{40}/g)!;
    expect(addrs).toHaveLength(4);

    const keys = h.hub.exportKeys(ALICE);
    expect(keys.map((k) => k.address)).toEqual(addrs);
    const onDisk = readFileSync(usersFile(h.tg), "utf8");
    for (const k of keys) expect(onDisk).not.toContain(k.key.slice(2));

    await h.say(ALICE, "/newwallets 3");
    expect(h.sent(ALICE).join()).toMatch(/at most 2 more/);
    await h.say(ALICE, "/newwallets 0");
    expect(h.sent(ALICE).join()).toMatch(/Usage/);
  });

  it("starts in dry-run; /live needs confirmation and respects cancel/expiry", async () => {
    const h = harness({ OPEN_REGISTRATION: "true" });
    await h.say(ALICE, "/start");
    await h.say(ALICE, "/live");
    expect(h.sent(ALICE).join()).toMatch(/Create and fund wallets first/);

    await h.say(ALICE, "/newwallets 2");
    h.sent(ALICE);
    await h.say(ALICE, "/live");
    const token = h.lastKeyboardToken();
    expect(h.hub.record(ALICE)!.settings.dryRun).toBe(true);

    await h.press(ALICE, `x:${token}`);
    expect(h.hub.record(ALICE)!.settings.dryRun).toBe(true);
    await h.press(ALICE, `c:${token}`); // already consumed
    expect(h.hub.record(ALICE)!.settings.dryRun).toBe(true);

    await h.say(ALICE, "/live");
    const t2 = h.lastKeyboardToken();
    await h.press(BOB, `c:${t2}`); // someone else's button does nothing
    expect(h.hub.record(ALICE)!.settings.dryRun).toBe(true);
    await h.press(ALICE, `c:${t2}`);
    expect(h.hub.record(ALICE)!.settings.dryRun).toBe(false);

    await h.say(ALICE, "/dry");
    expect(h.hub.record(ALICE)!.settings.dryRun).toBe(true);
  });

  it("validates settings and enforces operator ceilings", async () => {
    const h = harness({ OPEN_REGISTRATION: "true", CEILING_MAX_GAS_COST_ETH: "0.001", CEILING_TOTAL_GAS_BUDGET_ETH: "0.1" });
    await h.say(ALICE, "/start");
    h.sent(ALICE);
    const s = () => h.hub.record(ALICE)!.settings;
    // ETH is $3000 here. Ceilings: 0.001 ETH ($3) per tx and 0.1 ETH ($300) in total.
    await h.say(ALICE, "/set maxgas 0.0015"); // dollars
    expect(s().maxGasCostEth).toBe("0.0000005");
    h.sent(ALICE);
    await h.say(ALICE, "/set maxgas 5"); // $5 is above the $3 ceiling
    expect(h.sent(ALICE).join()).toMatch(/Max allowed is \$3\.00/);
    expect(s().maxGasCostEth).toBe("0.0000005");
    await h.say(ALICE, "/set budget 999"); // above the $300 ceiling
    await h.say(ALICE, "/set minminters 0");
    await h.say(ALICE, "/set minminters abc");
    await h.say(ALICE, "/set nonsense 1");
    expect(s().totalGasBudgetEth).toBe("0.05"); // unchanged default
    await h.say(ALICE, "/set budget $2"); // the dollar sign is optional
    expect(s().totalGasBudgetEth).toBe("0.000666666667"); // rounded up so the cap is never below $2
    await h.say(ALICE, "/set budget 0.08eth"); // ETH when asked for explicitly
    expect(s().totalGasBudgetEth).toBe("0.08");
    await h.say(ALICE, "/set budget abc");
    expect(s().totalGasBudgetEth).toBe("0.08");
    await h.say(ALICE, "/set minminters 3");
    expect(s().minUniqueMinters).toBe(3);
    h.sent(ALICE);
    await h.say(ALICE, "/settings");
    expect(h.sent(ALICE).join()).toMatch(/Total gas budget: \$240\.00 \(0\.08 ETH\)/);
  });

  it("manages allow/deny lists and rejects bad addresses", async () => {
    const h = harness({ OPEN_REGISTRATION: "true" });
    await h.say(ALICE, "/start");
    const a = "0x00000000000000000000000000000000000000c1";
    await h.say(ALICE, `/allow ${a}`);
    await h.say(ALICE, "/allow 0x123");
    await h.say(ALICE, `/deny ${a}`);
    expect(h.hub.record(ALICE)!.settings.allowlist).toHaveLength(1);
    expect(h.hub.record(ALICE)!.settings.denylist).toHaveLength(1);
    await h.say(ALICE, `/unallow ${a}`);
    expect(h.hub.record(ALICE)!.settings.allowlist).toHaveLength(0);
  });

  it("exports keys only after confirmation and deletes the message", async () => {
    const h = harness({ OPEN_REGISTRATION: "true" });
    await h.say(ALICE, "/start");
    await h.say(ALICE, "/newwallets 1");
    h.sent(ALICE);
    await h.say(ALICE, "/export");
    const token = h.lastKeyboardToken();
    expect(h.sent(ALICE).join()).not.toMatch(/0x[0-9a-f]{64}/);
    await h.press(ALICE, `c:${token}`);
    await new Promise((r) => setTimeout(r, 30));
    const key = h.hub.exportKeys(ALICE)[0].key;
    expect(h.calls.some((c) => c.method === "sendMessage" && c.payload.text.includes(key))).toBe(true);
    expect(h.calls.some((c) => c.method === "deleteMessage")).toBe(true);

    const off = harness({ OPEN_REGISTRATION: "true", ALLOW_EXPORT: "false" });
    await off.say(ALICE, "/start");
    await off.say(ALICE, "/newwallets 1");
    off.sent(ALICE);
    await off.say(ALICE, "/export");
    expect(off.sent(ALICE).join()).toMatch(/disabled/);
  });

  it("banned users are silenced and keep their data; admin cannot be banned", async () => {
    const h = harness({ OPEN_REGISTRATION: "true" });
    await h.say(ADMIN, "/start");
    await h.say(ALICE, "/start");
    await h.say(ALICE, "/newwallets 1");
    await h.say(ADMIN, `/ban ${ALICE}`);
    h.sent(ALICE);
    await h.say(ALICE, "/wallets");
    await h.say(ALICE, "/start");
    expect(h.sent(ALICE)).toHaveLength(0);
    expect(h.hub.record(ALICE)!.wallets).toHaveLength(1);
    await h.say(ADMIN, `/ban ${ADMIN}`);
    expect(h.sent(ADMIN).join()).toMatch(/can't be banned/);
    await h.say(ADMIN, `/unban ${ALICE}`);
    await h.say(ALICE, "/wallets");
    expect(h.sent(ALICE).join()).toMatch(/w01/);
  });

  it("rate limits rapid commands per user", async () => {
    const h = harness({ OPEN_REGISTRATION: "true", COMMAND_GAP_MS: "10000" });
    await h.say(ALICE, "/start");
    h.sent(ALICE);
    await h.say(ALICE, "/settings");
    expect(h.sent(ALICE)).toHaveLength(0);
  });

  it("handles /mode, price settings, /tiers and /plan with nothing minted", async () => {
    const h = harness({ OPEN_REGISTRATION: "true" });
    await h.say(ALICE, "/start");
    h.sent(ALICE);
    await h.say(ALICE, "/mode hot");
    expect(h.hub.record(ALICE)!.settings.sweep).toBe(false);
    await h.say(ALICE, "/mode sweep");
    expect(h.hub.record(ALICE)!.settings.sweep).toBe(true);
    await h.say(ALICE, "/mode nonsense");
    expect(h.sent(ALICE).join()).toMatch(/Usage/);

    await h.say(ALICE, "/set ethprice 3000");
    await h.say(ALICE, "/set fee 5");
    await h.say(ALICE, "/set ethprice 0");
    expect(h.hub.record(ALICE)!.settings).toMatchObject({ ethUsd: 3000, feePct: 5 });

    await h.say(ALICE, "/tiers hold:15,25:10,12.5:25,5:50");
    expect(h.hub.record(ALICE)!.settings.tiers).toBe("hold:15,25:10,12.5:25,5:50");
    h.sent(ALICE);
    await h.say(ALICE, "/tiers hold:10,5:50");
    expect(h.sent(ALICE).join()).toMatch(/add up to 60%/);
    await h.say(ALICE, "/tiers default");
    expect(h.hub.record(ALICE)!.settings.tiers).toBeUndefined();

    await h.say(ALICE, "/plan");
    expect(h.sent(ALICE).join()).toMatch(/No NFTs yet/);
  });

  it("formats mint events for users", () => {
    const n = new Notifier({ sendMessage: vi.fn() }, [], "https://scan.example");
    const text = n.format({
      type: "round", collection: "0x00000000000000000000000000000000000000c1", dryRun: false,
      minted: 3, tokens: 3, failed: 1, wouldMint: 0, skipped: 0, gasWei: parseEther("0.0001"), txs: ["0x" + "ab".repeat(32) as `0x${string}`], note: "reverted <b>",
    })!;
    expect(text).toMatch(/Minted 3 NFTs/);
    expect(text).toContain("https://scan.example/tx/");
    expect(text).toContain("&lt;b&gt;"); // untrusted text is escaped
  });
});
