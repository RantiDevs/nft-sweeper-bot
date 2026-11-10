import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decrypt, parseMasterKey } from "../tg/crypto.js";
import { executeBridge, planBridge, relayChains, spreadNative } from "../bridge.js";

/**
 * npm run bridge -- --from 999 --to 99901 --amount 0.1 [--wallet 1] [--recipient 1] [--spread] [--yes]
 *
 *   --from/--to    chain ids        --amount  native coin of the FROM chain (e.g. 0.1 HYPE)
 *   --wallet N     which of your wallets pays (default 1; it must already hold the coin on --from)
 *   --recipient N  which of your wallets receives on --to (default 1)
 *   --spread       after arrival, split the arrived coin evenly across all your wallets on --to
 *   --yes          actually send. Without it, this only prints the quote and the checks.
 * Caps (env): BRIDGE_MAX_USD_PER_BRIDGE=15  BRIDGE_MAX_USD_PER_DAY=15  BRIDGE_MAX_FEE_PCT=8
 */
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

const from = Number(arg("from"));
const to = Number(arg("to"));
const amount = arg("amount");
if (!from || !to || !amount) {
  console.error("usage: npm run bridge -- --from <chainId> --to <chainId> --amount <native> [--wallet N] [--recipient N] [--spread] [--yes]");
  process.exit(1);
}

const mk = parseMasterKey(process.env.MASTER_KEY);
const users = JSON.parse(readFileSync(process.env.USERS_FILE ?? "data/users.json", "utf8")).users;
const uid = process.env.BRIDGE_USER ?? Object.keys(users)[0];
const u = users[uid];
const accounts = u.wallets.map((w: any) => privateKeyToAccount(decrypt(w.enc, mk, `${u.id ?? uid}:${w.address.toLowerCase()}`) as `0x${string}`));
const own: Address[] = accounts.map((a: any) => a.address);
const payerOf = (a: Address) => accounts[own.findIndex((x: Address) => x === a)];
const payer = accounts[Number(arg("wallet") ?? 1) - 1];
const recipient = own[Number(arg("recipient") ?? 1) - 1];
if (!payer || !recipient) throw new Error("wallet/recipient number out of range");

const caps = {
  maxUsdPerBridge: Number(process.env.BRIDGE_MAX_USD_PER_BRIDGE ?? 15),
  maxUsdPerDay: Number(process.env.BRIDGE_MAX_USD_PER_DAY ?? 15),
  maxFeePct: Number(process.env.BRIDGE_MAX_FEE_PCT ?? 8),
  maxFeeUsd: Number(process.env.BRIDGE_MAX_FEE_USD ?? 0.05),
};
const req = { fromChainId: from, toChainId: to, amountWei: parseEther(amount), sender: payer.address as Address, recipient, ownWallets: own, ...caps };

const chains = await relayChains();
const fc = chains.find((c) => c.id === from)!;
const tc = chains.find((c) => c.id === to)!;
console.log(`Bridge ${amount} ${fc.currency.symbol} on ${fc.name} -> ${tc.currency.symbol} on ${tc.name}`);
console.log(`  from ${payer.address}\n  to   ${recipient}`);

const plan = await planBridge(req);
console.log(`  checks passed. You send $${plan.amountUsd.toFixed(2)}, fee about $${plan.feeUsd.toFixed(2)} (${plan.feePct.toFixed(1)}%), you receive about ${plan.receiveEstimate} ${plan.receiveSymbol}${plan.timeEstimateSec ? `, ~${plan.timeEstimateSec}s` : ""}`);
console.log(`  contract ${plan.tx.to} (Relay's published depository for ${fc.name})`);

if (!flag("yes")) {
  console.log("\nDry run only. Add --yes to send.");
  process.exit(0);
}

const pubFrom = createPublicClient({ chain: defineChain({ id: from, name: fc.name, nativeCurrency: { name: fc.currency.symbol, symbol: fc.currency.symbol, decimals: 18 }, rpcUrls: { default: { http: [fc.httpRpcUrl] } } }), transport: http(fc.httpRpcUrl) });
const bal = await pubFrom.getBalance({ address: payer.address });
if (bal < req.amountWei) throw new Error(`wallet ${payer.address} has only ${formatEther(bal)} ${fc.currency.symbol} on ${fc.name}`);

const { hash, status } = await executeBridge(req, plan, payer);
console.log(`  sent ${hash}; Relay status: ${status}`);
if (status !== "success") process.exit(status === "pending" ? 2 : 1);

if (flag("spread")) {
  const sent = await spreadNative(to, payerOf(recipient), own, tc.httpRpcUrl);
  for (const x of sent) console.log(`    ${x.to} <- ${formatEther(x.wei)} ${tc.currency.symbol} (${x.hash})`);
}
