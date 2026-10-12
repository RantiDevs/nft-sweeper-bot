import { createWalletClient, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NonceManager } from "../nonce.js";
import { mapLimit } from "../util.js";
import { confirmed, run, setup } from "./common.js";

// Tops every bot wallet up to FUND_TARGET_ETH from FUNDER_PRIVATE_KEY.
run(async () => {
  const { cfg, chain, transport, publicClient, wallets } = setup();
  if (!cfg.funderPrivateKey) throw new Error("Set FUNDER_PRIVATE_KEY");
  const funder = privateKeyToAccount(cfg.funderPrivateKey);
  const client = createWalletClient({ account: funder, chain, transport });

  const needs = (
    await mapLimit(wallets, 20, async (w) => ({
      w,
      short: cfg.fundTargetWei - (await publicClient.getBalance({ address: w.account.address })),
    }))
  ).filter((n) => n.short > 0n);
  const total = needs.reduce((a, n) => a + n.short, 0n);
  const have = await publicClient.getBalance({ address: funder.address });
  console.log(`Funder ${funder.address} has ${formatEther(have)} ETH; ${needs.length} wallet(s) need ${formatEther(total)} ETH to reach ${formatEther(cfg.fundTargetWei)}`);
  if (needs.length === 0) return;
  if (have < total) throw new Error("Funder balance too low for all top-ups (plus gas)");
  if (!confirmed) return console.log("Dry run. Re-run with `-- --yes` to send.");

  const nonces = new NonceManager(publicClient);
  const hashes: `0x${string}`[] = [];
  for (const n of needs) {
    const hash = await nonces.use(funder.address, (nonce) =>
      client.sendTransaction({ account: funder, chain, to: n.w.account.address, value: n.short, nonce }),
    );
    console.log(`${n.w.label} +${formatEther(n.short)} ETH ${hash}`);
    hashes.push(hash);
  }
  await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })));
  console.log("All top-ups confirmed.");
});
