import { formatEther, getAddress, parseEther, type Address, type Hex } from "viem";
import { chainFor } from "../chain.js";
import { fmtUsd, fmtWei } from "../money.js";
import { EthPriceOracle } from "../price.js";
import { calldataFor, checkPlan, prepare, settle, waitAndFire, type SnipeSettings, type SnipeTarget } from "../snipe.js";
import { FeeOracle } from "../fees.js";
import { errMsg } from "../util.js";
import { confirmed, run, setup } from "./common.js";

// Pre-signed, near-instant mint for limited first-come-first-served drops. Free mints only.
//
//   npm run snipe -- --copy-tx 0xHashOfAnyMintTx            (copy a working mint call)
//   npm run snipe -- --to 0xContract --data 0x1249c58b       (or give the call yourself)
//   add  -- --yes   to arm and fire; without it you only get the plan and its cost.
//
// Options: --wallets N  --gas N  --poll-ms 50  --not-before 2026-10-14T18:00:00Z
//          --max-wait-min 60  --tip-gwei 0  --value 0.01 --allow-paid
// In --data, {wallet} is replaced by each wallet's address (for mint(address to, ...) calls).

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

run(async () => {
  const { cfg, publicClient, wallets: all, state } = setup();
  const chain = chainFor(cfg.chainId);
  const urls = cfg.rpcUrls.length ? cfg.rpcUrls : chain.rpcUrls.default.http.slice();
  if (urls.length === 0) throw new Error("No RPC URL: set RPC_URLS");

  const count = Number(arg("wallets") ?? all.length);
  const wallets = all.slice(0, Math.max(1, Math.min(count, all.length)));

  // What to send.
  let target: SnipeTarget;
  let gas = arg("gas") ? BigInt(arg("gas")!) : undefined;
  const copy = arg("copy-tx");
  if (copy) {
    const tx = await publicClient.getTransaction({ hash: copy as Hex });
    if (!tx.to) throw new Error("that transaction creates a contract, not a mint");
    target = { to: getAddress(tx.to), data: tx.input, copiedFrom: getAddress(tx.from), value: tx.value };
    if (gas === undefined) {
      const r = await publicClient.getTransactionReceipt({ hash: copy as Hex });
      gas = (r.gasUsed * 13n) / 10n;
    }
    console.log(`Copying ${copy}: calls ${target.to} with ${tx.input.slice(0, 10)}…`);
  } else {
    const to = arg("to");
    const data = arg("data");
    if (!to || !data) throw new Error("Give --copy-tx 0xHash, or both --to 0xContract and --data 0xCalldata");
    target = { to: getAddress(to), data: data as Hex, value: parseEther(arg("value") ?? "0") };
  }
  gas ??= 250_000n;

  // Fees: generous, so the transaction cannot be stranded by a base-fee tick between signing and sending.
  const oracle = new FeeOracle(publicClient, { multiplier: Math.max(cfg.baseFeeMultiplier, 2.5), minPriorityFeeWei: BigInt(Math.round(Number(arg("tip-gwei") ?? 0) * 1e9)) });
  const fees = await oracle.get();
  const settings: SnipeSettings = {
    gasLimit: gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    chainId: cfg.chainId,
    maxGasCostWei: cfg.maxGasCostWei,
    totalGasBudgetWei: cfg.totalGasBudgetWei,
    allowPaid: flag("allow-paid"),
  };
  const perWallet = checkPlan(target, settings, wallets.length);
  const px = await new EthPriceOracle({ fallback: process.env.ETH_USD ? Number(process.env.ETH_USD) : undefined }).get();

  console.log(`\nPlan: ${wallets.length} wallet(s) -> ${target.to}`);
  console.log(`  call        ${target.data.slice(0, 66)}${target.data.length > 66 ? "…" : ""}`);
  console.log(`  value       ${target.value === 0n ? "0 (free mint)" : fmtWei(target.value, px)}`);
  console.log(`  gas limit   ${gas} per transaction`);
  console.log(`  worst case  ${fmtWei(perWallet, px)} per wallet, ${fmtWei(perWallet * BigInt(wallets.length), px)} in total (you pay the actual, usually far less)`);
  console.log(`  endpoints   ${urls.length} (${urls.map((u) => new URL(u).host).join(", ")})`);
  const notBefore = arg("not-before") ? Date.parse(arg("not-before")!) : undefined;
  if (notBefore !== undefined && Number.isNaN(notBefore)) throw new Error("--not-before must be a date like 2026-10-14T18:00:00Z");

  const probe = wallets[0].account.address;
  const isOpen = () =>
    publicClient
      .call({ account: probe, to: target.to, data: calldataFor(target, probe), value: target.value })
      .then(() => true, () => false);

  const openNow = await isOpen();
  console.log(`  open now?   ${openNow ? "YES: it would fire immediately" : "no (the free check reverts), waiting for it to open"}`);
  if (!confirmed) {
    console.log("\nNothing was sent. Re-run with `-- --yes` to sign everything and arm it.");
    return;
  }

  console.log("\nSigning…");
  const prepared = await prepare(publicClient, wallets, target, settings);
  console.log(`Armed: ${prepared.length} signed transaction(s). Checking every ${arg("poll-ms") ?? 50} ms. Ctrl-C to cancel.`);
  const result = await waitAndFire(prepared, {
    urls,
    pollMs: Number(arg("poll-ms") ?? 50),
    notBefore,
    maxWaitMs: Number(arg("max-wait-min") ?? 60) * 60_000,
    isOpen,
    onTick: (n) => {
      if (n % 400 === 0) console.log(`  …still waiting (${n} checks)`);
    },
  });

  if (!result.opened) {
    console.log("Gave up: the mint never opened within the wait time. Nothing was sent.");
    return;
  }
  console.log(`\nOpen detected, transactions sent ${result.sentAt! - result.openedAt!} ms later (after ${result.checks} checks).`);
  result.errors.slice(0, 5).forEach((e) => console.log("  send error:", e));
  console.log("Waiting for results…");
  const outcome = await settle(publicClient, prepared, result.hashes, state);
  let tokens = 0;
  let gasWei = 0n;
  for (const o of outcome) {
    tokens += o.tokens;
    gasWei += o.gasWei;
    console.log(`  ${o.label}: ${o.ok ? `minted ${o.tokens}` : `no NFT${o.note ? ` (${o.note})` : ""}`}  gas ${fmtWei(o.gasWei, px)}`);
  }
  console.log(`\n${tokens} NFT(s) minted, gas paid ${fmtWei(gasWei, px)}${px ? ` (ETH = ${fmtUsd(px)})` : ""}. Run \`npm run plan\` to see what they are worth.`);
  void formatEther;
});

process.on("unhandledRejection", (e) => console.error(errMsg(e)));
