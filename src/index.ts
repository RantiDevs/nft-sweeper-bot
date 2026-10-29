import { formatEther } from "viem";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { assertChain, makeClients } from "./rpc.js";
import { State } from "./state.js";
import { log, mapLimit } from "./util.js";
import { loadAccounts, makeWallets } from "./wallets.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { chain, transport, publicClient, watchClient } = makeClients(cfg);
  const wallets = makeWallets(loadAccounts(cfg), chain, transport);
  const state = new State(cfg.stateFile);
  await assertChain(publicClient, cfg.chainId);
  if (watchClient !== publicClient) await assertChain(watchClient, cfg.chainId);

  log(
    `Robinhood Chain free-mint sweeper | chain ${chain.id} | rpc endpoints ${Math.max(1, cfg.rpcUrls.length)} | ` +
      `wallets ${wallets.length} (concurrency ${cfg.walletConcurrency}) | ` +
      `${cfg.dryRun ? "DRY RUN (set DRY_RUN=false to send txs)" : "LIVE"}`,
  );

  if (wallets.length) {
    const balances = await mapLimit(wallets, 20, (w) =>
      publicClient.getBalance({ address: w.account.address }).catch(() => -1n),
    );
    const low = wallets.filter((_, i) => balances[i] >= 0n && balances[i] < cfg.maxGasCostWei);
    const total = balances.reduce((a, b) => (b > 0n ? a + b : a), 0n);
    log(`wallet gas: total ${formatEther(total)} ETH, ${low.length} wallet(s) below one max-cost tx` +
      (low.length ? ` (${low.map((w) => w.label).join(",")}) — run \`npm run fund\`` : ""));
  }

  const engine = new Engine(publicClient, wallets, cfg, state, watchClient);
  let signals = 0;
  const shutdown = async () => {
    if (++signals > 1) process.exit(1);
    log("shutting down: waiting for in-flight mints (Ctrl-C again to force)");
    engine.stop();
    await engine.drain();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => log("unhandled rejection:", e));

  await engine.run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
