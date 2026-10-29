import { collectNfts } from "../ops.js";
import { confirmed, run, setup } from "./common.js";

// Moves every NFT the bot minted (tracked in state.json) into VAULT_ADDRESS.
run(async () => {
  const { cfg, publicClient, wallets, state } = setup();
  if (!cfg.vaultAddress) throw new Error("Set VAULT_ADDRESS");
  const r = await collectNfts({ publicClient, wallets, state, vault: cfg.vaultAddress, send: confirmed });
  r.lines.forEach((l) => console.log(l));
  if (!confirmed) console.log("Dry run. Re-run with `-- --yes` to send.");
});
