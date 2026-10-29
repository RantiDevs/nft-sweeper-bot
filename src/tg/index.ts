import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import { assertChain, makeClients } from "../rpc.js";
import { startHealthServer, startSelfPing } from "../health.js";
import { Lease } from "../persist/lease.js";
import { SupabaseKV } from "../persist/supabase.js";
import { DataSync } from "../persist/sync.js";
import { log } from "../util.js";
import { loadTgConfig, usersFile } from "./config.js";
import { registerHandlers } from "./handlers.js";
import { Hub } from "./hub.js";
import { Notifier } from "./notify.js";
import { UserStore } from "./store.js";

async function main(): Promise<void> {
  const tg = loadTgConfig();

  // Where the data lives. On a host with a throwaway disk (Render's free tier) it must be mirrored to
  // Supabase, or every restart would erase all users and wallets.
  const kv = SupabaseKV.fromEnv();
  if (!kv && process.env.RENDER && process.env.ALLOW_EPHEMERAL !== "true") {
    throw new Error(
      "Running on Render without Supabase: this server's disk is wiped on every restart, so all wallets would be lost. " +
        "Set SUPABASE_URL and SUPABASE_SERVICE_KEY (see docs/DEPLOY_RENDER.md), or ALLOW_EPHEMERAL=true to accept the risk.",
    );
  }

  // Health endpoint first: Render wants a listening port, and the pinger needs something to call.
  let phase = "starting";
  let hubRef0: Hub | undefined;
  let sync: DataSync | undefined;
  const port = Number(process.env.PORT) || 0;
  const health = port
    ? await startHealthServer(port, () => ({
        phase,
        chain: tg.base.chainId,
        headBlock: hubRef0 ? Number(hubRef0.watcher.currentHead) : undefined,
        secondsSinceLastBlockScan: hubRef0 ? Math.round((Date.now() - hubRef0.watcher.lastOkAt) / 1000) : undefined,
        persistence: sync ? { enabled: true, ...sync.status() } : { enabled: false },
      }))
    : undefined;
  const stopSelfPing = process.env.RENDER_EXTERNAL_URL ? startSelfPing(process.env.RENDER_EXTERNAL_URL) : undefined;

  let lease: Lease | undefined;
  if (kv) {
    lease = new Lease(kv);
    await lease.acquire();
    lease.start((why) => {
      log(`stopping: ${why}`);
      process.exit(1);
    });
    sync = new DataSync(tg.dataDir, kv, { onTrouble: (t) => notifierRef?.admins(t) });
    const r = await sync.hydrate();
    log(`persistence: Supabase connected; restored ${r.downloaded} file(s) from it and saved ${r.uploaded} local file(s) to it`);
    sync.start();
  } else {
    log("persistence: Supabase not configured; data lives only on this machine's disk");
  }
  const { chain, transport, publicClient, watchClient } = makeClients(tg.base);
  await assertChain(publicClient, tg.base.chainId);
  if (watchClient !== publicClient) await assertChain(watchClient, tg.base.chainId);
  const store = new UserStore(usersFile(tg));

  const bot = new Bot(tg.botToken);
  // Telegram answers floods with 429 + retry_after; wait it out instead of dropping messages.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 4, maxDelaySeconds: 30 }));
  let hubRef: Hub | undefined;
  let notifierRef: Notifier | undefined;
  const notifier = new Notifier(bot.api, tg.adminIds, chain.blockExplorers?.default.url, () => hubRef?.price.peek());

  const hub = new Hub({
    publicClient,
    watchClient,
    chain,
    transport,
    tg,
    store,
    onUserEvent: (id, e) => notifier.event(id, e),
    onAdminAlert: (t) => notifier.admins(t),
  });
  hubRef = hub;
  hubRef0 = hub;
  notifierRef = notifier;
  hub.loadAll();
  registerHandlers(bot, { tg, hub, store, notifier });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("shutting down: waiting for in-flight mints (Ctrl-C again to force)");
    await bot.stop().catch(() => {});
    await hub.stop();
    await notifier.flush();
    // Last save to Supabase, then let go of the run lock so the next copy can start at once.
    if (sync && !(await sync.stop())) log("WARNING: the final save to Supabase did not complete");
    await lease?.release();
    stopSelfPing?.();
    health?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => log("unhandled rejection:", e));

  await bot.api.setMyCommands([
    { command: "start", description: "Welcome and setup" },
    { command: "status", description: "Mode, gas, wallets" },
    { command: "wallets", description: "Wallet balances" },
    { command: "newwallets", description: "Create wallets" },
    { command: "deposit", description: "Addresses to fund" },
    { command: "live", description: "Start real minting" },
    { command: "dry", description: "Simulate only" },
    { command: "settings", description: "View limits" },
    { command: "nfts", description: "Your minted NFTs" },
    { command: "collect", description: "Move NFTs to your vault" },
    { command: "help", description: "All commands" },
  ]).catch((e) => log("setMyCommands failed:", e));

  log(`Telegram bot starting | chain ${chain.id} | admins ${tg.adminIds.length} | users ${store.count()}`);
  phase = "running";
  void bot.start({ onStart: (me) => log(`Telegram bot @${me.username} online`) });
  notifier.admins("🟢 Sweeper bot started.");
  await hub.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
