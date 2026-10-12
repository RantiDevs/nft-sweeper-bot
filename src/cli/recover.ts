import { formatEther, getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mapLimit } from "../util.js";
import { confirmed, run, setup } from "./common.js";

// Sends each bot wallet's leftover ETH (minus the transfer fee) back to the
// funder, or to the address given as the first argument.
run(async () => {
  const { cfg, publicClient, wallets } = setup();
  const arg = process.argv.slice(2).find((a) => a.startsWith("0x"));
  const to: Address | undefined = arg
    ? getAddress(arg)
    : cfg.funderPrivateKey && privateKeyToAccount(cfg.funderPrivateKey).address;
  if (!to) throw new Error("Pass a destination address or set FUNDER_PRIVATE_KEY");

  const fees = await publicClient.estimateFeesPerGas();
  const fee = 21_000n * fees.maxFeePerGas * 2n; // 2x margin so the tx never underfunds
  await mapLimit(wallets, 10, async (w) => {
    const bal = await publicClient.getBalance({ address: w.account.address });
    const value = bal - fee;
    if (value <= 0n) return;
    if (!confirmed) return console.log(`${w.label} would send ${formatEther(value)} ETH to ${to}`);
    const hash = await w.client.sendTransaction({
      account: w.account, chain: w.client.chain, to, value, gas: 21_000n,
      maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`${w.label} sent ${formatEther(value)} ETH ${hash}`);
  });
  if (!confirmed) console.log("Dry run. Re-run with `-- --yes` to send.");
});
