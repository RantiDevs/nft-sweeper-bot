import { formatEther, getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverEth } from "../ops.js";
import { confirmed, run, setup } from "./common.js";

// Sends each bot wallet's leftover ETH back to the funder, or to the address
// given as the first argument.
run(async () => {
  const { cfg, publicClient, wallets } = setup();
  const arg = process.argv.slice(2).find((a) => a.startsWith("0x"));
  const to: Address | undefined = arg
    ? getAddress(arg)
    : cfg.funderPrivateKey && privateKeyToAccount(cfg.funderPrivateKey).address;
  if (!to) throw new Error("Pass a destination address or set FUNDER_PRIVATE_KEY");
  const r = await recoverEth({ publicClient, wallets, to, send: confirmed });
  r.lines.forEach((l) => console.log(l));
  console.log(`${confirmed ? "Sent" : "Would send"} ${formatEther(r.total)} ETH in total to ${to}`);
  if (!confirmed) console.log("Dry run. Re-run with `-- --yes` to send.");
});
