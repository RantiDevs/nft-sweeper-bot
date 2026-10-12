import { loadConfig } from "../config.js";
import { makeClients } from "../rpc.js";
import { State } from "../state.js";
import { loadAccounts, makeWallets } from "../wallets.js";

export function setup() {
  const cfg = loadConfig();
  const { chain, transport, publicClient } = makeClients(cfg);
  const wallets = makeWallets(loadAccounts(cfg), chain, transport);
  if (wallets.length === 0) throw new Error("No wallets configured (PRIVATE_KEYS, KEYS_FILE or MNEMONIC)");
  return { cfg, chain, transport, publicClient, wallets, state: new State(cfg.stateFile) };
}

/** `--yes` actually sends; without it the CLI only prints what it would do. */
export const confirmed = process.argv.includes("--yes");

export function run(main: () => Promise<void>): void {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
