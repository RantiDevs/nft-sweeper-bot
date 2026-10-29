import { getAddress, type Address, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { MintDetector, type MintObservation } from "../detector.js";
import { isNftContract } from "../erc165.js";
import { fmtWei } from "../money.js";
import { EthPriceOracle } from "../price.js";
import { makeClients } from "../rpc.js";
import { readTransfers } from "../market/sales.js";
import { sleep } from "../util.js";

// Looks at ONE collection's recent mints and shows how the bot would judge it. Read-only.
// Usage: npm run inspect -- 0xCollection [sampleSize]
async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => a.startsWith("0x"));
  if (!arg) throw new Error("Usage: npm run inspect -- 0xCollectionAddress [sampleSize]");
  const collection = getAddress(arg);
  const sample = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 60);
  const cfg = loadConfig(process.env, { requireWallets: false });
  const { publicClient } = makeClients(cfg);
  const px = await new EthPriceOracle({ fallback: process.env.ETH_USD ? Number(process.env.ETH_USD) : undefined }).get();

  const head = await publicClient.getBlockNumber();
  const from = head - BigInt(cfg.windowBlocks);
  console.log(`Collection ${collection}, blocks ${from}..${head} (${cfg.windowBlocks} blocks)`);
  console.log(`ERC-165 NFT: ${await isNftContract(publicClient, collection)}`);

  const mints = (await readTransfers(publicClient, collection, from, head)).filter((t) => t.from === "0x0000000000000000000000000000000000000000");
  console.log(`${mints.length} mint events in ${new Set(mints.map((m) => m.tx)).size} transactions`);

  // Spread the sample evenly over the window instead of taking only the newest.
  const txs = [...new Map(mints.map((m) => [m.tx, m])).values()];
  const step = Math.max(1, Math.floor(txs.length / sample));
  const picked = txs.filter((_, i) => i % step === 0).slice(0, sample);

  const detector = new MintDetector({ windowBlocks: cfg.windowBlocks, minUniqueMinters: 1, minMintTxs: 1 });
  let free = 0, paid = 0, failed = 0;
  const paidValues: bigint[] = [];
  const selectors = new Map<string, number>();
  const targets = new Map<string, number>();
  const minters = new Set<string>();
  for (const m of picked) {
    try {
      const tx = await publicClient.getTransaction({ hash: m.tx as Hex });
      if (tx.value > 0n) { paid++; paidValues.push(tx.value); } else free++;
      selectors.set(tx.input.slice(0, 10), (selectors.get(tx.input.slice(0, 10)) ?? 0) + 1);
      targets.set(tx.to ?? "(create)", (targets.get(tx.to ?? "(create)") ?? 0) + 1);
      minters.add(tx.from);
      if (tx.to && tx.blockNumber !== null) {
        const obs: MintObservation = { collection, txHash: tx.hash, blockNumber: tx.blockNumber, minter: getAddress(tx.from), target: getAddress(tx.to), input: tx.input, value: tx.value };
        detector.add(obs);
      }
    } catch {
      failed++;
    }
    await sleep(120);
  }
  console.log(`\nSampled ${picked.length} mint txs: ${free} free, ${paid} paid, ${failed} lookups failed, ${minters.size} different minter wallets`);
  if (paidValues.length) {
    const sorted = [...paidValues].sort((a, b) => (a < b ? -1 : 1));
    console.log(`Paid mints cost between ${fmtWei(sorted[0], px)} and ${fmtWei(sorted[sorted.length - 1], px)}`);
  }
  console.log("Mint functions called:", [...selectors].map(([s, n]) => `${s} x${n}`).join(", "));
  console.log("Contracts called:", [...targets].map(([t, n]) => `${t === collection ? "the collection itself" : t} x${n}`).join(", "));

  const hot = detector.hot({ minUniqueMinters: 1, minMintTxs: 1 });
  if (hot.length) console.log(`\nThe bot WOULD act on this: ${hot[0].uniqueMinters} wallets, ${hot[0].templates.length} usable mint pattern(s), best ${hot[0].templates[0].input.slice(0, 10)}`);
  else if (paid > 0) console.log(`\nThe bot would SKIP this collection: ${paid} of the sampled mints were paid, and one paid mint disqualifies the whole collection.`);
  else console.log("\nThe bot would skip this collection (no usable mint call among the sample).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
