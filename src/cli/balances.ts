import { formatEther } from "viem";
import { mapLimit } from "../util.js";
import { run, setup } from "./common.js";

run(async () => {
  const { publicClient, wallets, state } = setup();
  const rows = await mapLimit(wallets, 20, async (w) => {
    const a = w.account.address;
    const [bal, nonce] = await Promise.all([
      publicClient.getBalance({ address: a }),
      publicClient.getTransactionCount({ address: a }),
    ]);
    return { w, bal, nonce, nfts: state.holdings(a).length };
  });
  let total = 0n;
  for (const r of rows) {
    total += r.bal;
    console.log(`${r.w.label} ${r.w.account.address}  ${formatEther(r.bal).padEnd(22)} ETH  txs ${String(r.nonce).padEnd(5)} uncollected NFTs ${r.nfts}`);
  }
  console.log(`\n${wallets.length} wallets, ${formatEther(total)} ETH total, gas spent by bot ${formatEther(state.gasSpent())} ETH`);
});
