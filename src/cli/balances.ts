import { fmtWei } from "../money.js";
import { EthPriceOracle } from "../price.js";
import { mapLimit } from "../util.js";
import { run, setup } from "./common.js";

run(async () => {
  const { publicClient, wallets, state } = setup();
  const px = await new EthPriceOracle({ fallback: process.env.ETH_USD ? Number(process.env.ETH_USD) : undefined }).get();
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
    console.log(`${r.w.label} ${r.w.account.address}  ${fmtWei(r.bal, px).padEnd(30)} txs ${String(r.nonce).padEnd(5)} uncollected NFTs ${r.nfts}`);
  }
  console.log(`\n${wallets.length} wallets, ${fmtWei(total, px)} total, gas spent by bot ${fmtWei(state.gasSpent(), px)}`);
  if (px !== undefined) console.log(`(ETH = $${px.toLocaleString("en-US", { maximumFractionDigits: 2 })})`);
});
