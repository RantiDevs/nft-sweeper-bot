import "dotenv/config";
import { readFileSync } from "node:fs";
import { getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decrypt, parseMasterKey } from "../tg/crypto.js";
import { mintDrop } from "../mintdrop.js";

/**
 * npm run mintdrop -- --chain 8453 --nft 0x... [--qty 1] [--wallets 14] [--max-gas 0.0001] [--yes]
 * Mints a FREE public SeaDrop stage from your wallets. Dry run unless --yes. --max-gas is in the chain's native coin.
 */
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const chainId = Number(arg("chain"));
const nftRaw = arg("nft");
if (!chainId || !nftRaw) {
  console.error("usage: npm run mintdrop -- --chain <id> --nft 0x... [--qty N] [--wallets N] [--max-gas native] [--yes]");
  process.exit(1);
}
const mk = parseMasterKey(process.env.MASTER_KEY);
const users = JSON.parse(readFileSync(process.env.USERS_FILE ?? "data/users.json", "utf8")).users;
const uid = Object.keys(users)[0];
const u = users[uid];
let accounts = u.wallets.map((w: any) => privateKeyToAccount(decrypt(w.enc, mk, `${u.id ?? uid}:${w.address.toLowerCase()}`) as `0x${string}`));
if (arg("wallets")) accounts = accounts.slice(0, Number(arg("wallets")));

const r = await mintDrop({
  chainId,
  nft: getAddress(nftRaw),
  accounts,
  execute: process.argv.includes("--yes"),
  quantity: arg("qty") ? Number(arg("qty")) : 1,
  maxGasWei: arg("max-gas") ? parseEther(arg("max-gas")!) : undefined,
});
for (const x of r.results) console.log(`  ${x.address} ${x.status.padEnd(10)} ${x.note}${x.hash ? ` ${x.hash}` : ""}`);
console.log(`\n${r.summary}`);
