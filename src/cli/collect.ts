import { parseAbi } from "viem";
import { mapLimit } from "../util.js";
import { confirmed, run, setup } from "./common.js";

const erc721 = parseAbi(["function safeTransferFrom(address from, address to, uint256 tokenId)"]);
const erc1155 = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
]);

// Moves every NFT the bot minted (tracked in state.json) into VAULT_ADDRESS.
run(async () => {
  const { cfg, publicClient, wallets, state } = setup();
  const vault = cfg.vaultAddress;
  if (!vault) throw new Error("Set VAULT_ADDRESS");

  await mapLimit(wallets, 10, async (w) => {
    const from = w.account.address;
    for (const h of state.holdings(from)) {
      const id = BigInt(h.tokenId);
      const desc = `${w.label} ${h.collection} #${h.tokenId}${h.standard === "erc1155" ? ` x${h.amount}` : ""}`;
      if (!confirmed) {
        console.log(`would move ${desc} -> ${vault}`);
        continue;
      }
      try {
        const hash =
          h.standard === "erc721"
            ? await w.client.writeContract({
                account: w.account, chain: w.client.chain, address: h.collection, abi: erc721,
                functionName: "safeTransferFrom", args: [from, vault, id],
              })
            : await w.client.writeContract({
                account: w.account, chain: w.client.chain, address: h.collection, abi: erc1155,
                functionName: "safeTransferFrom", args: [from, vault, id, BigInt(h.amount), "0x"],
              });
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status === "success") state.removeHolding(from, h);
        console.log(`${r.status === "success" ? "moved" : "REVERTED"} ${desc} ${hash}`);
      } catch (e) {
        console.log(`FAILED ${desc}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    }
  });
  if (!confirmed) console.log("Dry run. Re-run with `-- --yes` to send.");
});
