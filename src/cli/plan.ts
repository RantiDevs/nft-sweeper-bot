import { writeFileSync } from "node:fs";
import { OpenSeaClient } from "../market/opensea.js";
import { EthPriceOracle } from "../price.js";
import { analyzeHoldings, heldTokens } from "../rarity/analyze.js";
import { loadPlanConfig } from "../rarity/config.js";
import { planCsv } from "../rarity/plan.js";
import { formatPlan } from "../rarity/report.js";
import { run, setup } from "./common.js";

// Ranks every NFT the bot minted by trait rarity and writes a sell/hold plan.
// Usage: npm run plan [-- out.csv]
run(async () => {
  const { publicClient, wallets, state } = setup();
  const pc = loadPlanConfig(process.env, { cacheDir: ".cache/metadata" });
  const ethUsd = await new EthPriceOracle({ fallback: pc.ethUsd }).get();
  if (ethUsd === undefined) console.log("ETH price unavailable (feeds unreachable and ETH_USD not set): dollar figures will be missing.");
  const held = heldTokens(wallets, state);
  if (held.length === 0) return console.log("No NFTs recorded in state yet.");
  console.log(`Analysing ${held.length} NFT(s)…`);
  const plan = await analyzeHoldings(
    publicClient,
    held,
    { sample: pc.sample, concurrency: pc.concurrency, cacheDir: pc.cacheDir, gateways: pc.gateways },
    { tiers: pc.tiers, feePct: pc.feePct, ethUsd, gasSpentWei: state.gasSpent(), mode: pc.mode, valuation: pc.valuation },
    (done, total) => console.log(`  collection ${done}/${total}`),
    { opensea: new OpenSeaClient({ apiKey: pc.openseaKey, chainSlug: pc.openseaChain }), weth: pc.weth, valuation: pc.valuation },
  );
  const out = process.argv.slice(2).find((a) => a.endsWith(".csv")) ?? "plan.csv";
  writeFileSync(out, planCsv(plan.rows));
  console.log(formatPlan(plan, { html: false }));
  console.log(`\nFull list (rarest first): ${out}`);
});
